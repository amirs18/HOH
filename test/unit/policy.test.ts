import { describe, it, expect } from 'vitest';
import { acceptance, budgetReason, failureFingerprint } from '../../src/core/policy.js';
import { transition } from '../../src/core/states.js';
import { ConfigSchema, PlanSchema, type CheckResult } from '../../src/core/schemas.js';
import { validatePlan } from '../../src/core/planner.js';
import { fixtureConfig, fixturePlan } from '../support/fixture.js';
import { redact } from '../../src/evaluation/artifacts.js';
import { JsonlDecoder } from '../../src/agents/pi-rpc-runner.js';
import { Artifacts } from '../../src/evaluation/artifacts.js';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = fixtureConfig(), plan = fixturePlan('spec', config);
const green = (): CheckResult[] => ['integrity', 'isolation', 'acceptance-suite', 'regression-suite', 'review', 'acceptance', 'regression'].map(id =>
  ({ id, requirementIds: id === 'acceptance' ? ['R1'] : [], status: 'PASS', mandatory: true, durationMs: 0, summary: 'passed', evidencePaths: [] }));
describe('state and independent acceptance', () => {
  it('rejects illegal transitions and unchecked acceptance', () => {
    expect(() => transition('task', 'READY', 'ACCEPTED', true)).toThrow('ILLEGAL_TRANSITION');
    expect(() => transition('task', 'VERIFYING', 'ACCEPTED')).toThrow('ACCEPTANCE_REQUIRES_EVIDENCE');
    expect(() => transition('run', 'RUNNING', 'ACCEPTED')).toThrow('ACCEPTANCE_REQUIRES_EVIDENCE');
    expect(transition('task', 'VERIFYING', 'ACCEPTED', true)).toBe('ACCEPTED');
  });
  it.each(['FAIL', 'ERROR', 'NOT_CONFIGURED'] as const)('cannot accept a mandatory %s', status => {
    const checks = green(); checks.find(c => c.id === 'acceptance')!.status = status;
    expect(acceptance(checks, [], ['R1'], plan, config).length).toBeGreaterThan(0);
  });
  it('requires all configured checks, coverage and system gates', () => {
    expect(acceptance(green(), [], ['R1'], plan, config)).toEqual([]);
    for (const missing of green()) expect(acceptance(green().filter(c => c.id !== missing.id), [], ['R1'], plan, config).length).toBeGreaterThan(0);
    const checks = green(); checks.find(c => c.id === 'acceptance')!.requirementIds = [];
    expect(acceptance(checks, [], ['R1'], plan, config).join(' ')).toContain('R1');
  });
  it('a reviewer cannot offset deterministic failure and high findings reject', () => {
    const checks = green(); checks.find(c => c.id === 'acceptance')!.status = 'FAIL';
    expect(acceptance(checks, [], ['R1'], plan, config).length).toBeGreaterThan(0);
    expect(acceptance(green(), [{ id: 'F1', category: 'functional', severity: 'critical', requirementIds: ['R1'], description: 'bug', evidencePaths: ['log'] }], ['R1'], plan, config)).toContain('F1: critical finding');
  });
  it('terminates on attempt and iteration budgets with stable fingerprints', () => {
    expect(budgetReason(3, 3, config)).toContain('task attempts');
    expect(budgetReason(1, 10, config)).toContain('total iterations');
    expect(failureFingerprint(green(), [])).toBe(failureFingerprint(green(), []));
  });
});
describe('untrusted configuration and plans', () => {
  it('rejects duplicate IDs, unknown/cyclic dependencies and unknown requirements', () => {
    expect(PlanSchema.safeParse({ ...plan, tasks: [plan.tasks[0], plan.tasks[0]] }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...plan, tasks: [{ ...plan.tasks[0], dependencies: ['missing'] }] }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...plan, tasks: [{ ...plan.tasks[0], dependencies: ['T1'] }] }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...plan, tasks: [{ ...plan.tasks[0], requirementIds: ['missing'] }] }).success).toBe(false);
  });
  it('rejects weakened criteria, changed source hash and unverifiable requirements', () => {
    const altered = structuredClone(plan); altered.contract.requirements[0].acceptanceCriteria = ['Just compile'];
    expect(() => validatePlan(altered, plan.contract.sourceSpecHash, config)).toThrow('REQUIREMENT_CHANGED');
    expect(() => validatePlan(plan, 'wrong', config)).toThrow('SPEC_HASH_MISMATCH');
    expect(() => validatePlan(plan, plan.contract.sourceSpecHash, { ...config, evaluators: [] })).toThrow();
  });
  it('rejects arbitrary executable names, reserved IDs and unsafe path configuration', () => {
    expect(ConfigSchema.safeParse({ evaluators: [{ id: 'acceptance', kind: 'acceptance', executable: 'evil' }] }).success).toBe(false);
    expect(ConfigSchema.safeParse({ protectedPaths: ['../state'] }).success).toBe(false);
    expect(ConfigSchema.safeParse({ planApproval: 'configured-requirements' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ worktreeRoot: '../other' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ requirements: [plan.contract.requirements[0], plan.contract.requirements[0]] }).success).toBe(false);
    expect(ConfigSchema.safeParse({ evaluators: [{ id: 'review', kind: 'acceptance', executable: 'node' }] }).success).toBe(false);
  });
});
describe('bounded evidence and JSONL framing', () => {
  it('redacts known secrets, bearer tokens and credential assignments', () => {
    const value = redact('key=known-secret known-secret Bearer abc123 password=hunter2', ['known-secret']);
    expect(value).not.toContain('known-secret'); expect(value).not.toContain('abc123'); expect(value).not.toContain('hunter2');
  });
  it('decodes split LF/CRLF records while preserving Unicode separators', () => {
    const records: unknown[] = [], decoder = new JsonlDecoder(x => records.push(x));
    decoder.feed('{"type":"event","text":"hello\u2028world"}'); expect(records).toHaveLength(0);
    decoder.feed('\r\n{"type":"done"}\n'); decoder.end(); expect(records).toHaveLength(2);
  });
  it('rejects malformed, oversized and truncated frames', () => {
    expect(() => new JsonlDecoder(() => {}).feed('bad\n')).toThrow('RPC_MALFORMED_JSON');
    expect(() => new JsonlDecoder(() => {}, 3).feed('abcd')).toThrow('RPC_FRAME_TOO_LARGE');
    const d = new JsonlDecoder(() => {}); d.feed('{'); expect(() => d.end()).toThrow('RPC_TRUNCATED_FRAME');
  });
  it('redacts before bounding logs and refuses artifacts escaping through symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'hoh-evidence-'));
    const artifacts = new Artifacts(join(root, 'saved'), ['long-secret-value'], 10);
    const path = artifacts.write('output.log', 'abc long-secret-value');
    expect(readFileSync(path, 'utf8')).not.toContain('long-');
    expect(() => artifacts.write('output.log', 'replace evidence')).toThrow();
    mkdirSync(join(root, 'outputs')); writeFileSync(join(root, 'outside.txt'), 'not evidence');
    symlinkSync(join(root, 'outside.txt'), join(root, 'outputs', 'escape'));
    expect(() => artifacts.capture(join(root, 'outputs'), 'check')).toThrow('UNSAFE_EVALUATOR_ARTIFACT');
  });
});
