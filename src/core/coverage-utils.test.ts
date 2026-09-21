import { describe, expect, it } from 'vitest';
import type { CoverageReport } from '../adapters/types/adapter.types.js';
import { patchCoverage, repoCoverageRatio, withoutFiles } from './coverage.utils.js';

const report: CoverageReport = {
  files: {
    'src/a.ts': { covered: [1, 3], instrumented: [1, 2, 3] },
    'src/b.ts': { covered: [], instrumented: [5] },
  },
};

describe('repoCoverageRatio', () => {
  it('divides covered by instrumented lines across all files', () => {
    expect(repoCoverageRatio(report)).toBe(0.5);
  });

  it('is undefined when nothing is instrumented', () => {
    expect(repoCoverageRatio({ files: {} })).toBeUndefined();
    expect(
      repoCoverageRatio({ files: { 'a.ts': { covered: [], instrumented: [] } } }),
    ).toBeUndefined();
  });
});

describe('patchCoverage', () => {
  it('counts only added lines that carry instrumented statements', () => {
    const patch = patchCoverage(report, { 'src/a.ts': [1, 2, 4], 'src/b.ts': [5] });

    expect(patch.instrumented).toBe(3);
    expect(patch.covered).toBe(1);
    expect(patch.uncovered).toEqual([
      { file: 'src/a.ts', line: 2 },
      { file: 'src/b.ts', line: 5 },
    ]);
  });

  it('ignores files coverage never saw', () => {
    const patch = patchCoverage(report, { 'docs/readme.md': [1, 2, 3] });

    expect(patch).toEqual({ covered: 0, instrumented: 0, uncovered: [] });
  });
});

describe('withoutFiles', () => {
  it('drops exactly the files the predicate names', () => {
    expect(withoutFiles(report, (file) => file === 'src/b.ts')).toEqual({
      files: { 'src/a.ts': { covered: [1, 3], instrumented: [1, 2, 3] } },
    });
  });
});
