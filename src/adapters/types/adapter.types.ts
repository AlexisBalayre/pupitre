export type GateStage = 'build' | 'test' | 'lint';

export interface GateCommand {
  stage: GateStage;
  command: string;
  args: string[];
}

/** Module-level import graph: node ids are repo-relative directories. */
export interface DepGraph {
  /** Module id -> repo-relative source files in it. */
  modules: Record<string, string[]>;
  /** Deduplicated `from` imports `to` pairs; self-edges excluded. */
  edges: { from: string; to: string }[];
}

/** An exported symbol no other repo file imports. */
export interface DeadExport {
  file: string;
  exportName: string;
}

/** One duplicated block: every occurrence of the same normalized line window. */
export interface DuplicateBlock {
  locations: { file: string; line: number }[];
}

export interface DuplicationReport {
  /** Normalized source lines that appear in at least one duplicated block. */
  duplicatedLines: number;
  blocks: DuplicateBlock[];
}

export interface FileComplexity {
  file: string;
  /** Decision points (branches, loops, logical operators) across the file. */
  complexity: number;
}

/** 1-based lines holding executable statements; covered is a subset of instrumented. */
export interface FileLineCoverage {
  covered: number[];
  instrumented: number[];
}

/** Keyed by repo-relative `/`-separated path. */
export interface CoverageReport {
  files: Record<string, FileLineCoverage>;
}

/**
 * A toolchain plugin (docs/06-adapters.md): the v1 gate surface plus the v1.1
 * debt-delta capabilities. Commands resolve from the repo's own config first
 * (package.json scripts); adapter defaults are the fallback. A missing stage
 * or debt capability is skipped and reported as "not measured", never
 * silently passed. A missing depGraph degrades the code map, never the gate.
 */
export interface Adapter {
  id: string;
  detect(repoPath: string): boolean;
  gateCommands(repoPath: string): GateCommand[];
  depGraph?(repoPath: string): DepGraph;
  deadCode?(repoPath: string): DeadExport[];
  duplication?(repoPath: string): DuplicationReport;
  complexity?(repoPath: string, files: string[]): FileComplexity[];
  /** Runs the suite with line coverage; undefined when the repo lacks the tooling. */
  coverage?(repoPath: string): CoverageReport | undefined;
}
