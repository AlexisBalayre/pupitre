import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localContext } from '@src/adapters/capability.utils.js';
import { nestedPackageDirs } from '@src/adapters/git-tree.client.js';
import { checkoutPinned } from '@src/core/git-diff.client.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { describe, expect, it } from 'vitest';

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

  // A session can write the trusted checkout's `.git/config`, and a
  // `core.worktree` aimed at its parent runs git there from `repo/`: a plain
  // `ls-tree` lists nothing, and no nested package runs its own stages
  // (decision 161).
  it('names every nested package with the shared config aiming core.worktree at a parent', () => {
    const repo = join(tempDir('pup-host-'), 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFiles(repo, ['package.json', 'tools/review/package.json']);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    const sha = git(repo, 'rev-parse', 'HEAD').toString().trim();
    git(repo, 'config', 'core.worktree', dirname(repo));
    // The control: armed, a plain listing of the commit holds nothing.
    expect(git(repo, 'ls-tree', '-r', '--name-only', sha).toString()).toBe('');

    expect(nestedPackageDirs(localContext(repo))).toEqual(new Set(['tools/review']));
    expect(
      nestedPackageDirs({ measurePath: repo, configPath: repo, measureSha: sha, configSha: sha }),
    ).toEqual(new Set(['tools/review']));
  });

  it('names nothing in a directory that is no repository', () => {
    const plain = tempDir('pup-source-');
    writeFiles(plain, ['tools/review/package.json']);

    expect(nestedPackageDirs(localContext(plain))).toEqual(new Set());
  });

  it('names nothing in a repository with no commit yet', () => {
    const fresh = tempDir('pup-source-');
    git(fresh, 'init', '-q');
    writeFiles(fresh, ['tools/review/package.json']);

    expect(nestedPackageDirs(localContext(fresh))).toEqual(new Set());
  });

  // A session can make the trusted listing alone fail, for as long as it runs,
  // and mend the cause before the gate's last check: an empty trusted set
  // would run no nested package's own stages, so the failure throws and the
  // gate refuses (decision 161).
  it('throws when the trusted listing fails under a .git/config git cannot parse', () => {
    const trusted = makeCheckout(['tools/review/package.json']);
    const cut = git(trusted, 'rev-parse', 'HEAD').toString().trim();
    const checkout = join(tempDir('pup-gate-'), 'checkout');
    git(trusted, 'worktree', 'add', '-q', '--detach', '--no-checkout', checkout, cut);
    writeFileSync(join(trusted, '.git', 'config'), '[core\n');

    expect(() =>
      nestedPackageDirs({
        measurePath: checkout,
        configPath: trusted,
        measureSha: cut,
        configSha: cut,
      }),
    ).toThrow(/ls-tree/);
    expect(() => nestedPackageDirs(localContext(trusted))).toThrow(/ls-tree/);
  });

  // A context pinning one sha alone would list the other side at a HEAD the
  // session can move: the cut alone reads the trusted checkout there, the
  // target alone reads the gate's checkout through its admin dir (decision 161).
  it.each([
    ['the cut', 'measureSha'],
    ['the target', 'configSha'],
  ] as const)('refuses a gate context that pins %s alone', (_, key) => {
    const trusted = makeCheckout(['tools/review/package.json']);
    const cut = git(trusted, 'rev-parse', 'HEAD').toString().trim();
    const checkout = join(tempDir('pup-gate-'), 'checkout');
    git(trusted, 'worktree', 'add', '-q', '--detach', '--no-checkout', checkout, cut);

    expect(() =>
      nestedPackageDirs({ measurePath: checkout, configPath: trusted, [key]: cut }),
    ).toThrow(/pins one and not the other/);
  });

  // At the gate one path still holds two commits: the trusted listing at the
  // target is the AND's other half even where measurePath is configPath.
  it('lists the target sha too when a gate context names one checkout', () => {
    const repo = makeCheckout([]);
    const target = git(repo, 'rev-parse', 'HEAD').toString().trim();
    writeFiles(repo, ['tools/review/package.json']);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'nested');
    const cut = git(repo, 'rev-parse', 'HEAD').toString().trim();

    expect(
      nestedPackageDirs({
        measurePath: repo,
        configPath: repo,
        measureSha: cut,
        configSha: target,
      }),
    ).toEqual(new Set());
  });

  // A session can detach the trusted checkout's `.git/HEAD` to a commit with no
  // nested marker while the listing runs and restore it before the gate's last
  // check: listed at HEAD, no nested package's own stages would run.
  it('lists the trusted checkout at the target sha the gate pinned, not at its HEAD', () => {
    const trusted = makeCheckout([]);
    const before = git(trusted, 'rev-parse', 'HEAD').toString().trim();
    writeFiles(trusted, ['tools/review/package.json']);
    git(trusted, 'add', '-A');
    git(trusted, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'nested');
    const target = git(trusted, 'rev-parse', 'HEAD').toString().trim();
    const checkout = join(tempDir('pup-gate-'), 'checkout');
    git(trusted, 'worktree', 'add', '-q', '--detach', '--no-checkout', checkout, target);
    git(trusted, 'checkout', '-q', '--detach', before);
    // The control: listed at its HEAD, the trusted side holds no marker.
    expect(nestedPackageDirs(localContext(trusted))).toEqual(new Set());

    expect(
      nestedPackageDirs({
        measurePath: checkout,
        configPath: trusted,
        measureSha: target,
        configSha: target,
      }),
    ).toEqual(new Set(['tools/review']));
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
    // The rewrite is live: read through the checkout, the marker is gone or
    // the listing fails.
    let through: Set<string>;
    try {
      through = nestedPackageDirs(localContext(checkout));
    } catch {
      through = new Set();
    }
    expect(through).toEqual(new Set());
    if (existsSync(fired)) unlinkSync(fired);

    expect(
      nestedPackageDirs({
        measurePath: checkout,
        configPath: trusted,
        measureSha: cut,
        configSha: cut,
      }),
    ).toEqual(new Set(['tools/review']));
    expect(existsSync(fired)).toBe(false);
  });
});
