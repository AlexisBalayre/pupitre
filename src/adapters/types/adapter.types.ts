export type GateStage = 'build' | 'test' | 'lint';

export interface GateCommand {
  stage: GateStage;
  command: string;
  args: string[];
}

/**
 * A toolchain plugin (docs/06-adapters.md), slimmed to the v1 gate surface.
 * Commands resolve from the repo's own config first (package.json scripts);
 * adapter defaults are the fallback. A missing stage is skipped and reported
 * as "not measured", never silently passed.
 */
export interface Adapter {
  id: string;
  detect(repoPath: string): boolean;
  gateCommands(repoPath: string): GateCommand[];
}
