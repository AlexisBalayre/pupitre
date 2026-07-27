import { relative, sep } from 'node:path';
import type { CoverageReport } from './types/adapter.types.js';
import type { IstanbulCoverageMap } from './types/istanbul.types.js';
import { isCoverageExcluded } from './typescript-source.utils.js';

/**
 * Line coverage from istanbul statement data: a line is instrumented when any
 * statement starts on it, covered when any of those statements was hit.
 *
 * Entries resolving outside the repo are dropped, and so are files coverage is
 * not expected for. The explicit `--coverage.include` decision 30 passes to make
 * unloaded modules appear as 0%-covered also overrides vitest's default
 * excludes, which pulls every test file into the report as instrumented and
 * wholly uncovered. Left in, they halve the repo ratio and — because
 * `patchCoverage` counts any added line the report instruments — make writing
 * tests *lower* a PR's patch coverage. The same predicate decides what
 * `coverableFiles` expects, so the report and the expectation cannot drift.
 */
export function istanbulToCoverageReport(
  raw: IstanbulCoverageMap,
  repoPath: string,
): CoverageReport {
  const files: CoverageReport['files'] = {};
  for (const [absPath, entry] of Object.entries(raw)) {
    const file = relative(repoPath, absPath).split(sep).join('/');
    if (file.startsWith('..') || isCoverageExcluded(file)) continue;
    const instrumented = new Set<number>();
    const covered = new Set<number>();
    for (const [id, location] of Object.entries(entry.statementMap)) {
      const line = location.start.line;
      instrumented.add(line);
      if ((entry.s[id] ?? 0) > 0) covered.add(line);
    }
    files[file] = {
      covered: [...covered].sort((a, b) => a - b),
      instrumented: [...instrumented].sort((a, b) => a - b),
    };
  }
  return { files };
}
