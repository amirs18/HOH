import { existsSync, realpathSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, minimalEnv, type ProcessSpec } from './process.js';
import type { Config } from '../core/schemas.js';

const quote = (s: string) => JSON.stringify(s);
const canonical = (s: string) => existsSync(s) ? realpathSync(s) : resolve(s);
export class Isolation {
  trusted = false;
  reason = 'UNTRUSTED: isolation has not been probed';
  constructor(private mode: Config['isolation']) {}
  async probe(): Promise<void> {
    if (this.mode === 'none' || process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
      this.reason = 'UNTRUSTED: macOS sandbox-exec unavailable/disabled; acceptance is forbidden'; return;
    }
    const result = await runCommand({ executable: '/usr/bin/sandbox-exec',
      args: ['-p', '(version 1)(deny default)(allow process-exec)(allow file-read*)(allow sysctl-read)', '/usr/bin/true'], cwd: process.cwd() }, { timeoutMs: 5000 });
    this.trusted = result.exitCode === 0;
    this.reason = this.trusted ? 'macOS sandbox-exec' : `UNTRUSTED: sandbox probe failed: ${result.stderr}`;
  }
  wrap(spec: ProcessSpec, options: { read: string[]; write: string[]; deny?: string[]; network?: boolean }): ProcessSpec {
    if (!this.trusted) throw new Error(this.reason);
    const system = ['/System', '/usr', '/bin', '/sbin', '/Library', '/dev', '/private/etc', '/private/var/db/dyld',
      dirname(dirname(canonical(process.execPath)))];
    // Only dependency assets, never the extension/controller source tree.
    const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules');
    if (existsSync(moduleRoot)) system.push(moduleRoot);
    const read = [...new Set([...system, ...options.read].map(canonical))];
    const write = [...new Set(options.write.map(canonical))];
    const denied = [...new Set((options.deny ?? []).map(canonical))];
    const profile = `(version 1)(deny default)
      (allow process-exec)(allow process-fork)(allow process-info*)(allow signal (target same-sandbox))
      (allow sysctl-read)(allow mach-lookup)
      (allow file-read* (literal "/"))
      (allow file-read-metadata)
      (allow file-read* ${read.map(p => `(subpath ${quote(p)})`).join(' ')})
      ${write.length ? `(allow file-write* ${write.map(p => `(subpath ${quote(p)})`).join(' ')})` : ''}
      (allow file-write-data (literal "/dev/null"))
      ${denied.length ? `(deny file-read* file-write* ${denied.map(p => `(subpath ${quote(p)})`).join(' ')})` : ''}
      ${options.network ? '(allow network-outbound)' : ''}`;
    return { ...spec, executable: '/usr/bin/sandbox-exec', args: ['-p', profile, spec.executable, ...spec.args] };
  }
}
export function scratchEnv(cwd: string): NodeJS.ProcessEnv {
  const scratch = join(cwd, '.hoh-scratch');
  mkdirSync(join(scratch, 'agent'), { recursive: true }); mkdirSync(join(scratch, 'tmp'), { recursive: true });
  return { ...minimalEnv(), HOME: scratch, TMPDIR: join(scratch, 'tmp'), PI_CODING_AGENT_DIR: join(scratch, 'agent'),
    CMUX_PI_HOOKS_DISABLED: '1' };
}
