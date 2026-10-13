import assert from 'node:assert/strict';
import { probe } from './probe.mjs';
assert.deepEqual(await probe('multiply', [[3,4],[-2,3],[0,9]]), [12,-6,0], 'Multiplication regressed');
console.log('Regression passed');
