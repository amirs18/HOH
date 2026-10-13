import { mkdirSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Config, type Header, type Measurement, type Sample } from './model.js';
import { baseEnv, command, executable, git, treeHash, type CommandSpec } from './io.js';

/** Derived from pi-autoresearch's METRIC parser; reject ambiguity rather than last-value-wins. */
export function parseOutput(output: string): { metrics: Record<string, number>; requirements: Record<string, 'PASS' | 'FAIL'> } {
  const metrics: Record<string, number> = {}, requirements: Record<string, 'PASS' | 'FAIL'> = {};
  for (const line of output.split('\n').map(s => s.replace(/\r$/, ''))) {
    if (!/^(METRIC|CHECK)(?:\s|$)/.test(line)) continue;
    const metric = /^METRIC\s+([\w.µ]+)=([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*$/.exec(line);
    const check = /^CHECK\s+([A-Za-z][\w.-]*)=(PASS|FAIL)\s*$/.exec(line);
    if (metric) {
      const [, key, raw] = metric, number = Number(raw);
      if (['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(metrics, key) || !Number.isFinite(number)) throw new Error('AMBIGUOUS_OR_INVALID_METRIC');
      metrics[key] = number;
    } else if (check) {
      const [, key, value] = check;
      if (['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(requirements, key)) throw new Error('AMBIGUOUS_CHECK');
      requirements[key] = value as 'PASS' | 'FAIL';
    } else throw new Error('MALFORMED_MEASUREMENT_PROTOCOL');
  }
  return { metrics, requirements };
}
export class Sandbox {
  trusted = false;
  async probe(): Promise<void> {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return;
    const p = '(version 1)(deny default)(allow process-exec)(allow file-read*)(allow sysctl-read)';
    const result = await command({ executable: '/usr/bin/sandbox-exec', args: ['-p', p, '/usr/bin/true'], cwd: process.cwd() }, 2000);
    this.trusted = result.code === 0 && !result.error;
  }
  wrap(spec: CommandSpec, read: string[], scratch: string, denied: string[]): CommandSpec {
    if (!this.trusted) throw new Error('UNTRUSTED: macOS sandbox unavailable');
    const canon = (p: string) => existsSync(p) ? realpathSync(p) : resolve(p);
    const roots = ['/System', '/usr', '/bin', '/sbin', '/Library', '/dev', '/private/etc', '/private/var/db/dyld',
      dirname(dirname(realpathSync(process.execPath))), resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules'), ...read].map(canon);
    const clauses = (paths: string[]) => paths.map(p => `(subpath ${JSON.stringify(p)})`).join(' ');
    const profile = `(version 1)(deny default)(allow process-exec)(allow process-fork)(allow process-info*)
      (allow signal (target same-sandbox))(allow sysctl-read)(allow mach-lookup)
      (allow file-read-metadata)(allow file-read* (literal "/") ${clauses(roots)})
      (allow file-write* (subpath ${JSON.stringify(canon(scratch))}))(allow file-write-data (literal "/dev/null"))
      (deny file-read* file-write* ${clauses(denied.map(canon))})`;
    return { ...spec, executable: '/usr/bin/sandbox-exec', args: ['-p', profile, spec.executable, ...spec.args] };
  }
}
export async function measure(header: Header, run: number, candidateSha: string, candidate: string,
  trialDir: string, verifier: string, signal: AbortSignal, track: (pid: number, identity: string) => void,
  integrityError?: string): Promise<Measurement> {
  const startedAt = new Date().toISOString(), config = header.config, sandbox = new Sandbox(); await sandbox.probe();
  const result: Measurement = { version: 1, run, candidateSha, specHash: header.specHash, configHash: header.configHash,
    verifierHash: header.verifierHash, samples: [], integrityError, trusted: sandbox.trusted, startedAt, finishedAt: startedAt };
  if (treeHash(verifier) !== header.verifierHash) result.integrityError = 'Protected verifier assets changed';
  if (!sandbox.trusted || result.integrityError) { result.finishedAt = new Date().toISOString(); return result; }
  for (let n = 0; n < config.repeats; n++) {
    signal.throwIfAborted();
    const dir = join(trialDir, `sample-${n + 1}`), scratch = join(dir, 'scratch'); mkdirSync(scratch, { recursive: true });
    const sample: Sample = { metric: null, metrics: {}, requirements: {}, measureExit: null, checksExit: null, evidence: [] };
    const invoke = async (kind: 'measure' | 'checks') => {
      const configCommand = config[kind];
      if (!config.allowlistedExecutables.includes(configCommand.executable)) throw new Error('EXECUTABLE_NOT_ALLOWLISTED');
      const replace = (s: string) => s.replaceAll('{candidate}', candidate).replaceAll('{evaluation}', verifier).replaceAll('{scratch}', scratch);
      const spec = { executable: executable(configCommand.executable), args: configCommand.args.map(replace), cwd: verifier,
        env: { ...baseEnv(), HOME: scratch, TMPDIR: scratch, HOH_CANDIDATE: candidate, HOH_ARTIFACTS: scratch,
          HOH_SEED: String(config.seed), PYTHONHASHSEED: String(config.seed), HOH_REPEAT: String(n + 1) } };
      const record = join(dir, `${kind}.command.json`); writeFileSync(record, JSON.stringify({ executable: spec.executable, args: spec.args, seed: config.seed }, null, 2));
      const exit = await command(sandbox.wrap(spec, [candidate, verifier, spec.executable], scratch, [join(candidate, '.git')]), config.timeoutMs, signal, track);
      const stdout = join(dir, `${kind}.stdout.log`), stderr = join(dir, `${kind}.stderr.log`);
      writeFileSync(stdout, exit.stdout); writeFileSync(stderr, exit.stderr); sample.evidence.push(record, stdout, stderr);
      if (exit.error) sample.error = exit.error;
      if (exit.code !== 0 || exit.error) sample.diagnostic = (exit.stderr || exit.stdout).slice(-3000);
      return exit;
    };
    try {
      const measured = await invoke('measure'); sample.measureExit = measured.code;
      if (measured.code === 0 && !measured.error) {
        const parsed = parseOutput(measured.stdout); sample.metrics = parsed.metrics; sample.requirements = parsed.requirements;
        sample.metric = parsed.metrics[config.metric.name] ?? null;
        const checked = await invoke('checks'); sample.checksExit = checked.code;
      }
    } catch (e) { sample.error = (e as Error).message; }
    result.samples.push(sample);
    if (signal.aborted) break;
  }
  if (treeHash(verifier) !== header.verifierHash) result.integrityError = 'Verifier assets mutated during evaluation';
  if (await git(candidate, ['status', '--porcelain', '--untracked-files=all'])) result.integrityError = 'Frozen candidate mutated during evaluation';
  result.finishedAt = new Date().toISOString(); return result;
}
