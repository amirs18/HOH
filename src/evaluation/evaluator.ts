import { randomUUID } from 'node:crypto';
import { mkdirSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { acceptance, hash } from '../core/policy.js';
import type { Config, Evaluation, CheckResult, Plan } from '../core/schemas.js';
import type { AgentRunner, AgentJobResult } from '../agents/runner.js';
import type { AttemptRecord } from '../infra/database.js';
import { Worktrees, git } from '../infra/worktrees.js';
import { Isolation } from '../infra/isolation.js';
import type { ProcessTracker } from '../infra/process.js';
import { Artifacts, treeHash } from './artifacts.js';
import { commandCheck } from './command-check.js';
import { review } from './reviewer.js';

export class Evaluator {
  constructor(private worktrees: Worktrees, private isolation: Isolation, private runner: AgentRunner, private tracker?: ProcessTracker) {}
  async evaluate(input: {
    attempt: AttemptRecord; config: Config; plan: Plan; spec: string; verifierHash: string; requirementIds: string[];
    signal: AbortSignal; secrets: string[]; onUsage?: (result: AgentJobResult) => void;
  }): Promise<Evaluation> {
    const { attempt, config, plan, spec, signal } = input;
    const root = join(this.worktrees.repo, '.hoh'), runRoot = join(root, 'runs', attempt.runId);
    const artifacts = new Artifacts(join(runRoot, 'artifacts', attempt.id), input.secrets, config.maxLogBytes);
    const verifier = join(runRoot, 'evaluation');
    const candidate = await this.worktrees.create(attempt.runId, `eval-${attempt.id}`, attempt.candidateSha!);
    const checks: CheckResult[] = [], started = new Date().toISOString();
    const gate = (id: string, status: CheckResult['status'], summary: string, mandatory = true) =>
      checks.push({ id, status, summary, mandatory, requirementIds: [], durationMs: 0, evidencePaths: [] });
    gate('isolation', this.isolation.trusted ? 'PASS' : 'ERROR', this.isolation.reason);
    let violations: string[];
    try {
      violations = await this.worktrees.integrity(attempt.parentSha, attempt.candidateSha!, config.protectedPaths);
      this.worktrees.assertSafeFiles(candidate);
      if (treeHash(verifier) !== input.verifierHash) violations.push('Trusted verification assets changed');
    } catch (e) { violations = [(e as Error).message]; }
    const diff = await git(this.worktrees.repo, ['diff', '--no-ext-diff', '--no-textconv', attempt.parentSha, attempt.candidateSha!]);
    const diffPath = artifacts.write('candidate.diff', diff);
    gate('integrity', violations.length ? 'FAIL' : 'PASS', violations.length ? violations.join('; ') : 'Protected paths and verifier hash unchanged');
    for (const kind of ['build', 'typecheck', 'lint'] as const)
      if (!config.evaluators.some(c => c.kind === kind)) gate(kind, 'NOT_CONFIGURED', `${kind} is not configured`, false);
    gate('acceptance-suite', config.evaluators.some(e => e.kind === 'acceptance' && e.mandatory) ? 'PASS' : 'NOT_CONFIGURED', 'Mandatory controller-owned acceptance suite required');
    gate('regression-suite', config.evaluators.some(e => e.kind === 'regression' && e.mandatory) ? 'PASS' : 'NOT_CONFIGURED', 'Mandatory regression suite required on every revision');
    if (!violations.length && this.isolation.trusted) {
      for (const command of config.evaluators) {
        if (command.kind === 'acceptance' && command.requirementIds.length && !command.requirementIds.some(id => input.requirementIds.includes(id))) {
          checks.push({ id: command.id, requirementIds: command.requirementIds, mandatory: false, status: 'NOT_CONFIGURED',
            durationMs: 0, summary: 'Deferred until the corresponding vertical slice; required by the release gate', evidencePaths: [] });
          continue;
        }
        signal.throwIfAborted();
        checks.push(await commandCheck(command, { candidate, verifier, scratch: join(runRoot, 'check-scratch', attempt.id),
          artifacts, isolation: this.isolation, config, signal, tracker: this.tracker }));
      }
      if (treeHash(verifier) !== input.verifierHash) gate('verifier-integrity', 'FAIL', 'Verifier mutated during execution');
      const dirty = await git(candidate, ['status', '--porcelain', '--untracked-files=all']);
      if (dirty) gate('frozen-revision', 'FAIL', `Candidate changed during verification: ${dirty}`);
    } else for (const command of config.evaluators) gate(command.id, 'ERROR', 'Skipped because integrity/isolation failed', command.mandatory);
    let findings: Evaluation['findings'] = [];
    const deterministicPass = checks.filter(c => c.mandatory).every(c => c.status === 'PASS');
    if (config.reviewRequired && deterministicPass) {
      const reviewCwd = join(runRoot, 'review', attempt.id); mkdirSync(reviewCwd, { recursive: true });
      mkdirSync(join(reviewCwd, 'candidate'), { recursive: true });
      // Supply only frozen source + public evidence, with no shared .git or protected tests.
      for (const name of readdirSync(candidate)) {
        if (name === '.git' || config.protectedPaths.some(p => p === name)) continue;
        cpSync(join(candidate, name), join(reviewCwd, 'candidate', name), { recursive: true });
      }
      cpSync(artifacts.root, join(reviewCwd, 'evidence'), { recursive: true });
      try {
        let reviewOutput = 0;
        findings = await review(this.runner, { runId: attempt.runId, taskId: attempt.taskId, role: 'reviewer', cwd: reviewCwd,
          instructions: `Review only implemented requirements ${JSON.stringify(input.requirementIds)} and regressions. Future slices are pending. Original specification:\n${spec}\nContract: ${JSON.stringify(plan.contract)}\nDiff: ${diff.slice(0, config.maxLogBytes)}\nChecks: ${JSON.stringify(checks)}\nEvidence is in evidence/; list paths relative to it.`,
          contextFiles: [join(reviewCwd, 'evidence')], readOnly: true, timeoutMs: config.timeoutMs }, config, signal,
          join(reviewCwd, 'evidence'), result => {
            artifacts.write(`review-${++reviewOutput}.log`, result.output); input.onUsage?.(result);
          });
        if (findings.some(f => f.requirementIds.some(id => !plan.contract.requirements.some(r => r.id === id))))
          throw new Error('REVIEW_UNKNOWN_REQUIREMENT');
        findings = findings.map(f => ({ ...f, description: artifacts.sanitize(f.description),
          reproduction: f.reproduction && artifacts.sanitize(f.reproduction), proposedFix: f.proposedFix && artifacts.sanitize(f.proposedFix) }));
        gate('review', 'PASS', `${findings.length} structured findings`);
      } catch (e) { gate('review', 'ERROR', artifacts.sanitize((e as Error).message)); }
    } else if (config.reviewRequired) gate('review', 'ERROR', 'Review deferred until mechanical gates pass');
    const reasons = acceptance(checks, findings, input.requirementIds, plan, config);
    const e: Evaluation = { id: randomUUID(), attemptId: attempt.id, candidateSha: attempt.candidateSha!,
      contractHash: hash(plan.contract), evaluationConfigHash: hash({ config, verifierHash: input.verifierHash }),
      createdAt: started, finishedAt: new Date().toISOString(), checks, findings,
      decision: reasons.length ? 'REJECT' : 'ACCEPT', summary: reasons.length ? reasons.join('; ') : 'All mandatory gates passed',
      evidencePaths: [diffPath, ...checks.flatMap(c => c.evidencePaths), ...findings.flatMap(f => f.evidencePaths)] };
    e.evidencePaths.push(join(artifacts.root, 'evaluation.json'));
    artifacts.write('evaluation.json', e); return e;
  }
}
