import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInNestedPackage, nestedPackageDirs } from './typescript-source.utils.js';

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

/** A git checkout with `committed` in HEAD and `staged` only in the index. */
function makeCheckout(committed: string[], staged: string[] = []): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-source-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: GIT_ENV });
  git('init', '-q');
  writeFiles(dir, ['package.json', ...committed]);
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  writeFiles(dir, staged);
  if (staged.length > 0) git('add', '-A');
  return dir;
}

describe('nestedPackageDirs', () => {
  it('names a directory below the root that commits its own package.json', () => {
    const repo = makeCheckout(['tools/review/package.json']);

    expect(nestedPackageDirs([repo])).toEqual(new Set(['tools/review']));
  });

  it('requires the marker in every checkout', () => {
    const worktree = makeCheckout(['src/core/package.json']);
    const trusted = makeCheckout([]);

    expect(nestedPackageDirs([worktree, trusted])).toEqual(new Set());
  });

  it('ignores a marker that is on disk but untracked in every checkout', () => {
    const worktree = makeCheckout([]);
    const trusted = makeCheckout([]);
    writeFiles(worktree, ['src/core/package.json']);
    writeFiles(trusted, ['src/core/package.json']);

    expect(nestedPackageDirs([worktree, trusted])).toEqual(new Set());
  });

  it('ignores a marker staged but not committed', () => {
    // The main checkout's index is a session's to `git add` to, and nothing
    // checks it for dirt: only HEAD's tree counts.
    const repo = makeCheckout([], ['src/core/package.json']);

    expect(nestedPackageDirs([repo])).toEqual(new Set());
  });

  it('names nothing in a checkout git cannot list', () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'pup-source-')));
    writeFiles(plain, ['tools/review/package.json']);

    expect(nestedPackageDirs([plain])).toEqual(new Set());
  });
});

describe('isInNestedPackage', () => {
  it('matches a file at any depth inside a nested package and nothing beside it', () => {
    const nested = new Set(['packages/api']);

    expect(isInNestedPackage('packages/api/src/deep/server.ts', nested)).toBe(true);
    expect(isInNestedPackage('packages/api-client/src/app.ts', nested)).toBe(false);
    expect(isInNestedPackage('packages/web/src/app.ts', nested)).toBe(false);
    expect(isInNestedPackage('main.ts', nested)).toBe(false);
  });
});
