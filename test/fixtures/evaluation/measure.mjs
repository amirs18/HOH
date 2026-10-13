import { isDeepStrictEqual } from 'node:util';
import { probe } from './probe.mjs';
// Deterministic additional examples generated from a seeded integer generator.
let seed = Number(process.env.HOH_SEED) >>> 0;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
const positive = [[2,3], ...Array.from({length: 20}, () => [1 + random()%100, 1 + random()%100])];
const signed = [[-4,7],[0,0],[0,9],[-3,-2], ...Array.from({length: 20}, () => [(random()%101)-50, (random()%101)-50])];
const pass1 = isDeepStrictEqual(await probe('add', positive), positive.map(([a,b]) => a+b));
const pass2 = isDeepStrictEqual(await probe('add', signed), signed.map(([a,b]) => a+b));
console.log(`METRIC requirements_passed=${Number(pass1)+Number(pass2)}`);
console.log(`CHECK R1=${pass1?'PASS':'FAIL'}`);
console.log(`CHECK R2=${pass2?'PASS':'FAIL'}`);
