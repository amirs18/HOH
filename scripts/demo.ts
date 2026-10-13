import { HoH } from '../src/engine.js';
import { publicStatus, context } from '../src/context.js';
import { git, writeJson } from '../src/io.js';
import { fixture, edit } from '../test/support.js';
import { join } from 'node:path';

const repo = await fixture(), engine = new HoH(repo);
const baseline = await git(repo, ['rev-parse', 'HEAD']);
await engine.start('SPEC.md');
const attempt = async (add: string, multiply: string, description: string) => {
  const state = engine.status()!.checkpoint; edit(state.draft!.cwd, add, multiply);
  const measured = await engine.run(); const decision = await engine.log(measured.run, { description, hypothesis: description });
  console.log(`#${decision.run}: ${decision.status}, score=${decision.metric}, goal=${decision.goalReached}, ${decision.reason}`);
};
await attempt('(a>0&&b>0)?a+b:a-b', 'a*b', 'Fix only positive operands');
await attempt('a+b', '0', 'Try full addition but accidentally regress multiplication');
const beforeRestart = context(engine);
await engine.pause(); const restarted = new HoH(repo); await restarted.resume();
if (restarted.status()!.checkpoint.bestMetric !== 1) throw new Error('Lost verified partial progress');
edit(restarted.status()!.checkpoint.draft!.cwd, 'a+b');
const measured = await restarted.run(); const final = await restarted.log(measured.run, { description: 'Fix signed and zero operands', learned: 'Full addition passes seeded cases and preserves multiplication' });
if (final.status !== 'keep' || !final.goalReached || restarted.status()!.checkpoint.state !== 'COMPLETED') throw new Error('DEMO_FAILED');
if (await git(repo, ['rev-parse', 'HEAD']) !== baseline) throw new Error('USER_BRANCH_CHANGED');
const reopened = new HoH(repo), firstContext = context(reopened);
if (context(new HoH(repo)) !== firstContext) throw new Error('NONDETERMINISTIC_CONTEXT');
writeJson(join(repo, '.hoh/demo.json'), { ...publicStatus(reopened), repo, deterministicContext: true, mainUnchanged: true });
console.log(JSON.stringify({ ...publicStatus(reopened), repo, deterministicContext: true, mainUnchanged: true }, null, 2));
