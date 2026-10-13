import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigSchema, type Plan, type Config } from '../../src/core/schemas.js';
import { git } from '../../src/infra/worktrees.js';
import type { AgentJob, AgentJobResult, AgentRunner } from '../../src/agents/runner.js';
import { hash } from '../../src/core/policy.js';
export const requirement = { id: 'R1', statement: 'Add operands correctly', priority: 'critical' as const,
  acceptanceCriteria: ['Sum positive, negative, and zero operands; preserve multiplication'], verificationIds: ['acceptance'], dependencies: [] };
export const fixtureConfig = (changes: Record<string, unknown> = {}): Config => ConfigSchema.parse({
  allowSnapshotCommit: true, planApproval: 'configured-requirements', requirements: [requirement], timeoutMs: 5000,
  allowlistedExecutables: [process.execPath], evaluators: [
    { id: 'acceptance', kind: 'acceptance', executable: process.execPath, args: ['{evaluation}/acceptance.mjs'], requirementIds: ['R1'] },
    { id: 'regression', kind: 'regression', executable: process.execPath, args: ['{evaluation}/regression.mjs'] },
  ], ...changes,
});
export async function createFixture(changes: Record<string, unknown> = {}): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'hoh-test-'));
  cpSync(resolve('test/fixtures/defective-app'), repo, { recursive: true });
  writeFileSync(join(repo, '.gitignore'), '.hoh/\n');
  await git(repo, ['init', '-b', 'main']); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'Defective baseline']);
  mkdirSync(join(repo, '.hoh'), { recursive: true });
  cpSync(resolve('test/fixtures/evaluation'), join(repo, '.hoh/evaluation'), { recursive: true });
  writeFileSync(join(repo, '.hoh/config.json'), JSON.stringify(fixtureConfig(changes), null, 2)); return repo;
}
export function fixturePlan(spec: string, config: Config): Plan {
  return { contract: { schemaVersion: 1, sourceSpecHash: hash(spec), productGoal: 'Arithmetic API', constraints: ['Preserve multiplication'],
    requirements: config.requirements ?? [requirement], unresolvedDecisions: [] }, tasks: [{ id: 'T1', title: 'Fix addition', requirementIds: ['R1'],
      scope: 'Implement correct addition', dependencies: [], objectiveChecks: ['acceptance', 'regression'], exitCriteria: ['Acceptance and regression pass'] }] };
}
export class FakeRunner implements AgentRunner {
  calls: AgentJob[] = [];
  builds = 0; reviews = 0; diagnoses = 0;
  constructor(private repo: string, private behavior: (job: AgentJob, attempt: number) => Promise<void> | void = (job, n) => {
    writeFileSync(join(job.cwd, 'app.mjs'), `export function add(a,b){return ${n === 1 ? '42' : 'a+b'};}\nexport function multiply(a,b){return a*b;}\n`);
  }, private reviewBehavior?: (job: AgentJob, n: number) => unknown) {}
  async execute(job: AgentJob, { signal }: { signal: AbortSignal }): Promise<AgentJobResult> {
    signal.throwIfAborted(); this.calls.push(job);
    let structured: unknown;
    if (job.role === 'planner') structured = fixturePlan(readFileSync(join(this.repo, 'SPEC.md'), 'utf8'), fixtureConfig());
    if (job.role === 'builder') await this.behavior(job, ++this.builds);
    if (job.role === 'reviewer') structured = this.reviewBehavior?.(job, ++this.reviews) ?? { findings: [] };
    if (job.role === 'diagnostician') { this.diagnoses++; structured = { hypothesis: 'Addition is still incorrect', strategy: 'Use a+b and preserve multiplication' }; }
    return { exitCode: 0, output: structured ? JSON.stringify(structured) : 'done', structured, artifacts: [] };
  }
}
