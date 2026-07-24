import { isAbsolute, relative, sep } from 'node:path';
import type { CoverageReport } from './types/adapter.types.js';
import type { CoveragePyReport } from './types/coverage-py.types.js';

/**
 * Line coverage from coverage.py's JSON report: executed lines are covered,
 * executed plus missing are instrumented (excluded lines never appear in
 * either). Paths are repo-root-relative unless the repo's coverage config says
 * otherwise; absolute entries are re-relativized and outside-repo ones dropped.
 */
export function coveragePyToCoverageReport(
  raw: CoveragePyReport,
  repoPath: string,
): CoverageReport {
  const files: CoverageReport['files'] = {};
  for (const [path, entry] of Object.entries(raw.files)) {
    const file = (isAbsolute(path) ? relative(repoPath, path) : path)
      .split(sep)
      .join('/')
      .replace(/^\.\//, '');
    if (file.startsWith('..')) continue;
    const covered = [...entry.executed_lines].sort((a, b) => a - b);
    const instrumented = [...entry.executed_lines, ...entry.missing_lines].sort((a, b) => a - b);
    files[file] = { covered, instrumented };
  }
  return { files };
}
