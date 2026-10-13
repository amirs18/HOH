import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../src/core/controller.js';
import { git } from '../src/infra/worktrees.js';
import { publicStatus } from '../src/ui/status.js';
import { createFixture, FakeRunner } from '../test/support/fixture.js';

const repo = await createFixture();
const baseline = await git(repo, ['rev-parse', 'HEAD']);
const runner = new FakeRunner(repo);
const controller = new Controller(repo, { runner, onChange: r => console.log(`HoH ${r.state} ${r.tasks.map(t => `${t.id}:${t.state}(${t.attempts})`).join(' ')}`) });
const run = await controller.start('SPEC.md');
await controller.drive(run.id);
const final = controller.status(run.id)!;
if (final.state !== 'ACCEPTED' || runner.builds !== 2) throw new Error(`DEMO_FAILED: ${final.state}: ${final.blocker}`);
if (await git(repo, ['rev-parse', 'HEAD']) !== baseline) throw new Error('USER_BRANCH_CHANGED');
controller.close();
const reopened = new Controller(repo, { runner });
await reopened.drive(run.id); // An accepted run must be inspectable and idempotent after reopening.
const report = { repo, ...publicStatus(reopened.status(run.id), reopened.inspect(run.id)),
  attempts: reopened.store.attempts(run.id), evaluation: reopened.inspect(run.id) };
writeFileSync(join(repo, '.hoh/demo-result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2)); reopened.close();
