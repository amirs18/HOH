import assert from 'node:assert/strict';
import { probe } from './probe.mjs';
assert.deepEqual(await probe('multiply', [[3, 4], [-2, 3]]), [12, -6], 'Existing multiplication must remain intact');
console.log('Regression passed');
