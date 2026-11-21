import type { WorktreeGitEnv } from '../../core/types/git-diff.types.js';
import type { ModelRoute } from './model-ladder.types.js';

export interface LaunchOptions {
  sessionId: string;
  /**
   * The project's main checkout, as the caller was handed it: the repo the
   * window's pointers are checked against and trust is seeded on. Never
   * derived from `worktreePath`, which a respawn reads from a store row a
   * session can write (decision 101).
   */
  repoPath: string;
  worktreePath: string;
  /** What the launching command resolved, handed to the window unread again (decision 106). */
  env: WindowEnv;
  /** Compiled settings.json path, passed to `claude --settings`. */
  settingsPath: string;
  /** The model and effort the window runs on: its rung, or the operator's override (decision 92). */
  route: ModelRoute;
}

export interface ConductorLaunchOptions {
  projectId: string;
  /** The main checkout: the conductor reads the repo, edits nothing, and launches from here. */
  repoPath: string;
  /** What `pup conductor start` resolved, handed to the window unread again (decision 106). */
  env: WindowEnv;
  settingsPath: string;
  route: ModelRoute;
  /**
   * This run's token, the conductor server's `PUP_CONDUCTOR_RUN` and read
   * back by `conductorRun`: what seals the run's questions, so a row a session
   * wrote into the store, or one an earlier run asked, is never relayed.
   */
  run: string;
}

/**
 * The pane a session was launched into. Every later command is addressed to
 * `paneId`, never to the session: a session target resolves to the session's
 * ACTIVE pane, and the agent holds `$TMUX`, so one `split-window` from inside
 * moved paste-buffer, send-keys and capture-pane into a shell of its own
 * (decision 46). A pane id (`%N`) is server-unique and never reissued, so a
 * split, a swap-pane or a rename-session cannot move it onto another pane.
 */
export interface SessionPane {
  sessionId: string;
  paneId: string;
  /**
   * The tmux server the pane lives on, as a `-L` socket label; absent for the
   * default server every session and the operator share. Only the conductor
   * sets it: its window is off the default socket so no session can reach it
   * (decision 47).
   */
  socket?: string;
}

/**
 * What a command hands every window it opens (decision 106), resolved once
 * where the command starts and passed down to the window, so the hash it
 * records, the trust it seeds and the window's `-e` agree on one dir: a list
 * read twice could be rewritten by a session between the reads.
 */
export interface WindowEnv {
  /** Each recorded name the launching shell has a value for, as the window's own `-e`. */
  vars: Record<string, string>;
  /**
   * The Claude Code config dir the window runs on: the launching shell's
   * `CLAUDE_CONFIG_DIR` when `--session-env` names it, `~/.claude` otherwise.
   * What the launch hashes for decision 9's drift check, and where the
   * window's `.claude.json` and transcripts live.
   */
  configDir: string;
}

export interface ClaudeWindowOptions {
  sessionId: string;
  /** Where the window opens: a session's worktree, the conductor's main checkout. */
  cwd: string;
  /** What the launching command resolved: the window's named variables and config dir. */
  env: WindowEnv;
  settingsPath: string;
  route: ModelRoute;
  /**
   * The one variable that names the caller — `PUP_SESSION_ID` or
   * `PUP_CONDUCTOR` — which is all that separates a session's window from the
   * conductor's: the guards tell the two apart by which is set (decision 47).
   */
  caller: Record<string, string>;
  /**
   * Handed to the server this launch starts, through the client's environment
   * rather than its argv: tmux makes a starting client's environment the
   * server's global one, which the window inherits. Reaches nothing when the
   * server is already up, so a caller kills it first and checks it landed.
   */
  serverEnv?: Record<string, string>;
  /**
   * A session window's admin and common dirs, checked before it opens
   * (decision 101): trust is seeded on their repo, and the window gets
   * `WINDOW_GIT_CONFIG`. Never the window's environment itself: every process
   * the session runs would inherit them, and a `git init` or `git clone` a
   * test or a package manager runs in another dir would act on the session's
   * repo. Absent for the conductor, whose checkout is no linked worktree of a
   * session's.
   */
  git?: WorktreeGitEnv;
  /** The tmux server to open it on: the conductor's own, or the default one. */
  socket?: string;
  /** `nice -n` level for the window's `claude`; unset runs it at pup's own priority. */
  niceness?: string;
  /** Where the launch records the pid its pane runs (decision 188). */
  panePidFile: string;
}

/**
 * A window pup opened: a session's, a project's conductor, or its conflict
 * radar. Which name it wears and which server it is on are
 * `session-runtime.service`'s to know — a caller names the window it means and
 * gets back a label to print or an argv to run.
 */
export type WindowTarget = { sessionId: string } | { conductorOf: string } | { watcherOf: string };

/** Why a server's panes could not be listed: no tmux on `PROBE_PATH`, or what tmux said. */
export type ProbeFailure = { noTmux: true } | { noTmux: false; detail: string };
