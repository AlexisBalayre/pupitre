import { describe, expect, it } from 'vitest';
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
