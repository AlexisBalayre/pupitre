import type { CoverageReport } from '../adapters/types/adapter.types.js';
import type { PatchCoverage } from './types/coverage.types.js';

export type { PatchCoverage };

/** Repo-wide covered/instrumented line ratio; undefined when nothing is instrumented. */
export function repoCoverageRatio(report: CoverageReport): number | undefined {
  let covered = 0;
  let instrumented = 0;
  for (const file of Object.values(report.files)) {
    covered += file.covered.length;
    instrumented += file.instrumented.length;
  }
  return instrumented === 0 ? undefined : covered / instrumented;
}

/**
 * Patch coverage (decision 13): only added/modified lines that carry
 * instrumented statements count — types, comments, and config lines are free,
 * as are files coverage never saw (assets, docs).
 */
export function patchCoverage(
  report: CoverageReport,
  addedLines: Record<string, number[]>,
): PatchCoverage {
  const patch: PatchCoverage = { covered: 0, instrumented: 0, uncovered: [] };
  for (const [file, lines] of Object.entries(addedLines)) {
    const fileCoverage = report.files[file];
    if (!fileCoverage) continue;
    const instrumented = new Set(fileCoverage.instrumented);
    const covered = new Set(fileCoverage.covered);
    for (const line of lines) {
      if (!instrumented.has(line)) continue;
      patch.instrumented++;
      if (covered.has(line)) patch.covered++;
      else patch.uncovered.push({ file, line });
    }
  }
  return patch;
}
