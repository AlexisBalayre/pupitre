import { describe, expect, it } from 'vitest';
import { patchCoverage } from '../core/coverage.utils.js';
import { istanbulToCoverageReport } from './typescript-coverage.utils.js';

describe('istanbulToCoverageReport', () => {
  it('maps statement hits to per-line covered/instrumented sets with repo-relative keys', () => {
    const report = istanbulToCoverageReport(
      {
        '/repo/src/a.ts': {
          statementMap: {
            '0': { start: { line: 1 }, end: { line: 1 } },
            '1': { start: { line: 3 }, end: { line: 4 } },
            '2': { start: { line: 3 }, end: { line: 3 } },
          },
          s: { '0': 2, '1': 0, '2': 1 },
        },
      },
      '/repo',
    );

    expect(report.files).toEqual({
      'src/a.ts': { covered: [1, 3], instrumented: [1, 3] },
    });
  });

  it('drops files coverage is not expected for, so the ratio stays source-only', () => {
    // decision 30's --coverage.include overrides vitest's default excludes, so
    // the raw map carries every test file, instrumented and wholly uncovered.
    const report = istanbulToCoverageReport(
      {
        '/repo/src/a.ts': {
          statementMap: { '0': { start: { line: 1 }, end: { line: 1 } } },
          s: { '0': 1 },
        },
        '/repo/src/a.test.ts': {
          statementMap: { '0': { start: { line: 1 }, end: { line: 1 } } },
          s: { '0': 0 },
        },
        '/repo/src/b.spec.ts': {
          statementMap: { '0': { start: { line: 2 }, end: { line: 2 } } },
          s: { '0': 0 },
        },
        '/repo/vitest.config.ts': {
          statementMap: { '0': { start: { line: 1 }, end: { line: 1 } } },
          s: { '0': 0 },
        },
      },
      '/repo',
    );

    expect(Object.keys(report.files)).toEqual(['src/a.ts']);
  });

  it('leaves added test-file lines out of patch coverage entirely', () => {
    // The consequence that bites: patchCoverage counts any added line the
    // report instruments, so a test file left in the report makes writing
    // tests lower a PR's patch coverage.
    const report = istanbulToCoverageReport(
      {
        '/repo/src/a.test.ts': {
          statementMap: {
            '0': { start: { line: 1 }, end: { line: 1 } },
            '1': { start: { line: 2 }, end: { line: 2 } },
          },
          s: { '0': 0, '1': 0 },
        },
      },
      '/repo',
    );

    expect(patchCoverage(report, { 'src/a.test.ts': [1, 2] })).toEqual({
      covered: 0,
      instrumented: 0,
      uncovered: [],
    });
  });

  it('drops another checkout of the same repo under .worktrees', () => {
    // Measuring the main checkout while sessions are open would otherwise count
    // each session's copy of every source file, so the repo ratio would move
    // with how many sessions happen to exist rather than with the code.
    const report = istanbulToCoverageReport(
      {
        '/repo/src/a.ts': {
          statementMap: { '0': { start: { line: 1 }, end: { line: 1 } } },
          s: { '0': 1 },
        },
        '/repo/.worktrees/feature-x/src/a.ts': {
          statementMap: { '0': { start: { line: 1 }, end: { line: 1 } } },
          s: { '0': 0 },
        },
      },
      '/repo',
    );

    expect(Object.keys(report.files)).toEqual(['src/a.ts']);
  });

  it('drops entries outside the repo', () => {
    const report = istanbulToCoverageReport(
      {
        '/elsewhere/b.ts': {
          statementMap: { '0': { start: { line: 1 }, end: { line: 1 } } },
          s: { '0': 1 },
        },
      },
      '/repo',
    );

    expect(report.files).toEqual({});
  });
});
