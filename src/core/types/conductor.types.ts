import type { Database } from 'better-sqlite3';
import type { ProfileLayer } from './profile.types.js';

export interface StartConductorRequest {
  /** Read, never written: whether a radar is already sweeping is the store's word. */
  db: Database;
  repoPath: string;
  base: ProfileLayer;
  claudeUserDir: string;
  /** The conductor's own model; the default when unset. */
  model?: string;
  /** The model the conductor is told to launch its sessions on; the default when unset. */
  workerModel?: string;
}

export interface ConductorCompileInput {
  base: ProfileLayer;
  repoPath: string;
  projectId: string;
  /** The peer name the conductor's window carries, quoted in its context so it knows itself. */
  conductorName: string;
  workerModel?: string;
  /** Hash of the user's ~/.claude snapshot at launch (decision 9: drift detection). */
  userConfigHash: string;
  /** Absolute directory the compiled files will live in (hook paths embed it). */
  outDir: string;
  /**
   * Absolute path of the `codegraph` binary when the operator has one. Present
   * compiles `mcp.json` and the context's code-graph section; absent compiles
   * neither, and the window opens with no graph (decision 51).
   */
  codegraphBinary?: string;
  /**
   * The conductor's private detached checkout of the merge target — what
   * `mcp.json` pins the served graph to. Never `repoPath`: a live working tree
   * carries untracked files and a session-writable `codegraph.json`, and the
   * conductor is the last reader that should be fed either (decision 51).
   */
  checkoutPath: string;
}

export interface ConductorHandle {
  /** tmux and peer name, `pup-conductor-<project id>`. */
  name: string;
  paneId: string;
  /**
   * The conflict radar's tmux window when this start brought one up, absent
   * when a fresh beat said one was already sweeping. A window that never took
   * its context is not a handle at all: it is rolled back and thrown.
   */
  radarTarget?: string;
}
