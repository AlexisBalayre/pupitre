import type { ExecFileSyncOptions } from 'node:child_process';
export interface DiffFileStat {
  path: string;
  /** null for binary files (git reports `-`). */
  added: number | null;
  deleted: number | null;
}

/** What turned per-worktree config on: the file, the extension, or a value git cannot read. */
export type WorktreeConfigCause = 'file' | 'on' | 'unreadable';

/** The three variables that pin git to a session worktree's trusted dirs (decision 101). */
export interface WorktreeGitEnv {
  GIT_DIR: string;
  GIT_COMMON_DIR: string;
  GIT_WORK_TREE: string;
}

/**
 * What a call site may add to a git spawn. `env` is laid over the scrubbed
 * environment rather than replacing it, so a caller names only what it adds.
 * `timeout` replaces `spawnOptions`' deadline. `reachesRemote` leaves the
 * transports to the operator's config rather than pinning them off. Only
 * `withScratchGitDir` sets it. Neither its git nor any git that git starts
 * reads a config a session can write, once it pins `core.alternateRefsCommand`.
 */
export interface RunGitOptions {
  env?: NodeJS.ProcessEnv;
  stdio?: ExecFileSyncOptions['stdio'];
  timeout?: number;
  reachesRemote?: boolean;
}

/** One side of a file's diff as `--raw` lists it: its tree mode and blob oid. */
export type DiffSide = { mode: string; oid: string };

/** A file's `[base, branch]` sides, undefined where it does not exist: never on both. */
export type DiffSides = [DiffSide, DiffSide] | [DiffSide, undefined] | [undefined, DiffSide];

/**
 * A numstat entry. A renamed file carries the path it was `renamedFrom`, and a
 * file numstat could not count (`-\t-`) its `sides`, `[base, branch]`, each
 * undefined where the file does not exist, for `gitDiffBinaryRecount`.
 */
export type DiffNumstatEntry = DiffFileStat & { renamedFrom?: string; sides?: DiffSides };
