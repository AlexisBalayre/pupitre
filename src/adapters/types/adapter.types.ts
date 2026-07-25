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
interface FileLineCoverage {
  covered: number[];
  instrumented: number[];
}

/** Keyed by repo-relative `/`-separated path. */
export interface CoverageReport {
  files: Record<string, FileLineCoverage>;
}

/**
 * The two checkouts a capability works with. They are separate because they are
 * not equally trusted: measurement must happen in the session's worktree, but
 * *which* tools are declared has to come from a checkout the session cannot
 * edit, or a session could silence a debt stage by editing its own manifest
 * (decision 29). Outside the gate — `pup init`, the code map — both are the
 * same path.
 */
export interface CapabilityContext {
  /** Checkout to measure. Session-authored during a merge gate. */
  measurePath: string;
  /** Checkout to read tool declarations from. Never session-writable. */
  configPath: string;
}

/**
 * Why a capability produced no measurement. The reason reaches the operator in
 * the gate report, so it names the tool and what went wrong — a stage that
 * skips silently reads like a stage that passed (decision 29).
 */
export interface CapabilityUnavailable {
  unavailable: string;
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
  depGraph?(ctx: CapabilityContext): DepGraph;
  deadCode?(ctx: CapabilityContext): DeadExport[] | CapabilityUnavailable;
  duplication?(ctx: CapabilityContext): DuplicationReport;
  complexity?(ctx: CapabilityContext, files: string[]): FileComplexity[];
  /** Runs the suite with line coverage. */
  coverage?(ctx: CapabilityContext): CoverageReport | CapabilityUnavailable;
  /**
   * Which of `files` this adapter expects to appear in a coverage report —
   * source the toolchain instruments, excluding tests, which coverage tools
   * omit by default. Without it the gate cannot tell a changed asset (free by
   * construction) from changed code the coverage tool never saw (decision 30).
   */
  coverableFiles?(ctx: CapabilityContext, files: string[]): string[];
}
