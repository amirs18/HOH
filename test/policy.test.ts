import { describe, it, expect } from 'vitest';
import { decide } from '../src/policy.js';
import { parseOutput } from '../src/measurement.js';
import { ConfigSchema, type Measurement } from '../src/model.js';
import { config } from './support.js';

const measurement = (values = [1,1,1]): Measurement => ({ version: 1, run: 1, candidateSha: 'a'.repeat(40), specHash: 's', configHash: 'c', verifierHash: 'v',
  trusted: true, startedAt: 'now', finishedAt: 'now', samples: values.map(metric => ({ metric, metrics: { requirements_passed: metric }, requirements: { R1: 'PASS', R2: 'FAIL' }, measureExit: 0, checksExit: 0, evidence: [] })) });
describe('deterministic policy', () => {
  it('keeps repeatable partial improvement without claiming the goal', () => {
    expect(decide(config(), measurement(), 0)).toMatchObject({ status: 'keep', metric: 1, goalReached: false });
    expect(decide(config(), measurement(), 1)).toMatchObject({ status: 'discard', goalReached: false });
  });
  it('requires target, every requirement, repeated results and backpressure', () => {
    const m = measurement([2,2,2]);
    expect(decide(config(), m, 0).goalReached).toBe(false);
    for (const s of m.samples) s.requirements.R2 = 'PASS';
    expect(decide(config(), m, 0)).toMatchObject({ status: 'keep', goalReached: true });
    m.samples[0].checksExit = 1; expect(decide(config(), m, 0).status).toBe('checks_failed');
  });
  it('rejects missing checks, errors, partial samples and untrusted isolation', () => {
    const m = measurement(); delete m.samples[1].requirements.R2;
    expect(decide(config(), m, 0).status).toBe('checks_failed');
    m.samples.pop(); expect(decide(config(), m, 0).status).toBe('crash');
    m.trusted = false; expect(decide(config(), m, 0).status).toBe('crash');
  });
  it('rejects metric and requirement instability and never hides prior regressions', () => {
    expect(decide(config(), measurement([1,1,1.01]), 0).status).toBe('unstable');
    const m = measurement(); m.samples[2].requirements.R2 = 'PASS';
    expect(decide(config(), m, 0).status).toBe('unstable');
    const r = measurement([2,2,2]); r.samples.forEach(s => { s.requirements.R1 = 'FAIL'; s.requirements.R2 = 'PASS'; });
    expect(decide(config(), r, 1, false, ['R1']).status).toBe('checks_failed');
  });
  it('supports lower-is-better, explicit tolerance, minimum gains and finite medians', () => {
    const c = config({ metric: { name: 'requirements_passed', direction: 'lower', target: 0, absoluteTolerance: 0.1, minImprovement: 0.2 } });
    expect(decide(c, measurement([1,1.01,1.02]), 2)).toMatchObject({ status: 'keep', metric: 1.01 });
    expect(decide(c, measurement(), 1.1).status).toBe('discard');
    const huge = config({ repeats: 2 }); expect(Number.isFinite(decide(huge, measurement([1e308,1e308]), null).metric)).toBe(true);
  });
  it('produces exactly the same decision for exactly the same persisted input', () => {
    const input = measurement(); expect(decide(config(), input, 0)).toEqual(decide(config(), structuredClone(input), 0));
  });
});
describe('strict upstream-derived measurement protocol', () => {
  it('parses finite decimal metrics, secondary metrics and explicit checks', () => {
    expect(parseOutput('noise\nMETRIC score=1e2\nMETRIC latency_ms=.2\nCHECK R1=PASS\n')).toEqual({ metrics: { score: 100, latency_ms: 0.2 }, requirements: { R1: 'PASS' } });
  });
  it.each(['METRIC score=NaN', 'METRIC score=Infinity', 'METRIC score=0xff', 'METRIC score=1\nMETRIC score=2',
    'METRIC __proto__=1', 'CHECK R1=PASS\nCHECK R1=FAIL', 'CHECK constructor=PASS', 'CHECK R1=maybe'])('rejects ambiguous/malformed output: %s', text => {
    expect(() => parseOutput(text)).toThrow();
  });
  it('rejects incomplete configs, duplicate requirement IDs and metadata scopes', () => {
    expect(ConfigSchema.safeParse({}).success).toBe(false);
    expect(() => config({ repeats: 1 })).toThrow(); expect(() => config({ scope: ['src/../.hoh'] })).toThrow();
    expect(() => config({ checks: { executable: 'unknown' } })).toThrow();
    expect(() => config({ requirements: [{ id: 'R1', statement: 'x' }, { id: 'R1', statement: 'y' }] })).toThrow();
  });
});
