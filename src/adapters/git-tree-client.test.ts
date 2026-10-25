import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutPinned } from '../core/git-diff.client.js';
import { tempDir } from '../test/temp-dir.mock.js';
import { localContext } from './capability.utils.js';
import { nestedPackageDirs } from './git-tree.client.js';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function writeFiles(dir: string, files: string[]): void {
  for (const name of files) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), '{}');
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV });

/** A git checkout with `committed` in HEAD and `staged` only in the index. */
function makeCheckout(committed: string[], staged: string[] = []): string {
  const dir = tempDir('pup-source-');
  git(dir, 'init', '-q');
  writeFiles(dir, ['package.json', ...committed]);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  writeFiles(dir, staged);
  if (staged.length > 0) git(dir, 'add', '-A');
  return dir;
}

describe('nestedPackageDirs', () => {
  it('names a directory below the root that commits its own package.json', () => {
    const repo = makeCheckout(['tools/review/package.json']);

    expect(nestedPackageDirs(localContext(repo))).toEqual(new Set(['tools/review']));
  });

  it('requires the marker in every checkout', () => {
    const worktree = makeCheckout(['src/core/package.json']);
    const trusted = makeCheckout([]);

    expect(nestedPackageDirs({ measurePath: worktree, configPath: trusted })).toEqual(new Set());
  });

  it('ignores a marker that is on disk but untracked in every checkout', () => {
    const worktree = makeCheckout([]);
    const trusted = makeCheckout([]);
    writeFiles(worktree, ['src/core/package.json']);
    writeFiles(trusted, ['src/core/package.json']);

    expect(nestedPackageDirs({ measurePath: worktree, configPath: trusted })).toEqual(new Set());
  });

  it('ignores a marker staged but not committed', () => {
    const repo = makeCheckout([], ['src/core/package.json']);

    expect(nestedPackageDirs(localContext(repo))).toEqual(new Set());
  });

  it('names nothing in a checkout git cannot list', () => {
    const plain = tempDir('pup-source-');
    writeFiles(plain, ['tools/review/package.json']);

    expect(nestedPackageDirs(localContext(plain))).toEqual(new Set());
  });

  // The gate's checkout keeps its HEAD and `commondir` in an admin dir under
  // `<common>/worktrees/`, which a session can rewrite from inside the sandbox
  // once the cut is checked. Read through it, a HEAD at another commit changes
  // the measured set, one git refuses to open empties it, and a `commondir`
  // naming a repo of the session's reads its config: a promisor remote whose
  // `uploadpack` runs on the lazy fetch of the commit that repo lacks
  // (decision 101).
  it.each([
    ['its HEAD moved to a commit without the marker', 'HEAD', (before: string) => before],
    ['its HEAD rewritten to what git refuses to open', 'HEAD', () => 'garbage'],
    ["its commondir naming a repo of the session's", 'commondir', () => 'PLANTED'],
  ])('lists the sha a gate checkout was cut at, with %s', (_, pointer, content) => {
    const trusted = makeCheckout([]);
    const before = git(trusted, 'rev-parse', 'HEAD').toString().trim();
    writeFiles(trusted, ['tools/review/package.json']);
    git(trusted, 'add', '-A');
    git(trusted, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'nested');
    const cut = git(trusted, 'rev-parse', 'HEAD').toString().trim();
    const checkout = join(tempDir('pup-gate-'), 'checkout');
    git(trusted, 'worktree', 'add', '-q', '--detach', '--no-checkout', checkout, cut);
    const admin = checkoutPinned(trusted, checkout, cut).GIT_DIR;
    const fired = join(tempDir('pup-marker-'), 'fired');
    const planted = tempDir('pup-planted-');
    git(planted, 'init', '-q');
    for (const [key, value] of [
      ['core.repositoryformatversion', '1'],
      ['extensions.partialClone', 'evil'],
      ['remote.evil.promisor', 'true'],
      ['remote.evil.url', trusted],
      ['remote.evil.uploadpack', `sh -c 'echo pwned >> ${fired}; exit 1' --`],
    ] as const) {
      git(planted, 'config', key, value);
    }
    writeFileSync(
      join(admin, pointer),
      `${content(before).replace('PLANTED', join(planted, '.git'))}\n`,
    );
    // The rewrite is live: read through the checkout, the marker is gone.
    expect(nestedPackageDirs(localContext(checkout))).toEqual(new Set());
    if (existsSync(fired)) unlinkSync(fired);

    expect(
      nestedPackageDirs({ measurePath: checkout, configPath: trusted, measureSha: cut }),
    ).toEqual(new Set(['tools/review']));
    expect(existsSync(fired)).toBe(false);
  });
});
