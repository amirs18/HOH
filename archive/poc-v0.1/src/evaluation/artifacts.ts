import { mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from '../core/policy.js';

export function redact(text: string, secrets: string[]): string {
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]');
}
export class Artifacts {
  constructor(readonly root: string, private secrets: string[], private maxBytes: number) { mkdirSync(root, { recursive: true, mode: 0o700 }); }
  sanitize(text: string): string { return redact(text, this.secrets); }
  write(relative: string, value: unknown): string {
    const path = join(this.root, relative); mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    // Do not truncate structured evidence. Command and model logs are bounded separately.
    const safe = redact(text, this.secrets);
    writeFileSync(path, typeof value === 'string' ? safe.slice(0, this.maxBytes) : safe, { mode: 0o600, flag: 'wx' }); return path;
  }
  capture(root: string, prefix: string): string[] {
    const paths: string[] = []; let bytes = 0;
    const walk = (dir: string, relative = '') => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name), stat = lstatSync(path), target = join(relative, name);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('UNSAFE_EVALUATOR_ARTIFACT');
        if (stat.isDirectory()) { walk(path, target); continue; }
        bytes += stat.size;
        if (bytes > 50_000_000 || stat.size > 10_000_000 || paths.length >= 100) throw new Error('EVALUATOR_ARTIFACT_LIMIT');
        const destination = join(this.root, prefix, target); mkdirSync(join(destination, '..'), { recursive: true });
        const data = readFileSync(path);
        if (/\.(json|txt|log|md|csv|html|xml|ya?ml|[cm]?js|ts)$/i.test(name))
          writeFileSync(destination, redact(data.toString('utf8'), this.secrets), { flag: 'wx', mode: 0o600 });
        else {
          if (this.secrets.filter(Boolean).some(secret => data.includes(Buffer.from(secret)))) throw new Error('SECRET_IN_BINARY_ARTIFACT');
          writeFileSync(destination, data, { flag: 'wx', mode: 0o600 });
        }
        paths.push(destination);
      }
    };
    walk(root); return paths;
  }
}
export function treeHash(root: string): string {
  if (lstatSync(root).isSymbolicLink()) throw new Error('VERIFIER_ROOT_SYMLINK');
  const files: [string, string][] = [];
  const walk = (dir: string, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), relative = prefix + name, stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`VERIFIER_SYMLINK: ${relative}`);
      if (stat.isDirectory()) walk(path, relative + '/');
      else if (stat.isFile()) files.push([relative, hash(readFileSync(path))]);
      else throw new Error(`VERIFIER_SPECIAL_FILE: ${relative}`);
    }
  };
  walk(root); return hash(files);
}
