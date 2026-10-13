import { Controller } from '../../src/core/controller.js';
import { FakeRunner } from '../support/fixture.js';
import { PiRpcRunner } from '../../src/agents/pi-rpc-runner.js';
import { Isolation } from '../../src/infra/isolation.js';
import { ConfigSchema } from '../../src/core/schemas.js';
import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [repo, runId] = process.argv.slice(2);
const model = new FakeRunner(repo);
const execute = model.execute.bind(model);
let controller: Controller;
model.execute = async (job, options) => {
  if (job.role !== 'builder') return execute(job, options);
  cpSync(resolve('test/fixtures/rpc.mjs'), join(job.cwd, 'rpc.mjs'));
  const isolation = new Isolation('macos'); await isolation.probe();
  const config = ConfigSchema.parse({ runner: { command: process.execPath, args: ['rpc.mjs'], env: { FAKE_MODE: 'hang' } } });
  const rpc = new PiRpcRunner(config, isolation, { started: (pid, identity) => controller.store.recordChild(runId, pid, identity), ended: pid => controller.store.removeChild(pid) });
  return rpc.execute({ ...job, timeoutMs: 60_000 }, options);
};
controller = new Controller(repo, { runner: model });
await controller.drive(runId); controller.close();
