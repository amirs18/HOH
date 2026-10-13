import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export type ProcessSpec = { executable: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv };
export type ProcessTracker = {
  started(pid: number, identity: string): void;
  ended(pid: number): void;
};
export function resolveExecutable(command: string): string {
  if (isAbsolute(command)) return realpathSync(command);
  if (command.includes('/')) throw new Error('EXECUTABLE_MUST_BE_ABSOLUTE_OR_PATH_NAME');
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(dir, command);
    if (existsSync(path)) return realpathSync(path);
  }
  throw new Error(`EXECUTABLE_NOT_FOUND: ${command}`);
}
export function minimalEnv(): NodeJS.ProcessEnv {
  return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8' };
}
export async function processIdentity(pid: number): Promise<string> {
  return new Promise(resolve => {
    const ps = spawn('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat='], { env: minimalEnv() });
    let data = ''; ps.stdout.on('data', c => { data += c; });
    ps.on('error', () => resolve('')); ps.on('close', () => {
      const parsed = /^(.*\d{4})\s+(\S+)$/.exec(data.trim());
      resolve(parsed && !parsed[2].startsWith('Z') ? parsed[1] : '');
    });
  });
}
export function killGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try { process.kill(process.platform === 'win32' ? pid : -pid, signal); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
}
export async function killRecordedChild(pid: number, identity: string): Promise<void> {
  if (!identity || (await processIdentity(pid)) !== identity) return;
  killGroup(pid, 'SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 200));
  const current = await processIdentity(pid);
  if (!current || current === identity) killGroup(pid, 'SIGKILL');
}
export type ProcessHandle = { child: ChildProcessWithoutNullStreams; registered: Promise<void>; cleanup(): Promise<void> };
export function launch(spec: ProcessSpec, tracker?: ProcessTracker): ProcessHandle {
  const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env ?? minimalEnv(), detached: process.platform !== 'win32', stdio: 'pipe' });
  // Identity is recorded before sending work to an RPC process.
  const registered = child.pid ? processIdentity(child.pid).then(identity => {
    if (child.exitCode === null && child.signalCode === null) tracker?.started(child.pid!, identity);
  }) : Promise.resolve();
  let cleaning: Promise<void> | undefined;
  return { child, registered, cleanup: () => cleaning ??= (async () => {
    if (!child.pid) return;
    killGroup(child.pid);
    await new Promise(resolve => setTimeout(resolve, 100));
    // Kill lingering descendants even if the process-group leader has exited.
    killGroup(child.pid, 'SIGKILL');
    tracker?.ended(child.pid);
  })() };
}
export type CommandOutcome = {
  exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;
  durationMs: number; timedOut: boolean; aborted: boolean; error?: string;
};
export async function runCommand(spec: ProcessSpec, options: { signal?: AbortSignal; timeoutMs: number; maxBytes?: number; tracker?: ProcessTracker }): Promise<CommandOutcome> {
  const start = Date.now(), limit = options.maxBytes ?? 100_000;
  if (options.signal?.aborted) throw new Error('ABORTED');
  const handle = launch(spec, options.tracker);
  let stdout = '', stderr = '', error: string | undefined, timedOut = false, aborted = false;
  handle.child.stdout.setEncoding('utf8'); handle.child.stderr.setEncoding('utf8');
  handle.child.stdout.on('data', c => { stdout = (stdout + c).slice(0, limit); });
  handle.child.stderr.on('data', c => { stderr = (stderr + c).slice(0, limit); });
  const abort = () => { aborted = true; void handle.cleanup(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; void handle.cleanup(); }, options.timeoutMs);
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
    handle.child.on('error', e => { error = e.message; });
    handle.child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
  await handle.registered; await handle.cleanup();
  return { ...result, stdout, stderr, durationMs: Date.now() - start, timedOut, aborted, error };
}
