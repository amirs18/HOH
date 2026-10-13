import { describe, expect, it } from 'vitest';
import { chmodSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runCommand } from '../../src/infra/process.js';
import { createFixture } from '../support/fixture.js';
describe.skipIf(process.platform !== 'darwin')('detached CLI controller and isolated JSONL model processes', () => {
  it('starts asynchronously and supports status/inspect/resume from independent processes', async () => {
    const executable = resolve('test/fixtures/scripted-pi.mjs'); chmodSync(executable, 0o755);
    const repo = await createFixture({ runner: { command: executable } });
    const invoke = async (...args: string[]) => {
      const r = await runCommand({ executable: process.execPath, args: ['--import', 'tsx', resolve('src/cli.ts'), ...args, '--repo', repo], cwd: process.cwd() }, { timeoutMs: 20_000 });
      expect(r.exitCode, r.stderr).toBe(0); return JSON.parse(r.stdout);
    };
    const started = await invoke('start', 'SPEC.md'); expect(started.runId).toBeTruthy();
    let status = started; const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !['ACCEPTED', 'BLOCKED', 'FAILED'].includes(status.state)) {
      await new Promise(r => setTimeout(r, 150)); status = await invoke('status');
    }
    expect(status.state, readFileSync(join(repo, '.hoh/runs', started.runId, 'controller.log'), 'utf8')).toBe('ACCEPTED');
    expect(status.tasks[0].attempts).toBe(2);
    const evidence = await invoke('inspect'); expect(evidence.decision).toBe('ACCEPT'); expect(evidence.candidateSha).toBe(status.acceptedSha);
    expect((await invoke('resume')).acceptedSha).toBe(status.acceptedSha);
  });
});
