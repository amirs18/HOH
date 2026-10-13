import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { runCommand, minimalEnv } from './process.js';
import { type Config } from '../core/schemas.js';

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand({ executable: '/usr/bin/git', args: ['-c', 'core.hooksPath=/dev/null', ...args], cwd,
    env: { ...minimalEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'HoH', GIT_AUTHOR_EMAIL: 'hoh@localhost', GIT_COMMITTER_NAME: 'HoH', GIT_COMMITTER_EMAIL: 'hoh@localhost' } }, { timeoutMs: 30_000, maxBytes: 2_000_000 });
  if (result.exitCode !== 0 || result.timedOut || result.error) throw new Error(`GIT_FAILED: ${args[0]}: ${result.stderr || result.error}`);
  return result.stdout.trim();
}
export async function baseline(repo: string): Promise<string> {
  const top = realpathSync(await git(repo, ['rev-parse', '--show-toplevel']));
  if (top !== realpathSync(repo)) throw new Error('PROJECT_ROOT_REQUIRED');
  // Ignore only controller-owned .hoh, even if the user forgot to add it to .gitignore.
  const dirty = await git(repo, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':!.hoh']);
  if (dirty) throw new Error('DIRTY_BASELINE: commit/stash your own changes first; HoH never changes your checkout');
  return git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
}
export const acceptedRef = (runId: string) => `refs/hoh/runs/${runId}/accepted`;
export function assertInside(root: string, path: string): void {
  const rel = relative(realpathSync(root), realpathSync(path));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('PATH_OUTSIDE_CONTROLLER_ROOT');
}
export class Worktrees {
  constructor(readonly repo: string, readonly config: Config) {}
  async create(runId: string, name: string, sha: string): Promise<string> {
    const root = resolve(this.repo, this.config.worktreeRoot);
    // MVP deliberately keeps worktrees under the private controller directory.
    const allowed = resolve(this.repo, '.hoh');
    if (!root.startsWith(allowed + '/')) throw new Error('WORKTREE_ROOT_MUST_BE_UNDER_HOH');
    mkdirSync(root, { recursive: true, mode: 0o700 }); assertInside(allowed, root);
    const path = join(root, runId, name); mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    await git(this.repo, ['worktree', 'add', '--detach', path, sha]); return realpathSync(path);
  }
  async snapshot(cwd: string, parent: string, message: string): Promise<string> {
    await this.assertRevision(cwd, parent);
    if (!this.config.allowSnapshotCommit) throw new Error('SNAPSHOT_NOT_AUTHORIZED: set allowSnapshotCommit to permit controller commits');
    this.assertSafeFiles(cwd);
    await git(cwd, ['add', '--all', '--', '.', ':!.hoh-scratch']);
    const tree = await git(cwd, ['write-tree']);
    return git(cwd, ['commit-tree', tree, '-p', parent, '-m', message]);
  }
  async assertRevision(cwd: string, expected: string): Promise<void> {
    if (!existsSync(cwd)) throw new Error('WORKTREE_MISSING');
    assertInside(join(this.repo, '.hoh'), cwd);
    if ((await git(cwd, ['rev-parse', 'HEAD'])) !== expected) throw new Error('WORKTREE_REVISION_CHANGED');
  }
  assertSafeFiles(cwd: string): void {
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === '.git' || name === '.hoh-scratch') continue;
        const p = join(dir, name), stat = lstatSync(p);
        // Symlinks/submodules are out of scope in MVP; do not let them escape a mount.
        if (stat.isSymbolicLink()) throw new Error(`UNSAFE_SYMLINK: ${relative(cwd, p)}`);
        if (stat.isDirectory()) walk(p);
        else if (!stat.isFile()) throw new Error(`UNSAFE_FILE: ${p}`);
        if (stat.isFile() && stat.size > 10_000_000) throw new Error(`OVERSIZED_FILE: ${p}`);
        if (stat.isFile() && /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(readFileSync(p, 'utf8')))
          throw new Error(`SECRET_IN_CANDIDATE: ${relative(cwd, p)}`);
      }
    };
    walk(cwd);
  }
  async integrity(parent: string, sha: string, protectedPaths: string[]): Promise<string[]> {
    if (!/^[a-f0-9]{40}$/.test(sha)) return ['Invalid candidate SHA'];
    const changes = (await git(this.repo, ['diff', '--name-only', '-z', parent, sha])).split('\0').filter(Boolean);
    const violations = changes.filter(p => protectedPaths.some(protectedPath => p === protectedPath || p.startsWith(protectedPath + '/')));
    const modes = await git(this.repo, ['ls-tree', '-r', sha]);
    if (/^(120000|160000) /m.test(modes)) violations.push('symlinks/submodules are unsupported');
    return violations;
  }
}
