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

    expect(report).toEqual({ duplicatedLines: 0, blocks: [] });
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
