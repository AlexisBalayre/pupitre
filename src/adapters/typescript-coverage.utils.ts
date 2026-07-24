import { relative, sep } from 'node:path';
import type { CoverageReport } from './types/adapter.types.js';
import type { IstanbulCoverageMap } from './types/istanbul.types.js';

/**
 * Line coverage from istanbul statement data: a line is instrumented when any
 * statement starts on it, covered when any of those statements was hit.
 * Entries resolving outside the repo are dropped.
 */
export function istanbulToCoverageReport(
  raw: IstanbulCoverageMap,
  repoPath: string,
): CoverageReport {
  const files: CoverageReport['files'] = {};
  for (const [absPath, entry] of Object.entries(raw)) {
    const file = relative(repoPath, absPath).split(sep).join('/');
    if (file.startsWith('..')) continue;
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
