import { describe, expect, it } from 'vitest';
import { coveragePyToCoverageReport } from './python-coverage.utils.js';

describe('coveragePyToCoverageReport', () => {
  it('merges executed and missing lines into sorted instrumented sets', () => {
    const report = coveragePyToCoverageReport(
      { files: { 'src/app.py': { executed_lines: [3, 1], missing_lines: [2] } } },
      '/repo',
    );

    expect(report.files['src/app.py']).toEqual({
      covered: [1, 3],
      instrumented: [1, 2, 3],
    });
  });

  it('re-relativizes absolute paths and drops entries outside the repo', () => {
    const report = coveragePyToCoverageReport(
      {
        files: {
          '/repo/src/app.py': { executed_lines: [1], missing_lines: [] },
          '/elsewhere/lib.py': { executed_lines: [1], missing_lines: [] },
          './src/cli.py': { executed_lines: [], missing_lines: [4] },
        },
      },
      '/repo',
    );

    expect(Object.keys(report.files)).toEqual(['src/app.py', 'src/cli.py']);
    expect(report.files['src/cli.py']).toEqual({ covered: [], instrumented: [4] });
  });
});
