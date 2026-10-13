import type { Config, Measurement, Decision } from './model.js';

export type Verdict = Pick<Decision, 'status' | 'metric' | 'goalReached' | 'reason'>;
export function decide(config: Config, measurement: Measurement, best: number | null, baseline = false, previouslyPassed: string[] = []): Verdict {
  const reject = (status: Verdict['status'], reason: string, metric: number | null = null): Verdict => ({ status, metric, reason, goalReached: false });
  const samples = measurement.samples;
  if (!measurement.trusted) return reject('crash', 'UNTRUSTED: protected verification requires OS isolation');
  if (measurement.integrityError) return reject('checks_failed', measurement.integrityError);
  if (samples.length !== config.repeats) return reject('crash', 'Missing repeated measurements');
  if (samples.some(s => s.error || s.measureExit !== 0 || s.metric === null)) return reject('crash', 'Measurement failed, timed out, or lacked a valid primary metric');
  if (samples.some(s => s.checksExit !== 0)) return reject('checks_failed', 'Mandatory regression/backpressure checks failed or are missing');
  if (samples.some(s => config.requirements.some(r => !Object.hasOwn(s.requirements, r.id)))) return reject('checks_failed', 'Missing requirement check results');
  if (samples.some(s => previouslyPassed.some(id => s.requirements[id] !== 'PASS')))
    return reject('checks_failed', 'A previously verified requirement regressed');
  const values = samples.map(s => s.metric!).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2), metric = values.length % 2 ? values[mid] : values[mid - 1] / 2 + values[mid] / 2;
  if (values.at(-1)! - values[0] > config.metric.absoluteTolerance) return reject('unstable', 'Primary metric exceeded repeatability tolerance', metric);
  if (samples.some(s => config.requirements.some(r => s.requirements[r.id] !== samples[0].requirements[r.id])))
    return reject('unstable', 'Requirement outcomes changed across repeats', metric);
  const difference = best === null ? Infinity : config.metric.direction === 'higher' ? metric - best : best - metric;
  const targetMet = config.metric.direction === 'higher' ? metric >= config.metric.target : metric <= config.metric.target;
  const goalReached = targetMet && samples.every(s => config.requirements.every(r => s.requirements[r.id] === 'PASS'));
  if (baseline || best === null || difference > config.metric.minImprovement || (goalReached && previouslyPassed.length < config.requirements.length))
    return { status: 'keep', metric, goalReached, reason: baseline ? 'Verified repeatable baseline' : goalReached ? 'Verified product goal reached' : 'Verified repeatable improvement' };
  return { status: 'discard', metric, goalReached: false, reason: 'Metric did not improve beyond the configured threshold' };
}
