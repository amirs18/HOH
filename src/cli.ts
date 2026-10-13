#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from './core/controller.js';
import { command } from './core/commands.js';
import { publicStatus } from './ui/status.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2), repoIndex = args.indexOf('--repo');
  const repo = repoIndex >= 0 ? args.splice(repoIndex, 2)[1] : process.cwd();
  if (!repo) throw new Error('USAGE: --repo <path>');
  const waitIndex = args.indexOf('--wait'), wait = waitIndex >= 0;
  if (wait) args.splice(waitIndex, 1);
  const [verb, ...rest] = args;
  const controller = new Controller(repo);
  const terminate = () => { void controller.shutdown(); };
  process.on('SIGTERM', terminate); process.on('SIGINT', terminate);
  try {
    if (verb === '_run') { await controller.drive(rest[0]); return; }
    const result = await command(controller, verb ?? 'status', rest.join(' '));
    if (result.dispatch) {
      if (wait) {
        await controller.drive(result.runId);
        result.output = publicStatus(controller.status(result.runId), controller.inspect(result.runId));
        if (['BLOCKED', 'FAILED'].includes(controller.status(result.runId)!.state)) process.exitCode = 2;
      } else {
        const logDir = join(controller.repo, '.hoh/runs', result.runId!); mkdirSync(logDir, { recursive: true });
        const fd = openSync(join(logDir, 'controller.log'), 'a', 0o600);
        const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '_run', result.runId!, '--repo', controller.repo],
          { detached: true, stdio: ['ignore', fd, fd], env: process.env });
        child.unref();
      }
    }
    process.stdout.write(JSON.stringify(result.output, null, 2) + '\n');
  } finally { process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', terminate); controller.close(); }
}
main().catch(e => { process.stderr.write(`${(e as Error).message}\n`); process.exitCode = 1; });
