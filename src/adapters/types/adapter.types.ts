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

/**
 * A toolchain plugin (docs/06-adapters.md), slimmed to the v1 gate surface.
 * Commands resolve from the repo's own config first (package.json scripts);
 * adapter defaults are the fallback. A missing stage is skipped and reported
 * as "not measured", never silently passed. A missing depGraph degrades the
 * code map, never the gate.
 */
export interface Adapter {
  id: string;
  detect(repoPath: string): boolean;
  gateCommands(repoPath: string): GateCommand[];
  depGraph?(repoPath: string): DepGraph;
}
