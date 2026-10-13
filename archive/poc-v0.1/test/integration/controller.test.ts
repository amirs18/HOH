import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../src/core/controller.js';
import { command } from '../../src/core/commands.js';
import { git, acceptedRef } from '../../src/infra/worktrees.js';
import { createFixture, FakeRunner, fixtureConfig } from '../support/fixture.js';
const supported = process.platform === 'darwin';
const correct = (cwd: string, multiply = 'a*b') => writeFileSync(join(cwd, 'app.mjs'), `export function add(a,b){return a+b;}\nexport function multiply(a,b){return ${multiply};}\n`);
describe.skipIf(!supported)('real Git / SQLite / sandbox verification with fake models', () => {
  it('rejects the first SHA, repairs, accepts only the second and reopens idempotently', async () => {
    const repo = await createFixture(), runner = new FakeRunner(repo), c = new Controller(repo, { runner });
    const before = await git(repo, ['rev-parse', 'HEAD']);
    const result = await command(c, 'start', 'SPEC.md');
    const runId = result.runId!; await c.drive(runId);
    const run = c.status(runId)!, attempts = c.store.attempts(runId);
    expect(run.state, run.blocker).toBe('ACCEPTED'); expect(runner.builds).toBe(2);
    expect(attempts.map(a => a.exitOutcome)).toEqual(['REJECT', 'ACCEPT']);
    expect(attempts[0].candidateSha).not.toBe(attempts[1].candidateSha);
    expect(run.acceptedSha).toBe(attempts[1].candidateSha);
    expect(await git(repo, ['rev-parse', acceptedRef(run.id)])).toBe(run.acceptedSha);
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before);
    expect(readFileSync(join(repo, 'app.mjs'), 'utf8')).toContain('a - b');
    const e = c.inspect()!; expect(e.candidateSha).toBe(run.acceptedSha); expect(e.contractHash).toBe(run.contractHash);
    expect(e.checks.find(x => x.id === 'acceptance')!.status).toBe('PASS');
    expect((await command(c, 'status')).output).toMatchObject({ state: 'ACCEPTED' });
    expect((await command(c, 'inspect')).output).toMatchObject({ decision: 'ACCEPT' });
    c.close(); const reopened = new Controller(repo, { runner }); await reopened.drive(run.id);
    expect(reopened.status()!.state).toBe('ACCEPTED'); expect(runner.builds).toBe(2); reopened.close();
  });
  it('does not accept builder prose when regression is broken; diagnosis and budgets terminate', async () => {
    const repo = await createFixture(), runner = new FakeRunner(repo, job => correct(job.cwd, '0')), c = new Controller(repo, { runner });
    const run = await c.start('SPEC.md'); await c.drive(run.id);
    expect(c.status()!.state).toBe('BLOCKED'); expect(c.status()!.acceptedSha).toBe(run.baselineSha);
    expect(c.inspect()!.checks.find(x => x.id === 'regression')!.status).toBe('FAIL');
    expect(runner.builds).toBe(3); expect(runner.diagnoses).toBe(1); expect(runner.reviews).toBe(0); c.close();
  });
  it('a supported critical reviewer finding triggers a fresh repair', async () => {
    const repo = await createFixture(), runner = new FakeRunner(repo, job => correct(job.cwd), (_job, n) => ({ findings: n === 1 ? [{
      id: 'F1', category: 'functional', severity: 'critical', requirementIds: ['R1'], description: 'A bounded defect needing repair',
      reproduction: 'Inspect candidate.diff and reproduce the addition edge case', evidencePaths: ['candidate.diff'], proposedFix: 'Implement the missing edge case',
    }] : [] })), c = new Controller(repo, { runner });
    const run = await c.start('SPEC.md'); await c.drive(run.id);
    expect(c.status()!.state, c.status()!.blocker).toBe('ACCEPTED'); expect(runner.builds).toBe(2);
    expect(c.store.attempts(run.id)[0].exitOutcome).toBe('REJECT');
    expect(runner.calls.filter(j => j.role === 'builder')[1].instructions).toContain('F1'); c.close();
  });
  it('verifies sequential slices and reruns earlier requirement checks before the release gate', async () => {
    const original = fixtureConfig(), r2 = { id: 'R2', statement: 'Subtract operands', priority: 'high' as const,
      acceptanceCriteria: ['Return a-b'], verificationIds: ['subtract'], dependencies: ['R1'] };
    const config = fixtureConfig({ requirements: [...original.requirements!, r2], evaluators: [...original.evaluators,
      { id: 'subtract', kind: 'acceptance', executable: process.execPath, args: ['{evaluation}/subtract.mjs'], requirementIds: ['R2'] }] });
    const repo = await createFixture(config);
    writeFileSync(join(repo, '.hoh/evaluation/subtract.mjs'), `import assert from 'node:assert/strict'; import {probe} from './probe.mjs'; assert.deepEqual(await probe('subtract', [[9,4]]), [5]);`);
    const runner = new FakeRunner(repo, job => {
      correct(job.cwd);
      if (job.taskId === 'T2') writeFileSync(join(job.cwd, 'app.mjs'), readFileSync(join(job.cwd, 'app.mjs'), 'utf8') + 'export function subtract(a,b){return a-b;}\n');
    });
    const execute = runner.execute.bind(runner); runner.execute = async (j, o) => {
      const result = await execute(j, o);
      if (j.role === 'planner') {
        const plan = result.structured as import('../../src/core/schemas.js').Plan;
        plan.contract.requirements = config.requirements!;
        plan.tasks.push({ id: 'T2', title: 'Subtract', requirementIds: ['R2'], scope: 'Implement subtraction', dependencies: ['T1'], objectiveChecks: ['subtract'], exitCriteria: ['Subtract correctly'] });
      }
      return result;
    };
    const c = new Controller(repo, { runner }); const run = await c.start('SPEC.md'); await c.drive();
    expect(c.status()!.state, c.status()!.blocker).toBe('ACCEPTED');
    expect(c.status()!.tasks.map(t => t.state)).toEqual(['ACCEPTED', 'ACCEPTED']);
    const rows = c.store.db.prepare('SELECT json FROM evaluations ORDER BY rowid').all() as { json: string }[];
    const first = JSON.parse(rows[0].json); expect(first.checks.find((e: { id: string }) => e.id === 'subtract')).toMatchObject({ mandatory: false, status: 'NOT_CONFIGURED' });
    expect(c.inspect()!.checks.filter(x => ['acceptance', 'subtract', 'regression'].includes(x.id)).map(x => x.status)).toEqual(['PASS', 'PASS', 'PASS']);
    expect(c.store.attempts(run.id)).toHaveLength(2); c.close();
  });
  it('rejects a worker that edits protected criteria with integrity evidence', async () => {
    const repo = await createFixture({ maxAttemptsPerTask: 1 }), runner = new FakeRunner(repo, job => {
      correct(job.cwd); writeFileSync(join(job.cwd, 'SPEC.md'), 'New weaker criteria');
    }), c = new Controller(repo, { runner });
    await c.start('SPEC.md'); await c.drive();
    expect(c.status()!.state).toBe('BLOCKED');
    expect(c.inspect()!.checks.find(x => x.id === 'integrity')).toMatchObject({ status: 'FAIL', summary: 'SPEC.md' }); c.close();
  });
  it('reports timeout as ERROR and never accepts', async () => {
    const config = fixtureConfig(); config.evaluators[0].args = ['-e', 'setTimeout(()=>{}, 10000)']; config.evaluators[0].timeoutMs = 100;
    const repo = await createFixture({ evaluators: config.evaluators, maxAttemptsPerTask: 1 }), c = new Controller(repo, { runner: new FakeRunner(repo, job => correct(job.cwd)) });
    await c.start('SPEC.md'); await c.drive();
    expect(c.inspect()!.checks.find(x => x.id === 'acceptance')).toMatchObject({ status: 'ERROR', summary: 'Evaluator timed out' });
    expect(c.status()!.state).toBe('BLOCKED'); c.close();
  });
  it('a candidate cannot forge verifier success by exiting the process with code zero', async () => {
    const repo = await createFixture({ maxAttemptsPerTask: 1 });
    const runner = new FakeRunner(repo, job => writeFileSync(join(job.cwd, 'app.mjs'), 'process.exit(0);'));
    const c = new Controller(repo, { runner }); await c.start('SPEC.md'); await c.drive();
    expect(c.status()!.state).toBe('BLOCKED');
    expect(c.inspect()!.checks.find(x => x.id === 'acceptance')!.status).toBe('FAIL'); c.close();
  });
  it('redacts credential values from evaluation summaries, inspect output and command evidence', async () => {
    const config = fixtureConfig();
    config.evaluators[0].args = ['-e', 'console.error("synthetic-api-key-value");process.exit(1)'];
    const repo = await createFixture({ runner: { env: { HOH_API_KEY: 'synthetic-api-key-value' } }, evaluators: config.evaluators, maxAttemptsPerTask: 1 });
    const c = new Controller(repo, { runner: new FakeRunner(repo, job => correct(job.cwd)) });
    await c.start('SPEC.md'); await c.drive();
    expect(c.status()!.state).toBe('BLOCKED'); const e = c.inspect()!;
    expect(JSON.stringify(e)).not.toContain('synthetic-api-key-value');
    for (const path of e.checks.find(x => x.id === 'acceptance')!.evidencePaths)
      expect(readFileSync(path, 'utf8')).not.toContain('synthetic-api-key-value');
    c.close();
  });
  it('pauses after a safe operation and resumes accepted history without duplicate builds', async () => {
    const repo = await createFixture(); let c: Controller;
    const runner = new FakeRunner(repo, async job => { correct(job.cwd); await c.pause(); }); c = new Controller(repo, { runner });
    const run = await c.start('SPEC.md'); await c.drive();
    expect(c.status()!.state).toBe('PAUSED'); expect(c.status()!.tasks[0].state).toBe('ACCEPTED'); c.close();
    const reopened = new Controller(repo, { runner }); await reopened.drive(run.id);
    expect(reopened.status()!.state).toBe('ACCEPTED'); expect(runner.builds).toBe(1); reopened.close();
  });
  it('stop aborts ongoing work and preserves the user branch and worktree', async () => {
    const repo = await createFixture(); let entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    const runner = new FakeRunner(repo); const execute = runner.execute.bind(runner);
    runner.execute = async (job, options) => {
      if (job.role !== 'builder') return execute(job, options);
      entered(); await new Promise<void>((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true }));
      throw new Error('unreachable');
    };
    const c = new Controller(repo, { runner }), run = await c.start('SPEC.md'), driving = c.drive();
    await ready; expect((await command(c, 'status')).output).toMatchObject({ state: 'RUNNING' });
    expect((await command(c, 'inspect')).output).toHaveProperty('summary');
    const second = new Controller(repo); await expect(second.drive(run.id)).rejects.toThrow('RUN_LOCKED'); second.close();
    await c.stop(); await driving;
    expect(c.status()!.state).toBe('CANCELLED'); expect(c.store.attempts(run.id)[0].exitOutcome).toBe('CANCELLED');
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(run.baselineSha); c.close();
  });
  it('requires manual approval of a Markdown-only plan and binds approval to its hash', async () => {
    const repo = await createFixture({ planApproval: 'manual' }), runner = new FakeRunner(repo, job => correct(job.cwd)), c = new Controller(repo, { runner });
    await c.start('SPEC.md'); await c.drive();
    expect(c.status()!.state).toBe('PAUSED'); expect(runner.builds).toBe(0);
    await expect(c.approvePlan('wrong')).rejects.toThrow('APPROVAL_HASH');
    await c.approvePlan(c.status()!.contractHash!); await c.drive();
    expect(c.status()!.state).toBe('ACCEPTED'); c.close();
  });
  it('fails missing mandatory suites and never accepts forged store transitions', async () => {
    const repo = await createFixture({ evaluators: fixtureConfig().evaluators.filter(e => e.kind !== 'regression'), maxAttemptsPerTask: 1 });
    const runner = new FakeRunner(repo, job => correct(job.cwd));
    // Plan objective checks must match configured verifiers for this particular test.
    const execute = runner.execute.bind(runner); runner.execute = async (j, o) => {
      const r = await execute(j, o);
      if (j.role === 'planner') { const p = r.structured as { tasks: { objectiveChecks: string[] }[] }; p.tasks[0].objectiveChecks = ['acceptance']; }
      return r;
    };
    const c = new Controller(repo, { runner }); await c.start('SPEC.md'); await c.drive();
    expect(c.status()!.state).toBe('BLOCKED'); expect(c.inspect()!.checks.find(e => e.id === 'regression-suite')!.status).toBe('NOT_CONFIGURED');
    const forged = c.status()!; forged.state = 'ACCEPTED'; expect(() => c.store.save(forged, 'FAKE_ACCEPT')).toThrow(); c.close();
  });
});
describe('portable fail-closed boundaries', () => {
  it('invalid config JSON cannot expose credential snippets in errors', async () => {
    const repo = await createFixture(), c = new Controller(repo);
    writeFileSync(join(repo, '.hoh/config.json'), '{"key":"synthetic-secret-value", broken}');
    await expect(c.start('SPEC.md')).rejects.toThrow('CONFIG_JSON_INVALID'); c.close();
  });
  it('rejects tracked private keys before any worker sees the baseline', async () => {
    const repo = await createFixture();
    writeFileSync(join(repo, 'key.txt'), '-----BEGIN PRIVATE KEY-----\nsynthetic-test-value\n');
    await git(repo, ['add', 'key.txt']); await git(repo, ['commit', '-m', 'Synthetic secret fixture']);
    const runner = new FakeRunner(repo), c = new Controller(repo, { runner });
    await expect(c.start('SPEC.md')).rejects.toThrow('BASELINE_CONTAINS_SECRET'); expect(runner.calls).toHaveLength(0); c.close();
  });
  it('refuses dirty baselines and simultaneous active runs', async () => {
    const repo = await createFixture(), c = new Controller(repo);
    writeFileSync(join(repo, 'app.mjs'), 'dirty'); await expect(c.start('SPEC.md')).rejects.toThrow('DIRTY_BASELINE');
    c.close();
    const clean = await createFixture(), other = new Controller(clean); await other.start('SPEC.md');
    await expect(other.start('SPEC.md')).rejects.toThrow('ACTIVE_RUN_EXISTS'); await other.stop(); other.close();
  });
  it('does not dispatch workers or accept when hard isolation is disabled', async () => {
    const repo = await createFixture({ isolation: 'none' }), runner = new FakeRunner(repo), c = new Controller(repo, { runner });
    await c.start('SPEC.md'); await c.drive(); expect(c.status()!.state).toBe('BLOCKED'); expect(c.status()!.blocker).toContain('UNTRUSTED');
    expect(runner.calls).toHaveLength(0); c.close();
  });
});
