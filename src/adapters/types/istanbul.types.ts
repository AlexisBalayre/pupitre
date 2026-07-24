/** The slice of istanbul's coverage-final.json the coverage capability reads. */
interface IstanbulFileEntry {
  statementMap: Record<string, { start: { line: number }; end: { line: number } }>;
  /** Statement id -> hit count. */
  s: Record<string, number>;
}

/** Keyed by absolute file path. */
export type IstanbulCoverageMap = Record<string, IstanbulFileEntry>;
