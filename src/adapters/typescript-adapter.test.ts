import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { typescriptAdapter } from './typescript.adapter.js';

function makeRepo(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-adapter-')));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('typescriptAdapter', () => {
  it('detects a repo with a typescript devDependency', () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ devDependencies: { typescript: '^5' } }),
    });
    expect(typescriptAdapter.detect(repo)).toBe(true);
  });

  it('does not detect a repo without package.json', () => {
    expect(typescriptAdapter.detect(makeRepo({}))).toBe(false);
  });

  it("resolves the repo's own scripts through the detected package manager", () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({
        scripts: { build: 'tsc', test: 'vitest run', lint: 'biome check .' },
      }),
      'pnpm-lock.yaml': '',
    });
    expect(typescriptAdapter.gateCommands(repo)).toEqual([
      { stage: 'build', command: 'pnpm', args: ['run', 'build'] },
      { stage: 'test', command: 'pnpm', args: ['run', 'test'] },
      { stage: 'lint', command: 'pnpm', args: ['run', 'lint'] },
    ]);
  });

  it('falls back to tsc --noEmit for build and omits unmeasurable stages', () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ devDependencies: { typescript: '^5' } }),
      'tsconfig.json': '{}',
    });
    expect(typescriptAdapter.gateCommands(repo)).toEqual([
      { stage: 'build', command: 'npx', args: ['--no-install', 'tsc', '--noEmit'] },
    ]);
  });

  it('emits no build fallback when typescript is not a declared dependency', () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ private: true }),
      'tsconfig.json': '{}',
    });
    expect(typescriptAdapter.gateCommands(repo)).toEqual([]);
  });
});
