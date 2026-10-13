import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PiRpcRunner } from '../../src/agents/pi-rpc-runner.js';
import { Isolation } from '../../src/infra/isolation.js';
import { ConfigSchema } from '../../src/core/schemas.js';
import type { AgentJob } from '../../src/agents/runner.js';

async function setup(mode: string, timeoutMs = 2000) {
  const root = mkdtempSync(join(tmpdir(), 'hoh-rpc-')), cwd = join(root, 'worker'); mkdirSync(cwd);
  cpSync(resolve('test/fixtures/rpc.mjs'), join(cwd, 'rpc.mjs'));
  writeFileSync(join(root, 'state.sqlite'), 'state');
  mkdirSync(join(cwd, 'tests')); writeFileSync(join(cwd, 'tests/hidden.txt'), 'protected test');
  writeFileSync(join(cwd, '.git'), 'gitdir: protected');
  const isolation = new Isolation('macos'); await isolation.probe();
  const config = ConfigSchema.parse({ runner: { command: process.execPath, args: ['rpc.mjs'], env: {
    FAKE_MODE: mode, STATE_TARGET: join(root, 'state.sqlite'), TEST_TARGET: join(cwd, 'tests/hidden.txt'),
  } }, timeoutMs });
  const children = new Set<number>();
  const runner = new PiRpcRunner(config, isolation, { started: pid => { children.add(pid); }, ended: pid => { children.delete(pid); } });
  const job: AgentJob = { runId: 'rpc', taskId: 'T1', role: 'builder', cwd, instructions: 'Implement the task', readOnly: false, contextFiles: [], timeoutMs };
  return { runner, job, root, children };
}
describe.skipIf(process.platform !== 'darwin')('isolated Pi JSONL subprocess adapter', () => {
  it('correlates responses, captures reported usage and preserves Unicode text', async () => {
    const { runner, job } = await setup('normal');
    const result = await runner.execute(job, { signal: new AbortController().signal });
    expect(result.output).toBe('hello\u2028world'); expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 2, costUsd: 0.01 });
  });
  it('waits for agent_settled across automatic retries', async () => {
    const { runner, job } = await setup('retry');
    expect((await runner.execute(job, { signal: new AbortController().signal })).output).toBe('retried');
  });
  it.each([['malformed', 'RPC_MALFORMED_JSON'], ['exit', 'RPC_CHILD_EXIT'], ['truncate', 'RPC_TRUNCATED_FRAME'],
    ['hang', 'RPC_TIMEOUT'], ['model-error', 'RPC_MODEL_ERROR']])('fails safely on %s', async (mode, error) => {
    const { runner, job, children } = await setup(mode, 400);
    await expect(runner.execute(job, { signal: new AbortController().signal })).rejects.toThrow(error);
    expect(children.size).toBe(0);
  });
  it('aborts and reaps children', async () => {
    const { runner, job, children } = await setup('hang');
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 100);
    await expect(runner.execute(job, { signal: abort.signal })).rejects.toThrow('ABORTED'); clearTimeout(timer);
    expect(children.size).toBe(0);
  });
  it('enforces filesystem protection rather than relying on a prompt', async () => {
    const { runner, job, root } = await setup('attack');
    const result = await runner.execute(job, { signal: new AbortController().signal });
    expect(result.output).toBe('writeState:DENIED,readTests:DENIED,writeGit:DENIED');
    expect(readFileSync(join(root, 'state.sqlite'), 'utf8')).toBe('state');
    expect(readFileSync(join(job.cwd, '.git'), 'utf8')).toBe('gitdir: protected');
  });
});
