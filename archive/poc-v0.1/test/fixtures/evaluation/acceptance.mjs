import assert from 'node:assert/strict';
import { probe } from './probe.mjs';
const actual = await probe('add', [[2, 3], [-4, 7], [0, 0]]);
assert.deepEqual(actual, [5, 3, 0], 'R1: positive, negative and zero operands must add');
console.log('R1 acceptance passed');
