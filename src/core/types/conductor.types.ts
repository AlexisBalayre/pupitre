import type { Database } from 'better-sqlite3';
import type { WindowEnv } from '../../claude/types/session-runtime.types.js';
import type { ProfileLayer } from './profile.types.js';

export interface StartConductorRequest {
  /** Read, never written: whether a radar is already sweeping is the store's word. */
  db: Database;
  repoPath: string;
  base: ProfileLayer;
  /**
   * `--session-env` as the command resolved it, once, where it started: the
   * window's variables and the config dir it hashes and runs on (decision 106).
   */
  windowEnv: WindowEnv;
  /** The conductor's own model; `CONDUCTOR_ROUTE`'s when unset (decision 92). */
  model?: string;
  /** The conductor's own effort; `CONDUCTOR_ROUTE`'s when unset. */
  effort?: string;
  /**
   * The model the conductor is told to launch every session on, an override of
   * the routed one each launch records; unset leaves routing to choose.
   */
  workerModel?: string;
}

export interface ConductorCompileInput {
  base: ProfileLayer;
  repoPath: string;
  projectId: string;
  /** The peer name the conductor's window carries, quoted in its context so it knows itself. */
  conductorName: string;
  workerModel?: string;
  /** Hash of the window's config dir at launch (decisions 9, 106: drift detection). */
  userConfigHash: string;
  /** Absolute directory the compiled files will live in (hook paths embed it). */
  outDir: string;
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
