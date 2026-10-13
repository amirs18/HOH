import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { CheckResult, Config } from '../core/schemas.js';
import { Isolation, scratchEnv } from '../infra/isolation.js';
import { resolveExecutable, runCommand, type ProcessTracker } from '../infra/process.js';
import { Artifacts } from './artifacts.js';

export async function commandCheck(command: Config['evaluators'][number], context: {
  candidate: string; verifier: string; artifacts: Artifacts; scratch: string; isolation: Isolation;
  config: Config; signal: AbortSignal; tracker?: ProcessTracker;
}): Promise<CheckResult> {
  const { candidate, verifier, artifacts, isolation, config, signal, tracker } = context;
  const scratch = join(context.scratch, command.id); mkdirSync(scratch, { recursive: true });
  const substitute = (s: string) => s.replaceAll('{candidate}', candidate).replaceAll('{evaluation}', verifier).replaceAll('{scratch}', scratch);
  const paths: string[] = [];
  try {
    if (!config.allowlistedExecutables.includes(command.executable)) throw new Error('EXECUTABLE_NOT_ALLOWLISTED');
    const executable = resolveExecutable(command.executable);
    const args = command.args.map(substitute);
    paths.push(artifacts.write(`${command.id}.command.json`, { executable, args, cwd: verifier }));
    const outputDir = join(scratch, 'outputs'); mkdirSync(outputDir);
    const env = { ...scratchEnv(scratch), HOH_CANDIDATE: candidate, HOH_EVALUATION: verifier, HOH_ARTIFACTS: outputDir };
    const spec = isolation.wrap({ executable, args, cwd: verifier, env }, {
      read: [candidate, verifier, scratch, executable], write: [scratch], deny: [join(candidate, '.git')],
      network: command.kind === 'browser',
    });
    const result = await runCommand(spec, { timeoutMs: command.timeoutMs ?? config.timeoutMs, signal, tracker, maxBytes: config.maxLogBytes });
    paths.push(artifacts.write(`${command.id}.stdout.log`, result.stdout));
    paths.push(artifacts.write(`${command.id}.stderr.log`, result.stderr));
    paths.push(...artifacts.capture(outputDir, `${command.id}.artifacts`));
    const status = result.timedOut || result.aborted || result.signal || result.error || result.exitCode === null ? 'ERROR' : result.exitCode === 0 ? 'PASS' : 'FAIL';
    const failure = (result.stderr || result.stdout).replaceAll(candidate, '{candidate}').replaceAll(verifier, '{evaluation}').replaceAll(scratch, '{scratch}').slice(0, 1500);
    return { id: command.id, requirementIds: command.requirementIds, mandatory: command.mandatory, status,
      exitCode: result.exitCode ?? undefined, durationMs: result.durationMs,
      summary: artifacts.sanitize(result.timedOut ? 'Evaluator timed out' : result.aborted ? 'Evaluator aborted' : result.error ?? `Exit ${result.exitCode}${result.signal ? ` (${result.signal})` : ''}${status === 'FAIL' ? `: ${failure}` : ''}`),
      evidencePaths: paths };
  } catch (e) {
    return { id: command.id, requirementIds: command.requirementIds, mandatory: command.mandatory, status: 'ERROR',
      durationMs: 0, summary: artifacts.sanitize((e as Error).message), evidencePaths: paths };
  }
}
