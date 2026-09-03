import { describe, expect, it } from 'vitest';
import { findDeadExports, findDuplication, measureComplexity } from './typescript-debt.utils.js';

describe('findDeadExports', () => {
  it('flags an export no other file imports', () => {
    const dead = findDeadExports(
      {
        'src/a.ts': 'export const used = 1;\nexport const orphan = 2;\n',
        'src/b.ts': "import { used } from './a.js';\nexport const main = used;\n",
        'src/index.ts': "import { main } from './b.js';\nconsole.log(main);\n",
      },
      new Set(['src/index.ts']),
    );

    expect(dead).toEqual([{ file: 'src/a.ts', exportName: 'orphan' }]);
  });

  it('counts an aliased named import as usage of the original name', () => {
    const dead = findDeadExports(
      {
        'src/a.ts': 'export const original = 1;\n',
        'src/b.ts': "import { original as renamed } from './a.js';\nexport const x = renamed;\n",
      },
      new Set(['src/b.ts']),
    );

    expect(dead).toEqual([]);
  });

  it('treats a namespace import as using every export of the target file', () => {
    const dead = findDeadExports(
      {
        'src/a.ts': 'export const one = 1;\nexport const two = 2;\n',
        'src/b.ts': "import * as a from './a.js';\nexport const x = a;\n",
      },
      new Set(['src/b.ts']),
    );

    expect(dead).toEqual([]);
  });

  it('treats `export * from` as using every export of the target file', () => {
    const dead = findDeadExports(
      {
        'src/a.ts': 'export const one = 1;\n',
        'src/index.ts': "export * from './a.js';\n",
      },
      new Set(['src/index.ts']),
    );

    expect(dead).toEqual([]);
  });

  it('resolves the `export { name }` statement form', () => {
    const dead = findDeadExports(
      {
        'src/a.ts': 'const hidden = 1;\nexport { hidden };\n',
      },
      new Set(),
    );

    expect(dead).toEqual([{ file: 'src/a.ts', exportName: 'hidden' }]);
  });

  it('never reports exports from entry or test files but counts their imports as usage', () => {
    const dead = findDeadExports(
      {
        'src/a.ts': 'export const testedOnly = 1;\n',
        'src/a.test.ts': "import { testedOnly } from './a.js';\nexport const fixture = 1;\n",
        'src/index.ts': 'export const cliEntry = 1;\n',
      },
      new Set(['src/index.ts']),
    );

    expect(dead).toEqual([]);
  });

  // The exemption is a hiding place if a name buys it without the runner forcing
  // the file to hold tests. `*.test.ts` is collected and hard-fails the test
  // stage when it holds none; `.spec.` and any test-shaped directory are
  // collected by nothing, so none of them is exempt (decision 39).
  it('still reports dead exports from names the test runner does not collect', () => {
    const dead = findDeadExports(
      {
        'src/a.spec.ts': 'export const claimsToBeASpec = 1;\n',
        'src/core/__tests__/b.ts': 'export const parkedInTestSpace = 1;\n',
        'tests/c.ts': 'export const parkedAtTheRoot = 1;\n',
      },
      new Set(),
    );

    expect(dead).toEqual([
      { file: 'src/a.spec.ts', exportName: 'claimsToBeASpec' },
      { file: 'src/core/__tests__/b.ts', exportName: 'parkedInTestSpace' },
      { file: 'tests/c.ts', exportName: 'parkedAtTheRoot' },
    ]);
  });
});

describe('findDuplication', () => {
  const block = [
    'const first = compute(1);',
    'const second = compute(2);',
    'const third = compute(3);',
    'const fourth = compute(4);',
    'const fifth = compute(5);',
    'const sixth = compute(6);',
  ].join('\n');

  it('reports a block duplicated across two files with both locations', () => {
    const report = findDuplication({
      'src/a.ts': `${block}\n`,
      'src/b.ts': `const unrelated = 0;\n${block}\n`,
    });

    expect(report.duplicatedLines).toBe(12);
    expect(report.blocks).toEqual([
      {
        locations: [
          { file: 'src/a.ts', line: 1 },
          { file: 'src/b.ts', line: 2 },
        ],
      },
    ]);
  });

  it('reports nothing for distinct files', () => {
    const report = findDuplication({
      'src/a.ts': `${block}\n`,
      'src/b.ts': 'const other = 1;\n',
    });

    expect(report).toEqual({ duplicatedLines: 0, blocks: [], excludedTestBlocks: 0 });
  });

  it('ignores blank, punctuation-only, and comment lines when matching', () => {
    const commented = block
      .split('\n')
      .flatMap((line) => ['// filler comment', line, ''])
      .join('\n');
    const report = findDuplication({
      'src/a.ts': `${block}\n`,
      'src/b.ts': `${commented}\n`,
    });

    expect(report.duplicatedLines).toBe(12);
  });

  // A shared type import is the intended way to reuse a contract, and its member
  // list cannot be collapsed. Counting it as duplication flags a PR for doing the
  // right thing, and `--accept-debt` is the only response available to the author.
  const sharedImport = [
    'import type {',
    '  Adapter,',
    '  CapabilityContext,',
    '  CoverageReport,',
    '  DeadExport,',
    '  GateCommand,',
    '  GateStage,',
    "} from './types/adapter.types.js';",
  ].join('\n');

  it('does not count a multi-line import shared by two files as duplication', () => {
    const report = findDuplication({
      'src/a.ts': `${sharedImport}\nconst a = 1;\n`,
      'src/b.ts': `${sharedImport}\nconst b = 2;\n`,
    });

    expect(report).toEqual({ duplicatedLines: 0, blocks: [], excludedTestBlocks: 0 });
  });

  it('still reports a real clone that sits directly below a shared import', () => {
    const report = findDuplication({
      'src/a.ts': `${sharedImport}\n${block}\n`,
      'src/b.ts': `${sharedImport}\n${block}\n`,
    });

    expect(report.duplicatedLines).toBe(12);
  });

  it('does not let a skipped import bridge two non-adjacent code regions', () => {
    // The six lines either side of the import are unique per file; only joining
    // across the removed import could manufacture a matching window.
    const top = ['const p1 = 1;', 'const p2 = 2;', 'const p3 = 3;'].join('\n');
    const bottom = ['const q1 = 1;', 'const q2 = 2;', 'const q3 = 3;'].join('\n');
    const report = findDuplication({
      'src/a.ts': `${top}\n${sharedImport}\n${bottom}\n`,
      'src/b.ts': `${top}\n${sharedImport}\n${bottom}\n`,
    });

    // top+bottom concatenate to exactly one 6-line window, which is a genuine
    // clone of real code — but it must be found once, not inflated by the import.
    expect(report.duplicatedLines).toBe(12);
  });

  // testing.md prescribes a real store and repo *per test* over shared setup,
  // so repeated fixtures are the convention working rather than debt — and the
  // GIT_ENV snippet it publishes is itself exactly one window (decision 39).
  it('does not count a block whose every location is a test file', () => {
    const report = findDuplication({
      'src/a.test.ts': `${block}\n`,
      'src/b.test.ts': `const unrelated = 0;\n${block}\n`,
    });

    expect(report).toEqual({ duplicatedLines: 0, blocks: [], excludedTestBlocks: 1 });
  });

  it('recognises a test under a tests directory by its suffix', () => {
    const report = findDuplication({
      'tests/a.test.ts': `${block}\n`,
      'src/core/__tests__/b.test.ts': `${block}\n`,
    });

    expect(report).toEqual({ duplicatedLines: 0, blocks: [], excludedTestBlocks: 1 });
  });

  // Only the suffix exempts. A directory name buys nothing, because nothing
  // makes a file under it hold tests — so a session cannot mint a test-shaped
  // directory, rooted or nested, and park real duplication out of sight.
  it.each(['tests', 'test', '__tests__', 'src/core/tests', 'src/core/__tests__'])(
    'does not exempt unsuffixed files under %s',
    (dir) => {
      const report = findDuplication({
        [`${dir}/a.ts`]: `${block}\n`,
        [`${dir}/b.ts`]: `${block}\n`,
      });

      expect(report.duplicatedLines).toBe(12);
      expect(report.excludedTestBlocks).toBe(0);
    },
  );

  // The hiding place the rule must not open: moving one copy of a clone into a
  // test file leaves a mixed block, which still counts in full.
  it('still counts a block shared between production code and a test file', () => {
    const report = findDuplication({
      'src/a.ts': `${block}\n`,
      'src/a.test.ts': `${block}\n`,
    });

    expect(report.duplicatedLines).toBe(12);
    expect(report.excludedTestBlocks).toBe(0);
    expect(report.blocks).toEqual([
      {
        locations: [
          { file: 'src/a.test.ts', line: 1 },
          { file: 'src/a.ts', line: 1 },
        ],
      },
    ]);
  });
});

describe('measureComplexity', () => {
  it('counts zero for straight-line code', () => {
    expect(measureComplexity('a.ts', 'const a = 1;\nconst b = a + 1;\n')).toBe(0);
  });

  it('counts branches, loops, ternaries, and logical operators', () => {
    const source = [
      'function f(x: number): number {',
      '  if (x > 0) return x;',
      '  for (let i = 0; i < x; i++) x += i;',
      '  const y = x > 1 && x < 10 ? 1 : 0;',
      '  return y ?? 0;',
      '}',
    ].join('\n');

    expect(measureComplexity('a.ts', source)).toBe(5);
  });
});
