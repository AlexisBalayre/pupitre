export type SessionId = string & { readonly __brand: 'SessionId' };
export type TaskId = string & { readonly __brand: 'TaskId' };

/** One hook entry in Claude Code settings.json shape. */
interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookMatcherEntry {
  matcher?: string;
  hooks: HookCommand[];
}

/**
 * A profile layer as authored in YAML (~/.pupitre/<project-id>/profiles/<name>.yml).
 * Base and role layers share this shape; the task layer is generated from a TaskSpec.
 */
export interface ProfileLayer {
  name: string;
  extends?: string;
  conventions?: string;
  skills?: string[];
  subagents?: string[];
  /** Additive only — base hooks can never be removed (docs/03-profiles.md). */
  hooks?: Record<string, HookMatcherEntry[]>;
  mcp?: string[];
  contextBudget?: number;
}

export interface TaskSpec {
  id: TaskId;
  goal: string;
  scopeIn: string[];
  scopeOut?: string[];
  acceptance: string[];
  knowledgeSlice?: string;
}

export interface CompileInput {
  base: ProfileLayer;
  role?: ProfileLayer;
  task: TaskSpec;
  sessionId: SessionId;
  /** Absolute path of the session's git worktree — scope enforcement is relative to it. */
  worktreePath: string;
  /** Absolute path of the JSONL file hook events are appended to. */
  eventsFile: string;
  /** Hash of the user's ~/.claude snapshot at launch (decision 9: drift detection). */
  userConfigHash: string;
  /** Absolute directory the compiled files will live in (hook paths embed it). */
  outDir: string;
  /**
   * Absolute path of the `codegraph` binary when the operator has one. Present
   * compiles `mcp.json` and the context's code-graph section; absent compiles
   * neither, and the session launches with no graph (decision 51).
   */
  codegraphBinary?: string;
}

export interface CompiledProfile {
  /** sha256 over all compiled content + userConfigHash — recorded on the session. */
  hash: string;
  tokenEstimate: number;
  contextBudget: number;
  contextMarkdown: string;
  settings: { hooks: Record<string, HookMatcherEntry[]> };
  /** Relative path -> content, ready to be written under outDir. */
  files: Record<string, string>;
}
