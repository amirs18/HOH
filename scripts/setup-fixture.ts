import { createFixture } from '../test/support/fixture.js';
import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
const repo = await createFixture();
cpSync(resolve('examples/defective-config.json'), join(repo, '.hoh/config.json'));
console.log(repo);
