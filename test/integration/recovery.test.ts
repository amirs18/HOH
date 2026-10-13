import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Controller } from '../../src/core/controller.js';
import { createFixture, FakeRunner } from '../support/fixture.js';
import { processIdentity } from '../../src/infra/process.js';

describe.skipIf(process.platform !== 'darwin')('actual controller death and recovery', () => {
  it('kills an orphan worker on resume, reconciles unfinished attempts and prevents duplicate dispatch', async () => {
    const repo = await createFixture(), c = new Controller(repo), run = await c.start('SPEC.md');
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('test/fixtures/crash-controller.ts'), repo, run.id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', x => { stderr += x; });
    let worker: { pid: number; identity: string } | undefined;
    const deadline = Date.now() + 10_000;
    try {
      while (Date.now() < deadline && !worker) {
        worker = c.store.children(run.id)[0];
        if (!worker) await new Promise(r => setTimeout(r, 25));
      }
      expect(worker, stderr).toBeDefined();
      const same = new Controller(repo); await expect(same.drive(run.id)).rejects.toThrow('RUN_LOCKED'); same.close();
      const exited = new Promise<void>(r => child.once('close', () => r())); child.kill('SIGKILL'); await exited;
      expect(await processIdentity(worker!.pid)).toBe(worker!.identity);
      c.close();
      const runner = new FakeRunner(repo, job => writeFileSync(join(job.cwd, 'app.mjs'), 'export function add(a,b){return a+b;}\nexport function multiply(a,b){return a*b;}\n'));
      const resumed = new Controller(repo, { runner }); await resumed.drive(run.id);
      expect(resumed.status()!.state, resumed.status()!.blocker).toBe('ACCEPTED');
      expect(resumed.store.attempts(run.id).map(a => a.exitOutcome)).toEqual(['INTERRUPTED', 'ACCEPT']);
      expect(await processIdentity(worker!.pid)).not.toBe(worker!.identity);
      expect(runner.builds).toBe(1); expect(runner.calls.filter(j => j.role === 'planner')).toHaveLength(0);
      await resumed.drive(run.id); expect(runner.builds).toBe(1); resumed.close();
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
});
