/** The slice of coverage.py's JSON report (`--cov-report=json`) the coverage capability reads. */
interface CoveragePyFileEntry {
  executed_lines: number[];
  missing_lines: number[];
}

/** Keyed by path relative to where coverage ran (the repo root). */
export interface CoveragePyReport {
  files: Record<string, CoveragePyFileEntry>;
}
