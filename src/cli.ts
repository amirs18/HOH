#!/usr/bin/env node
import { HoH } from './engine.js';
import { publicStatus, context } from './context.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2), i = args.indexOf('--repo');
  const repo = i >= 0 ? args.splice(i, 2)[1] : process.cwd();
  const [verb = 'status', ...rest] = args, engine = new HoH(repo);
  const abort = new AbortController();
  const stop = () => { abort.abort(); void engine.pause(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    let result: unknown;
    if (verb === 'start') result = await engine.start(rest.join(' '));
    else if (verb === 'run') result = await engine.run(abort.signal);
    else if (verb === 'log') {
      const run = Number(rest.shift()); result = await engine.log(run, { description: rest.join(' ') || 'CLI experiment' });
    } else if (verb === 'resume') result = await engine.resume();
    else if (verb === 'pause' || verb === 'stop') { await engine[verb](); result = publicStatus(engine); }
    else if (verb === 'inspect') result = engine.inspect() ?? { state: 'NO_MEASUREMENT' };
    else if (verb === 'context') { process.stdout.write(context(engine) + '\n'); return; }
    else if (verb === 'status') result = publicStatus(engine);
    else throw new Error('Usage: hoh start SPEC.md | run | log N DESCRIPTION | resume | pause | stop | status | inspect | context [--repo PATH]');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(error => { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; });
