import { mkdirSync, cpSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git, writeJson } from '../src/io.js';
import { ConfigSchema, type Config } from '../src/model.js';
export const config = (extra: Record<string, unknown> = {}): Config => ConfigSchema.parse({
  name: 'Arithmetic completeness', metric: { name: 'requirements_passed', direction: 'higher', target: 2 },
  measure: { executable: process.execPath, args: ['{evaluation}/measure.mjs'] },
  checks: { executable: process.execPath, args: ['{evaluation}/checks.mjs'] },
  requirements: [{ id: 'R1', statement: 'Sum positive operands' }, { id: 'R2', statement: 'Sum negative and zero operands' }],
  scope: ['app.mjs'], allowlistedExecutables: [process.execPath], timeoutMs: 5000, maxIterations: 5, maxNoProgress: 3, ...extra,
});
export async function fixture(extra: Record<string, unknown> = {}): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'hoh-v2-'));
  cpSync(resolve('test/fixtures/app'), repo, { recursive: true }); writeFileSync(join(repo, '.gitignore'), '.hoh/\n');
  await git(repo, ['init', '-b', 'main']); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'Defective baseline']);
  mkdirSync(join(repo, '.hoh'), { recursive: true }); cpSync(resolve('test/fixtures/evaluation'), join(repo, '.hoh/evaluation'), { recursive: true });
  writeJson(join(repo, '.hoh/config.json'), config(extra)); return repo;
}
export const edit = (cwd: string, add: string, multiply = 'a*b') => writeFileSync(join(cwd, 'app.mjs'), `export function add(a,b){return ${add};}\nexport function multiply(a,b){return ${multiply};}\n`);
