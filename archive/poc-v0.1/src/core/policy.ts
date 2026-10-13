import type { CheckResult, Finding, Plan, Config } from './schemas.js';
import { createHash } from 'node:crypto';
export const hash = (value: string | Buffer | object): string => createHash('sha256')
  .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export function acceptance(checks: CheckResult[], findings: Finding[], requirementIds: string[], plan: Plan, config: Config): string[] {
  const reasons = checks.filter(c => c.mandatory && c.status !== 'PASS').map(c => `${c.id}: ${c.status}`);
  for (const id of ['integrity', 'isolation', 'acceptance-suite', 'regression-suite', ...(config.reviewRequired ? ['review'] : [])]) {
    if (!checks.some(c => c.id === id && c.mandatory && c.status === 'PASS')) reasons.push(`${id}: missing mandatory gate`);
  }
  for (const e of config.evaluators.filter(e => e.mandatory &&
    (e.kind !== 'acceptance' || !e.requirementIds.length || e.requirementIds.some(id => requirementIds.includes(id)))))
    if (!checks.some(c => c.id === e.id && c.mandatory && c.status === 'PASS')) reasons.push(`${e.id}: missing`);
  for (const r of plan.contract.requirements.filter(r => requirementIds.includes(r.id))) {
    for (const id of r.verificationIds) {
      const e = config.evaluators.find(e => e.id === id && e.mandatory && e.requirementIds.includes(r.id));
      if (!e || !checks.some(c => c.id === id && c.mandatory && c.status === 'PASS' && c.requirementIds.includes(r.id)))
        reasons.push(`${r.id}: verification ${id} missing`);
    }
  }
  for (const f of findings) if (['critical', 'high'].includes(f.severity)) reasons.push(`${f.id}: ${f.severity} finding`);
  return [...new Set(reasons)];
}
export function failureFingerprint(checks: CheckResult[], findings: Finding[]): string {
  return hash({ checks: checks.filter(c => c.status !== 'PASS').map(c => [c.id, c.status, c.summary]),
    findings: findings.map(f => [f.category, f.severity, f.description]) });
}
export function budgetReason(attempts: number, iterations: number, config: Config): string | undefined {
  if (attempts >= config.maxAttemptsPerTask) return 'Maximum task attempts reached';
  if (iterations >= config.maxTotalIterations) return 'Maximum total iterations reached';
}
