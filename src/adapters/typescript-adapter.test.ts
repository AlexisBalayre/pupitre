import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

describe('typescriptAdapter.depGraph', () => {
  function makeSourceRepo(files: Record<string, string>): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-graph-')));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  it('builds module nodes and edges from relative imports, ESM .js style included', () => {
    const repo = makeSourceRepo({
      'src/cli/index.ts': "import { run } from '../core/run.service.js';\nrun();\n",
      'src/core/run.service.ts':
        "import type { Cfg } from './types/run.types.js';\nexport const run = (c?: Cfg) => c;\n",
      'src/core/types/run.types.ts': 'export interface Cfg { a: number }\n',
    });

    const graph = typescriptAdapter.depGraph?.(repo);

    expect(Object.keys(graph?.modules ?? {}).sort()).toEqual([
      'src/cli',
      'src/core',
      'src/core/types',
    ]);
    expect(graph?.edges).toEqual([
      { from: 'src/cli', to: 'src/core' },
      { from: 'src/core', to: 'src/core/types' },
    ]);
  });

  it('resolves directory index imports and ignores package imports and node_modules', () => {
    const repo = makeSourceRepo({
      'src/app.ts':
        "import { x } from './lib';\nimport ts from 'typescript';\nexport const a = [x, ts];\n",
      'src/lib/index.ts': 'export const x = 1;\n',
      'node_modules/pkg/index.ts': 'export const hidden = 1;\n',
    });

    const graph = typescriptAdapter.depGraph?.(repo);

    expect(Object.keys(graph?.modules ?? {}).sort()).toEqual(['src', 'src/lib']);
    expect(graph?.edges).toEqual([{ from: 'src', to: 'src/lib' }]);
  });

  it('groups top-level files under (root) and skips declaration files', () => {
    const repo = makeSourceRepo({
      'main.ts': "import './helper.js';\n",
      'helper.ts': 'export {};\n',
      'globals.d.ts': 'declare const g: number;\n',
    });

    const graph = typescriptAdapter.depGraph?.(repo);

    expect(graph?.modules).toEqual({ '(root)': ['helper.ts', 'main.ts'] });
    expect(graph?.edges).toEqual([]);
  });
});
