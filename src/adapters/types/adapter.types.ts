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
  /**
   * Blocks left uncounted because every location was a test file (decision
   * 39). Optional: an adapter that self-reports its own numbers may omit it,
   * and the gate then simply says nothing about test fixtures.
   */
  excludedTestBlocks?: number;
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
  /**
   * Env names the operator allowed into capability children with `--gate-env`
   * (decision 36). Optional because absence narrows the child's environment
   * rather than widening it — the safe direction for a caller that forgets,
   * unlike the sandbox itself, which no caller can forget because it lives
   * inside the one seam that spawns children.
   */
  gateEnv?: string[];
}

/** A nested package's own script the gate runs for it (decision 59). */
export type NestedPackageStage = 'test' | 'typecheck';

/**
 * A nested package the diff touches. Decision 58 leaves its files out of every
 * root measurement because its own runner covers them; this is what the gate
 * needs to run that runner, and to say what the root stages left out.
 */
export interface NestedPackage {
  /** Repo-relative, `/`-separated directory holding the package's manifest. */
  dir: string;
  /** Every changed file inside the package, deletions included. */
  changedFiles: string[];
  /** The changed source files the root's debt capabilities dropped as nested. */
  droppedSources: string[];
  /** Resolved from the trusted checkout's manifest; run with the package as cwd. */
  commands: { stage: NestedPackageStage; command: string; args: string[] }[];
  /** Stages the trusted manifest declares no script for. */
  missing: NestedPackageStage[];
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
  /**
   * The nested packages `files` touch, which every capability above leaves
   * out: the gate runs their own scripts and names what was dropped
   * (decisions 29, 59). An adapter without it has no nested packages.
   */
  touchedNestedPackages?(ctx: CapabilityContext, files: string[]): NestedPackage[];
}
