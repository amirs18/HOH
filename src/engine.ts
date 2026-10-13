import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigSchema, HeaderSchema, MeasurementSchema, DecisionSchema, hash, type Header, type Checkpoint, type Decision, type Measurement } from './model.js';
import { Files, git, inside, readJson, writeJson, treeHash, killGroup, birthIdentity } from './io.js';
import { measure } from './measurement.js';
import { decide } from './policy.js';
import { z } from 'zod';

export type Notes = { description: string; hypothesis?: string; learned?: string; nextFocus?: string };
export class HoH {
  readonly repo: string;
  readonly files: Files;
  private abort?: AbortController;
  private running?: Promise<Measurement>;
  constructor(repo: string) { this.repo = realpathSync(repo); this.files = new Files(this.repo); }
  bestRef(id: string): string { return `refs/hoh/${id}/best`; }
  async start(specPath: string): Promise<Checkpoint> {
    return this.files.locked(async () => {
      if (this.files.current() && ['RUNNING', 'PAUSED', 'BLOCKED'].includes(this.files.checkpoint().state)) throw new Error('ACTIVE_RUN_EXISTS');
      const config = readJson(join(this.files.root, 'config.json'), ConfigSchema);
      const specFile = realpathSync(resolve(this.repo, specPath));
      if (!inside(this.repo, specFile) || specFile.startsWith(this.files.root + '/')) throw new Error('SPEC_MUST_BE_IN_PROJECT');
      const spec = readFileSync(specFile, 'utf8'); if (!spec.trim() || spec.length > 1000000) throw new Error('INVALID_SPEC');
      if (realpathSync(await git(this.repo, ['rev-parse', '--show-toplevel'])) !== this.repo) throw new Error('PROJECT_ROOT_REQUIRED');
      if (await git(this.repo, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':!.hoh'])) throw new Error('DIRTY_BASELINE');
      if (await git(this.repo, ['config', '--get-regexp', '^filter\\.']).catch(() => '')) throw new Error('GIT_FILTERS_UNSUPPORTED');
      const baselineSha = await git(this.repo, ['rev-parse', 'HEAD^{commit}']);
      const tree = await git(this.repo, ['ls-tree', '-r', baselineSha]); if (/^(120000|160000) /m.test(tree)) throw new Error('SYMLINKS_SUBMODULES_UNSUPPORTED');
      const tracked = (await git(this.repo, ['ls-tree', '-r', '--name-only', '-z', baselineSha])).split('\0').filter(Boolean);
      for (const file of tracked) {
        if (/^(\.hoh|\.git|\.pi|\.aws|\.ssh)(\/|$)/.test(file) || /(^|\/)\.(env(?:\.[^/]*)?|netrc|npmrc)$/.test(file)) throw new Error('TRACKED_SECRET_OR_STATE_PATH');
        if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(readFileSync(join(this.repo, file), 'utf8'))) throw new Error('TRACKED_PRIVATE_KEY');
      }
      if (config.scope.some(path => this.scoped(config, relative(this.repo, specFile), path))) throw new Error('SPEC_CANNOT_BE_IN_SCOPE');
      const assets = join(this.files.root, 'evaluation');
      if (!existsSync(assets) || !readdirSync(assets).length) throw new Error('TRUSTED_EVALUATION_ASSETS_REQUIRED');
      const verifierHash = treeHash(assets), id = randomUUID(), dir = this.files.runDir(id);
      mkdirSync(dir, { recursive: true }); cpSync(assets, join(dir, 'evaluation'), { recursive: true });
      const header: Header = { version: 1, id, repo: this.repo, baselineSha, spec, specHash: hash(spec), config,
        configHash: hash(config), verifierHash, createdAt: new Date().toISOString() };
      HeaderSchema.parse(header); writeJson(join(dir, 'run.json'), header, true);
      writeFileSync(join(dir, 'prompt.md'), spec); writeFileSync(join(dir, 'ideas.md'), '# Ideas and learnings\n');
      const state: Checkpoint = { version: 1, id, state: 'RUNNING', bestSha: baselineSha, bestMetric: null, iterations: 0, noProgress: 0 };
      this.files.save(state); writeJson(join(this.files.root, 'current.json'), { id });
      await git(this.repo, ['update-ref', this.bestRef(id), baselineSha]);
      await this.prepare(state, 0); await this.measureDraft(state); await this.finish(state, { description: 'Baseline', hypothesis: 'Measure the committed baseline without edits' });
      return this.files.checkpoint(id);
    });
  }
  status(): { header: Header; checkpoint: Checkpoint; decisions: Decision[] } | undefined {
    if (!this.files.current()) return;
    const header = this.files.header(), checkpoint = this.files.checkpoint();
    if (hash(header.config) !== header.configHash || hash(header.spec) !== header.specHash) throw new Error('HEADER_HASH_MISMATCH');
    let best: number | null = null, passed: string[] = [];
    const records = this.files.records(header.id);
    for (let i = 0; i < records.length; i++) {
      const { decision: d, measurement: m } = records[i];
      if (d.run !== i || m.run !== i || d.measurementHash !== hash(m) || d.candidateSha !== m.candidateSha ||
        d.specHash !== header.specHash || d.configHash !== header.configHash || d.verifierHash !== header.verifierHash ||
        m.specHash !== header.specHash || m.configHash !== header.configHash || m.verifierHash !== header.verifierHash) throw new Error('CORRUPT_EXPERIMENT_HISTORY');
      const expected = decide(header.config, m, best, i === 0, passed);
      if (Object.entries(expected).some(([key, value]) => d[key as keyof Decision] !== value)) throw new Error('DECISION_REPLAY_MISMATCH');
      if (d.status === 'keep') { best = d.metric; passed = header.config.requirements.filter(r => m.samples.every(s => s.requirements[r.id] === 'PASS')).map(r => r.id); }
    }
    if (checkpoint.state === 'COMPLETED' && !records.at(-1)?.decision.goalReached) throw new Error('CHECKPOINT_EVIDENCE_MISMATCH');
    return { header, checkpoint, decisions: records.map(r => r.decision) };
  }
  inspect(): Measurement | undefined {
    const status = this.status(); if (!status) return;
    const path = join(this.files.trial(status.header.id, status.checkpoint.pending?.run ?? status.decisions.at(-1)?.run ?? 0), 'measurement.json');
    return existsSync(path) ? readJson(path, MeasurementSchema) : undefined;
  }
  sourceFiles(): string[] {
    const status = this.status(), draft = status?.checkpoint.draft; if (!status || !draft) return [];
    const files = new Set<string>();
    const walk = (path: string) => {
      if (files.size >= 500 || !existsSync(path) || lstatSync(path).isSymbolicLink() || !inside(draft.cwd, path)) return;
      if (lstatSync(path).isDirectory()) for (const name of readdirSync(path).sort()) { if (!name.startsWith('.')) walk(join(path, name)); }
      else files.add(path);
    };
    for (const scope of status.header.config.scope) walk(join(draft.cwd, scope)); return [...files].sort();
  }
  run(signal?: AbortSignal): Promise<Measurement> {
    if (this.running) return Promise.reject(new Error('RUN_LOCKED'));
    const job = this.files.locked(async () => {
      const state = this.files.checkpoint();
      if (state.state !== 'RUNNING') throw new Error(`RUN_NOT_ACTIVE: ${state.state}`);
      if (state.pending) throw new Error('MEASUREMENT_PENDING: call log_experiment first');
      const header = this.files.header(state.id);
      if (state.iterations >= header.config.maxIterations) throw new Error('ITERATION_BUDGET_REACHED');
      if (!state.draft) await this.prepare(state, state.iterations + 1);
      return this.measureDraft(state, signal);
    }).finally(() => { this.running = undefined; });
    this.running = job; return job;
  }
  async log(run: number, notes: Notes): Promise<Decision> {
    return this.files.locked(async () => {
      const state = this.files.checkpoint();
      const existing = join(this.files.trial(state.id, run), 'decision.json');
      if (existsSync(existing)) {
        await this.reconcile(state);
        if (state.state === 'RUNNING' && !state.pending && !state.draft) await this.prepare(state, state.iterations + 1);
        return readJson(existing, DecisionSchema);
      }
      if (state.state !== 'RUNNING' || state.pending?.run !== run || state.pending.phase !== 'MEASURED') throw new Error('NO_MATCHING_MEASUREMENT');
      await this.reconcile(state);
      return this.finish(state, notes);
    });
  }
  async resume(): Promise<Checkpoint> {
    return this.files.locked(async () => {
      const state = this.files.checkpoint(); if (['COMPLETED', 'CANCELLED'].includes(state.state)) return state;
      if (state.state === 'BLOCKED') throw new Error('RUN_BLOCKED: stop and start with reviewed configuration');
      await this.reconcile(state);
      if (['COMPLETED', 'BLOCKED', 'CANCELLED'].includes(state.state)) return state;
      const header = this.files.header(state.id);
      if (treeHash(join(this.files.runDir(state.id), 'evaluation')) !== header.verifierHash) throw new Error('VERIFIER_CHANGED');
      if (state.draft) await this.validateDraft(state, header);
      state.state = 'RUNNING'; state.reason = undefined;
      writeJson(join(this.files.runDir(state.id), 'control.json'), { action: 'resume' }); this.files.save(state);
      if (!state.pending && !state.draft) await this.prepare(state, state.iterations + 1);
      return state;
    });
  }
  async pause(): Promise<void> { await this.control('pause'); }
  async stop(): Promise<void> { this.abort?.abort(); await this.control('stop'); }
  async interrupt(): Promise<void> {
    this.abort?.abort(); await this.pause(); if (this.running) await this.running.catch(() => {});
  }
  private async control(action: 'pause' | 'stop'): Promise<void> {
    const state = this.files.checkpoint(); if (['COMPLETED', 'CANCELLED'].includes(state.state)) return;
    writeJson(join(this.files.runDir(state.id), 'control.json'), { action });
    if (this.abort) return;
    await this.files.locked(async () => {
      const latest = this.files.checkpoint();
      latest.state = action === 'pause' ? 'PAUSED' : 'CANCELLED'; latest.reason = action === 'pause' ? 'Paused by user' : 'Cancelled by user';
      await this.killOrphans(latest); this.files.save(latest);
    }).catch(e => { if ((e as Error).message !== 'RUN_LOCKED' && (e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; });
  }
  private controlRequest(id: string): 'pause' | 'stop' | undefined {
    const path = join(this.files.runDir(id), 'control.json');
    if (!existsSync(path)) return;
    const action = readJson(path, z.object({ action: z.enum(['pause', 'stop', 'resume']) }).strict()).action;
    return action === 'resume' ? undefined : action;
  }
  private scoped(config: Header['config'], path: string, specific?: string): boolean {
    return (specific ? [specific] : config.scope).some(scope => path === scope || path.startsWith(scope + '/'));
  }
  private async prepare(state: Checkpoint, run: number): Promise<void> {
    const cwd = join(this.files.root, 'worktrees', state.id, String(run).padStart(4, '0')); mkdirSync(dirname(cwd), { recursive: true });
    await git(this.repo, ['worktree', 'add', '--detach', cwd, state.bestSha]);
    state.draft = { run, cwd: realpathSync(cwd), parentSha: state.bestSha }; this.files.save(state);
  }
  private async validateDraft(state: Checkpoint, header: Header): Promise<void> {
    const draft = state.draft!;
    if (!inside(this.files.root, draft.cwd) || await git(draft.cwd, ['rev-parse', 'HEAD']) !== draft.parentSha) throw new Error('WORKTREE_REVISION_CHANGED');
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === '.git') continue;
        const path = join(dir, name), stat = lstatSync(path);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('UNSAFE_CANDIDATE_FILE');
        if (stat.isDirectory()) walk(path);
        else if (stat.size > 10000000 || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(readFileSync(path, 'utf8'))) throw new Error('UNSAFE_CANDIDATE_CONTENT');
      }
    };
    walk(draft.cwd);
    const changes = (await git(draft.cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])).split('\0').filter(Boolean);
    for (const change of changes) {
      const path = change.slice(3);
      if (!this.scoped(header.config, path) || path.split('/').some(p => p.startsWith('.'))) throw new Error(`OUT_OF_SCOPE: ${path}`);
    }
  }
  private async measureDraft(state: Checkpoint, external?: AbortSignal): Promise<Measurement> {
    const header = this.files.header(state.id); await this.validateDraft(state, header);
    const draft = state.draft!, run = draft.run;
    await git(draft.cwd, ['add', '--all']); const tree = await git(draft.cwd, ['write-tree']);
    const sha = run === 0 ? header.baselineSha : await git(draft.cwd, ['commit-tree', tree, '-p', draft.parentSha, '-m', `HoH experiment ${run}`]);
    const candidate = join(this.files.root, 'evaluation-worktrees', state.id, String(run).padStart(4, '0')); mkdirSync(dirname(candidate), { recursive: true });
    await git(this.repo, ['worktree', 'add', '--detach', candidate, sha]);
    const trial = this.files.trial(state.id, run); mkdirSync(trial, { recursive: true });
    writeFileSync(join(trial, 'candidate.diff'), await git(this.repo, ['diff', '--no-ext-diff', '--no-textconv', draft.parentSha, sha]));
    state.pending = { run, candidateSha: sha, phase: 'MEASURING', children: [] }; this.files.save(state);
    this.abort = new AbortController(); const abort = () => this.abort?.abort(); external?.addEventListener('abort', abort, { once: true });
    const poll = setInterval(() => { if (this.controlRequest(state.id) === 'stop') this.abort?.abort(); }, 100);
    let measurement: Measurement;
    try {
      measurement = await measure(header, run, sha, candidate, trial, join(this.files.runDir(state.id), 'evaluation'), this.abort.signal,
        (pid, identity) => { state.pending!.children.push({ pid, identity }); this.files.save(state); });
      writeJson(join(trial, 'measurement.json'), measurement, true);
      state.pending.phase = 'MEASURED'; state.pending.children = [];
      const request = this.controlRequest(state.id);
      if (request) { state.state = request === 'stop' ? 'CANCELLED' : 'PAUSED'; state.reason = request; }
      this.files.save(state); return measurement;
    } catch (error) {
      state.state = this.controlRequest(state.id) === 'stop' ? 'CANCELLED' : 'PAUSED'; state.reason = 'Measurement interrupted; resume reconciles it from disk';
      this.files.save(state); throw error;
    } finally { clearInterval(poll); external?.removeEventListener('abort', abort); this.abort = undefined; }
  }
  private async finish(state: Checkpoint, notes: Notes): Promise<Decision> {
    if (this.controlRequest(state.id) === 'stop') { state.state = 'CANCELLED'; this.files.save(state); throw new Error('RUN_CANCELLED'); }
    const header = this.files.header(state.id), pending = state.pending!, trial = this.files.trial(state.id, pending.run);
    const measurement = readJson(join(trial, 'measurement.json'), MeasurementSchema);
    if (measurement.candidateSha !== pending.candidateSha || measurement.run !== pending.run || measurement.specHash !== header.specHash ||
      measurement.configHash !== header.configHash || measurement.verifierHash !== header.verifierHash) throw new Error('EVIDENCE_BINDING_MISMATCH');
    const history = this.files.records(state.id), best = history.filter(r => r.decision.status === 'keep').at(-1);
    const passed = header.config.requirements.filter(r => best?.measurement.samples.every(s => s.requirements[r.id] === 'PASS')).map(r => r.id);
    const verdict = decide(header.config, measurement, state.bestMetric, pending.run === 0, passed);
    const decision: Decision = { version: 1, run: pending.run, candidateSha: pending.candidateSha, measurementHash: hash(measurement),
      specHash: header.specHash, configHash: header.configHash, verifierHash: header.verifierHash, ...verdict,
      description: notes.description, hypothesis: notes.hypothesis ?? '', learned: notes.learned ?? '', nextFocus: notes.nextFocus ?? '', timestamp: new Date().toISOString() };
    DecisionSchema.parse(decision); writeJson(join(trial, 'decision.json'), decision, true);
    await this.reconcile(state); state.pending = undefined; state.draft = undefined;
    if (pending.run === 0 && decision.status !== 'keep') { state.state = 'BLOCKED'; state.reason = `Baseline is invalid: ${decision.reason}`; }
    else if (decision.goalReached) { state.state = 'COMPLETED'; state.reason = 'All requirements and target verified'; }
    else if (state.iterations >= header.config.maxIterations || state.noProgress >= header.config.maxNoProgress) {
      state.state = 'BLOCKED'; state.reason = state.iterations >= header.config.maxIterations ? 'Iteration budget reached' : 'No-progress budget reached';
    }
    const request = this.controlRequest(state.id);
    if (request) { state.state = request === 'stop' ? 'CANCELLED' : 'PAUSED'; state.reason = request; }
    this.files.save(state); this.renderHistory(header);
    if (state.state === 'RUNNING') await this.prepare(state, state.iterations + 1);
    return decision;
  }
  private async killOrphans(state: Checkpoint): Promise<void> {
    for (const child of state.pending?.children ?? []) {
      if (child.identity && await birthIdentity(child.pid) === child.identity) { killGroup(child.pid, 'SIGKILL'); }
    }
  }
  /** Replay decisions from immutable JSON facts; a snapshot never gets to invent a keep. */
  private async reconcile(state: Checkpoint): Promise<void> {
    const header = this.files.header(state.id); if (hash(header.config) !== header.configHash || hash(header.spec) !== header.specHash) throw new Error('HEADER_HASH_MISMATCH');
    let bestMetric: number | null = null, bestSha = header.baselineSha, noProgress = 0, passed: string[] = [];
    const history = this.files.records(state.id);
    for (let i = 0; i < history.length; i++) {
      const { decision: d, measurement: m } = history[i];
      if (d.run !== i || m.run !== i || hash(m) !== d.measurementHash || d.candidateSha !== m.candidateSha ||
        d.specHash !== header.specHash || d.configHash !== header.configHash || d.verifierHash !== header.verifierHash ||
        m.specHash !== header.specHash || m.configHash !== header.configHash || m.verifierHash !== header.verifierHash) throw new Error('CORRUPT_EXPERIMENT_HISTORY');
      const expected = decide(header.config, m, bestMetric, i === 0, passed);
      if (Object.entries(expected).some(([key, value]) => d[key as keyof Decision] !== value)) throw new Error('DECISION_REPLAY_MISMATCH');
      if (d.status === 'keep') {
        bestMetric = d.metric; bestSha = d.candidateSha; noProgress = 0;
        passed = header.config.requirements.filter(r => m.samples.every(s => s.requirements[r.id] === 'PASS')).map(r => r.id);
      } else if (i > 0) noProgress++;
    }
    state.bestSha = bestSha; state.bestMetric = bestMetric; state.iterations = Math.max(0, history.length - 1); state.noProgress = noProgress;
    await git(this.repo, ['update-ref', this.bestRef(state.id), bestSha]);
    if (state.pending && history.some(r => r.decision.run === state.pending!.run)) { state.pending = undefined; state.draft = undefined; }
    if (state.pending?.phase === 'MEASURING') {
      await this.killOrphans(state);
      const trial = this.files.trial(state.id, state.pending.run), path = join(trial, 'measurement.json');
      if (!existsSync(path)) {
        const interrupted: Measurement = { version: 1, run: state.pending.run, candidateSha: state.pending.candidateSha,
          specHash: header.specHash, configHash: header.configHash, verifierHash: header.verifierHash, samples: [], trusted: false,
          integrityError: 'Interrupted measurement; rerun in a new experiment', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
        writeJson(path, interrupted, true);
      }
      state.pending.phase = 'MEASURED'; state.pending.children = [];
    }
    if (history.at(-1)?.decision.goalReached) { state.state = 'COMPLETED'; state.reason = 'All requirements and target verified'; }
    else if (history.length && history[0].decision.status !== 'keep') { state.state = 'BLOCKED'; state.reason = 'Baseline is invalid'; }
    else if (state.iterations >= header.config.maxIterations || noProgress >= header.config.maxNoProgress) {
      state.state = 'BLOCKED'; state.reason = 'Iteration or no-progress budget reached';
    }
    this.files.save(state); this.renderHistory(header);
  }
  private renderHistory(header: Header): void {
    const entries = [{ type: 'config', name: header.config.name, metricName: header.config.metric.name, metricUnit: header.config.metric.unit, bestDirection: header.config.metric.direction },
      ...this.files.records(header.id).map(({ decision: d }) => ({ run: d.run, commit: d.candidateSha, metric: d.metric ?? 0, metrics: {},
        status: d.status === 'unstable' ? 'crash' : d.status, description: `${d.description} (${d.reason})`, timestamp: Date.parse(d.timestamp),
        asi: { hypothesis: d.hypothesis, learned: d.learned, next_action_hint: d.nextFocus } }))];
    writeFileSync(join(this.files.runDir(header.id), 'log.jsonl'), entries.map(x => JSON.stringify(x)).join('\n') + '\n');
    writeFileSync(join(this.files.runDir(header.id), 'ideas.md'), '# Ideas and learnings\n\n' + this.files.records(header.id).map(({ decision: d }) =>
      `- #${d.run} ${d.status}: ${d.learned || d.description}${d.nextFocus ? `\n  Next: ${d.nextFocus}` : ''}`).join('\n'));
  }
  /** Enforced tool capabilities, independent of prompt instructions. */
  guard(tool: string, input: Record<string, unknown>): string | undefined {
    const status = this.status(); if (!status || status.checkpoint.state !== 'RUNNING') return 'HoH is not active';
    if (['hoh_init_experiment', 'hoh_run_experiment', 'hoh_log_experiment'].includes(tool)) return;
    if (!['read', 'write', 'edit'].includes(tool)) return 'Only scoped file tools and experiment tools are enabled; shell, codemode, MCP and other tools are blocked';
    const state = status.checkpoint, draft = state.draft;
    if (!draft) return 'No draft is available';
    if (tool !== 'read' && state.pending) return 'Log the frozen measurement before editing again';
    if (typeof input.path !== 'string') return 'An explicit file path is required';
    const path = resolve(this.repo, input.path.replace(/^@/, '')), rel = relative(draft.cwd, path);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split('/').some(p => p.startsWith('.')) || !this.scoped(status.header.config, rel)) return 'Path is outside the assigned source scope';
    let existing = path;
    while (!existsSync(existing) && existing !== dirname(existing)) existing = dirname(existing);
    if (!inside(draft.cwd, existing)) return 'Path escapes the worktree through a symlink';
    // Reject symlinks even if their target is another scoped file.
    let current = existing;
    while (current !== draft.cwd) { if (lstatSync(current).isSymbolicLink()) return 'Symlinks are blocked'; current = dirname(current); }
  }
}
