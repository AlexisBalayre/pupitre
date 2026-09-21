import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localContext } from './capability.utils.js';
import type { DeadExport, DuplicationReport } from './types/adapter.types.js';
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

    const graph = typescriptAdapter.depGraph?.(localContext(repo));

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

    const graph = typescriptAdapter.depGraph?.(localContext(repo));

    expect(Object.keys(graph?.modules ?? {}).sort()).toEqual(['src', 'src/lib']);
    expect(graph?.edges).toEqual([{ from: 'src', to: 'src/lib' }]);
  });

  it('expects coverage only for source files that still exist, never tests or assets', () => {
    const repo = makeSourceRepo({
      'src/app.ts': 'export const a = 1;\n',
      'src/app.test.ts': 'export const spec = 1;\n',
      'src/types.d.ts': 'declare const g: number;\n',
      'README.md': '# docs\n',
    });

    const coverable = typescriptAdapter.coverableFiles?.(localContext(repo), [
      'src/app.ts',
      'src/app.test.ts',
      'src/types.d.ts',
      'README.md',
      // Deleted on this branch: nothing left to cover.
      'src/removed.ts',
    ]);

    expect(coverable).toEqual(['src/app.ts']);
  });

  it('does not expect coverage for what the tooling excludes by default', () => {
    // Otherwise every change to a build config or a test helper is flagged.
    const repo = makeSourceRepo({
      'vitest.config.ts': 'export default {};\n',
      'tests/helper.ts': 'export const h = 1;\n',
      'src/__mocks__/db.ts': 'export const db = 1;\n',
      'src/app.ts': 'export const a = 1;\n',
    });

    const coverable = typescriptAdapter.coverableFiles?.(localContext(repo), [
      'vitest.config.ts',
      'tests/helper.ts',
      'src/__mocks__/db.ts',
      'src/app.ts',
    ]);

    expect(coverable).toEqual(['src/app.ts']);
  });

  it('gives naming no hiding place: only the tools own exclusions are honoured', () => {
    // `config` is a valid role suffix in this repo, and the tools exclude named
    // build configs, not every *.config.*. A blanket rule would let a session
    // park a module at src/payments.config.ts and never be measured.
    const repo = makeSourceRepo({
      'src/payments.config.ts': 'export const rate = 1;\n',
      'src/build/pipeline.ts': 'export const p = 1;\n',
      'src/test/prod.ts': 'export const t = 1;\n',
      'packages/tests/api/server.ts': 'export const s = 1;\n',
    });

    const coverable = typescriptAdapter.coverableFiles?.(localContext(repo), [
      'src/payments.config.ts',
      'src/build/pipeline.ts',
      'src/test/prod.ts',
      'packages/tests/api/server.ts',
    ]);

    expect(coverable).toEqual([
      'src/payments.config.ts',
      'src/build/pipeline.ts',
      'src/test/prod.ts',
      'packages/tests/api/server.ts',
    ]);
  });

  it('groups top-level files under (root) and skips declaration files', () => {
    const repo = makeSourceRepo({
      'main.ts': "import './helper.js';\n",
      'helper.ts': 'export {};\n',
      'globals.d.ts': 'declare const g: number;\n',
    });

    const graph = typescriptAdapter.depGraph?.(localContext(repo));

    expect(graph?.modules).toEqual({ '(root)': ['helper.ts', 'main.ts'] });
    expect(graph?.edges).toEqual([]);
  });
});

describe('typescriptAdapter nested packages', () => {
  // Decision 58: a directory with its own package.json has its own runner, so
  // the root counts none of it. tools/plain has no manifest and is still walked.
  const clone = Array.from({ length: 8 }, (_, i) => `export const v${i} = ${i} * 2;`).join('\n');
  const tree = {
    'package.json': '{}',
    'src/app.ts': "import { p } from '../tools/plain/p.js';\nexport const a = p;\n",
    'tools/plain/p.ts': 'export const p = 1;\nexport const plainDead = 2;\n',
    'tools/plain/clone.ts': `${clone}\n`,
    'tools/review/package.json': '{}',
    'tools/review/src/r.ts': 'export const reviewDead = 1;\n',
    'tools/review/src/clone.ts': `${clone}\n`,
  };

  function makeTree(files: Record<string, string>): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-nested-')));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  it('leaves a nested package out of the walk, dead code, duplication and coverage', () => {
    const ctx = localContext(makeTree(tree));

    expect(Object.keys(typescriptAdapter.depGraph?.(ctx).modules ?? {}).sort()).toEqual([
      'src',
      'tools/plain',
    ]);
    const dead = typescriptAdapter.deadCode?.(ctx) as DeadExport[];
    expect(dead.map((d) => d.file)).not.toContain('tools/review/src/r.ts');
    const duplication = typescriptAdapter.duplication?.(ctx) as DuplicationReport;
    expect(duplication.duplicatedLines).toBe(0);
    expect(
      typescriptAdapter.coverableFiles?.(ctx, ['src/app.ts', 'tools/review/src/r.ts']),
    ).toEqual(['src/app.ts']);
  });

  it('still walks a directory without its own package.json', () => {
    const ctx = localContext(makeTree(tree));

    const dead = typescriptAdapter.deadCode?.(ctx) as DeadExport[];
    expect(dead).toContainEqual({ file: 'tools/plain/p.ts', exportName: 'plainDead' });
    expect(typescriptAdapter.coverableFiles?.(ctx, ['tools/plain/p.ts'])).toEqual([
      'tools/plain/p.ts',
    ]);
  });

  it('counts a nested package the trusted checkout does not have', () => {
    // A package.json is one file a session can write anywhere; a worktree-only
    // marker would buy exemption with `touch src/core/package.json`.
    const measurePath = makeTree(tree);
    const { 'tools/review/package.json': _, ...trusted } = tree;
    const ctx = { measurePath, configPath: makeTree(trusted) };

    const dead = typescriptAdapter.deadCode?.(ctx) as DeadExport[];
    expect(dead).toContainEqual({ file: 'tools/review/src/r.ts', exportName: 'reviewDead' });
    const duplication = typescriptAdapter.duplication?.(ctx) as DuplicationReport;
    expect(duplication.duplicatedLines).toBeGreaterThan(0);
    expect(typescriptAdapter.coverableFiles?.(ctx, ['tools/review/src/r.ts'])).toEqual([
      'tools/review/src/r.ts',
    ]);
  });
});
