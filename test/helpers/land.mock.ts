import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { commitAs, sh } from './git.mock.js';
import { fixtureCopier } from './temp-dir.mock.js';

export { sh } from './git.mock.js';

export function commitIn(dir: string, file: string, content: string): string {
  return commitAs({ email: 'l@test', name: 'land' }, dir, file, content);
}

export const SESSION_ID = 's1';
export const BRANCH = `pup/${SESSION_ID}`;
export const ORIGIN_URL = 'git@github.com:owner/repo.git';
export const PR_URL = 'https://github.com/owner/repo/pull/7';

/**
 * The land tests' repo with its first commit and its GitHub-shaped bare origin
 * (`host/owner/repo.git`, holding `main`), built once per file: call it in a
 * `describe` body or at the top of a file, then call the result per test for
 * that test's own copy. The session's worktree is cut per test, since a
 * worktree records absolute paths.
 */
export function landFixtureCopier(): () => { repo: string; host: string; origin: string } {
  const copy = fixtureCopier(
    'pup-land-',
    (root) => {
      const repo = join(root, 'repo');
      const origin = join(root, 'host', 'owner', 'repo.git');
      mkdirSync(repo);
      mkdirSync(origin, { recursive: true });
      sh(repo, 'git', 'init', '-q', '-b', 'main');
      commitIn(repo, 'src/app.ts', 'export const app = 1;\n');
      sh(origin, 'git', 'init', '-q', '--bare', '-b', 'main');
      sh(repo, 'git', 'remote', 'add', 'origin', ORIGIN_URL);
      sh(repo, 'git', 'push', '-q', origin, 'main');
    },
    'repo',
  );
  return () => {
    const root = copy();
    return {
      repo: join(root, 'repo'),
      host: join(root, 'host'),
      origin: join(root, 'host', 'owner', 'repo.git'),
    };
  };
}
