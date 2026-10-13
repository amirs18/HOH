import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, readFileSync, readdirSync, lstatSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, linkSync } from 'node:fs';
import { dirname, join, delimiter, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, type Header, HeaderSchema, type Checkpoint, CheckpointSchema, MeasurementSchema, DecisionSchema } from './model.js';
import { z } from 'zod';

export const baseEnv = (): NodeJS.ProcessEnv => ({ PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8', TZ: 'UTC' });
export function executable(name: string): string {
  if (isAbsolute(name)) return realpathSync(name);
  if (name.includes('/')) throw new Error('Use an absolute executable or a PATH name');
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (existsSync(join(dir, name))) return realpathSync(join(dir, name));
  throw new Error(`EXECUTABLE_NOT_FOUND: ${name}`);
}
export function readJson<T>(path: string, schema: z.ZodType<T>): T {
  if (lstatSync(path).isSymbolicLink()) throw new Error('JSON_SYMLINK');
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`INVALID_JSON: ${path}`); }
  return schema.parse(value);
}
export function writeJson(path: string, value: unknown, immutable = false): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  if (immutable) { linkSync(temp, path); unlinkSync(temp); } else renameSync(temp, path);
  const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function inside(root: string, path: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(path)); return !rel.startsWith('..') && !isAbsolute(rel);
}
export function treeHash(root: string): string {
  const entries: unknown[] = [];
  const walk = (dir: string) => {
    if (lstatSync(dir).isSymbolicLink()) throw new Error('SYMLINK_NOT_SUPPORTED');
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('UNSAFE_FILE');
      if (stat.isDirectory()) walk(path);
      else { if (stat.size > 10000000) throw new Error('FILE_TOO_LARGE'); entries.push([relative(root, path), hash(readFileSync(path))]); }
    }
  };
  walk(root); return hash(entries);
}
export function killGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try { process.kill(-pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
}
export async function birthIdentity(pid: number): Promise<string> {
  const result = await command({ executable: '/bin/ps', args: ['-p', String(pid), '-o', 'lstart=', '-o', 'stat='], cwd: process.cwd(), env: baseEnv() }, 2000, undefined, undefined, false);
  const match = /^(.*\d{4})\s+(\S+)$/.exec(result.stdout.trim()); return match && !match[2].startsWith('Z') ? match[1] : '';
}
export type CommandSpec = { executable: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv };
export type Exit = { code: number | null; stdout: string; stderr: string; error?: string; elapsedMs: number };
export async function command(spec: CommandSpec, timeoutMs: number, signal?: AbortSignal,
  track?: (pid: number, identity: string) => void, cleanupGroup = true): Promise<Exit> {
  signal?.throwIfAborted();
  const start = Date.now(), child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env ?? baseEnv(), detached: cleanupGroup, stdio: 'pipe' });
  let stdout = '', stderr = '', error: string | undefined, stopped = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const bounded = (current: string, extra: string) => {
    if (current.length + extra.length > 1000000) { error = 'OUTPUT_LIMIT'; stop(); }
    return (current + extra).slice(0, 1000000);
  };
  child.stdout.on('data', x => { stdout = bounded(stdout, x); }); child.stderr.on('data', x => { stderr = bounded(stderr, x); });
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { if (!stopped && child.pid) {
    stopped = true; cleanupGroup ? killGroup(child.pid) : child.kill();
    force = setTimeout(() => { if (child.pid) cleanupGroup ? killGroup(child.pid, 'SIGKILL') : child.kill('SIGKILL'); }, 200);
  } };
  const abort = () => { error = 'ABORTED'; stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { error = 'TIMEOUT'; stop(); }, timeoutMs);
  const recorded = child.pid && track ? birthIdentity(child.pid).then(identity => track(child.pid!, identity)) : Promise.resolve();
  const code = await new Promise<number | null>(resolve => {
    child.on('error', e => { error = e.message; });
    child.on('close', (code, exitSignal) => { if (exitSignal) error ??= exitSignal; resolve(code); });
  });
  clearTimeout(timer); if (force) clearTimeout(force); signal?.removeEventListener('abort', abort); await recorded;
  if (child.pid && cleanupGroup) killGroup(child.pid, 'SIGKILL');
  return { code, stdout, stderr, error, elapsedMs: Date.now() - start };
}
export async function git(repo: string, args: string[]): Promise<string> {
  const result = await command({ executable: '/usr/bin/git', args: ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], cwd: repo,
    env: { ...baseEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'HoH', GIT_AUTHOR_EMAIL: 'hoh@localhost', GIT_COMMITTER_NAME: 'HoH', GIT_COMMITTER_EMAIL: 'hoh@localhost' } }, 30000);
  if (result.code !== 0 || result.error) throw new Error(`GIT_FAILED: ${args[0]}: ${result.stderr}`);
  return result.stdout.trimEnd();
}
export class Files {
  readonly root: string;
  constructor(readonly repo: string) {
    this.root = join(realpathSync(repo), '.hoh'); mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (realpathSync(this.root) !== this.root) throw new Error('STATE_DIRECTORY_SYMLINK');
  }
  runDir(id: string): string { if (!z.string().uuid().safeParse(id).success) throw new Error('INVALID_RUN_ID'); return join(this.root, 'runs', id); }
  current(): string | undefined { return existsSync(join(this.root, 'current.json')) ? readJson(join(this.root, 'current.json'), z.object({ id: z.string().uuid() }).strict()).id : undefined; }
  header(id = this.current()!): Header { return readJson(join(this.runDir(id), 'run.json'), HeaderSchema); }
  checkpoint(id = this.current()!): Checkpoint { return readJson(join(this.runDir(id), 'state.json'), CheckpointSchema); }
  save(state: Checkpoint): void { writeJson(join(this.runDir(state.id), 'state.json'), state); }
  trial(id: string, run: number): string { if (!Number.isSafeInteger(run) || run < 0) throw new Error('INVALID_TRIAL'); return join(this.runDir(id), 'experiments', String(run).padStart(4, '0')); }
  records(id: string) {
    const dir = join(this.runDir(id), 'experiments'); if (!existsSync(dir)) return [];
    return readdirSync(dir).sort().filter(n => /^\d{4}$/.test(n) && existsSync(join(dir, n, 'decision.json'))).map(n => ({
      decision: readJson(join(dir, n, 'decision.json'), DecisionSchema), measurement: readJson(join(dir, n, 'measurement.json'), MeasurementSchema),
    }));
  }
  async locked<T>(operation: () => Promise<T>): Promise<T> {
    const lock = join(this.root, 'lease.json'), recovery = join(this.root, 'recovery.guard');
    const Lease = z.object({ pid: z.number().int().positive(), identity: z.string(), token: z.string(), heartbeat: z.number() }).strict();
    if (existsSync(lock)) {
      const old = readJson(lock, Lease);
      if (old.identity && await birthIdentity(old.pid) === old.identity) throw new Error('RUN_LOCKED');
      try { mkdirSync(recovery); } catch { throw new Error('RECOVERY_LOCKED: inspect .hoh/recovery.guard before removing a stale guard'); }
      try {
        if (existsSync(lock)) {
          const current = readJson(lock, Lease);
          if (current.token !== old.token || (current.identity && await birthIdentity(current.pid) === current.identity)) throw new Error('RUN_LOCKED');
          unlinkSync(lock);
        }
      } finally { // No recursive deletion; only this empty controller-created guard.
        const { rmdirSync } = await import('node:fs'); rmdirSync(recovery);
      }
    }
    const token = randomUUID(), lease = { pid: process.pid, identity: await birthIdentity(process.pid), token, heartbeat: Date.now() };
    if (!lease.identity) throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
    const fd = openSync(lock, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(lease)); fsyncSync(fd); } finally { closeSync(fd); }
    const heartbeat = setInterval(() => { lease.heartbeat = Date.now(); writeJson(lock, lease); }, 1000);
    try { return await operation(); } finally { clearInterval(heartbeat); if (readJson(lock, Lease).token === token) unlinkSync(lock); }
  }
}
