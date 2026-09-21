import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInNestedPackage, isNestedPackageDir } from './typescript-source.utils.js';

function makeCheckout(manifests: string[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-source-')));
  writeFileSync(join(dir, 'package.json'), '{}');
  for (const manifest of manifests) {
    mkdirSync(join(dir, manifest, '..'), { recursive: true });
    writeFileSync(join(dir, manifest), '{}');
  }
  return dir;
}

describe('isNestedPackageDir', () => {
  it('names a directory below the root that holds its own package.json', () => {
    const repo = makeCheckout(['tools/review/package.json']);

    expect(isNestedPackageDir('tools/review', [repo])).toBe(true);
    expect(isNestedPackageDir('tools', [repo])).toBe(false);
  });

  it('never names the measured root itself', () => {
    expect(isNestedPackageDir('', [makeCheckout([])])).toBe(false);
  });

  it('requires the marker in every checkout', () => {
    const worktree = makeCheckout(['src/core/package.json']);
    const trusted = makeCheckout([]);

    expect(isNestedPackageDir('src/core', [worktree, trusted])).toBe(false);
  });
});

describe('isInNestedPackage', () => {
  it('matches a file at any depth inside a nested package and nothing beside it', () => {
    const repo = makeCheckout(['packages/api/package.json']);

    expect(isInNestedPackage('packages/api/src/deep/server.ts', [repo])).toBe(true);
    expect(isInNestedPackage('packages/web/src/app.ts', [repo])).toBe(false);
    expect(isInNestedPackage('main.ts', [repo])).toBe(false);
  });
});
