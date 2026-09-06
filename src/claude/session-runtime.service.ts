import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { GIT_SAFE_CONFIG, scrubbedGitEnv } from '../core/git-diff.client.js';
import { hasUnsubmittedInput, pasteLanded } from './pane.utils.js';

// The only module that launches and drives Claude Code. Transport is tmux
// (decision 1); state comes from hooks + transcripts, never pane scraping.
// Sessions inherit the user's ~/.claude login (decision 9) — no tokens.

export interface LaunchOptions {
  sessionId: string;
  worktreePath: string;
  /** Compiled settings.json path, passed to `claude --settings`. */
  settingsPath: string;
  model?: string;
}

const CLAUDE_JSON = join(homedir(), '.claude.json');

const READY_MARKER = /\? for shortcuts|bypass permissions on/i;
const READY_TIMEOUT_MS = 45_000;
const READY_POLL_MS = 1000;
/**
 * Between paste-buffer and each look at the input box: the UI needs a beat to
 * fold a paste into it. Enter is sent only once the box holds the message
 * whole (decision 45); until then the paste is still being ingested and Enter
 * would submit whatever part had arrived.
 */
const PASTE_SETTLE_MS = 700;
/**
 * How many settles a paste gets: one per this many chars, floored at
 * PASTE_SETTLE_MIN. The observed cliff was a single 700 ms settle for
 * 1.5-1.7 KB, so the bound grows with the message and a multi-KB kickoff is
 * never given up on early; the floor keeps a one-line steer from being refused
 * because a loaded machine (an audit pushes it past 60) repainted late.
 */
const PASTE_SETTLE_CHARS = 1000;
const PASTE_SETTLE_MIN = 5;
/**
 * Ctrl-U clears one row of the input box per press (verified on Claude Code
 * 2.1.263), so clearing a partial paste is a bounded loop of presses, each
 * followed by a repaint beat and a look at the box.
 */
const CLEAR_KEY_LIMIT = 64;
const CLEAR_SETTLE_MS = 150;
/** After Enter, how long to wait before checking that the input box cleared. */
const SUBMIT_VERIFY_MS = 1000;
/**
 * After Escape, how long the interrupt redraw needs before the pane is back at
 * its input box and a paste can land. Same beat as PASTE_SETTLE_MS — both wait
 * out one UI repaint — but it guards a different transition (interrupt redraw,
 * not paste folding), so it gets its own name.
 */
const INTERRUPT_SETTLE_MS = 700;
const SUBMIT_RETRY_LIMIT = 2;

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

/** Block the current thread without spawning a process (CLI-only, short waits). */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Session name, for `new-session -s` only — ':' is illegal in session names. */
function tmuxName(sessionId: string): string {
  return `pup-${sessionId}`;
}

/**
 * Exact-match pin for every lookup (send-keys, paste-buffer, capture-pane,
 * kill-session). The '=' pins tmux to exact matching — a bare name resolves
 * exact -> fnmatch -> PREFIX, so once `pup-t-abc` is gone its keys land in a
 * live `pup-t-abc-1`, and session slugs mint exactly such prefix pairs. The
 * trailing ':' is required: bare '=name' fails pane resolution for send-keys
 * with can't-find-pane, '=name:' works (verified on tmux 3.7b). ':' and '='
 * are both legal in session NAMES, so a double-pinned or unpinned target
 * resolves to something else — or to nothing, silently; this is the single
 * place the pin format lives.
 */
function pinned(name: string): string {
  return `=${name}:`;
}

function tmuxTarget(sessionId: string): string {
  return pinned(tmuxName(sessionId));
}

/**
 * Kill any stale session named `name`, then launch a fresh detached tmux
 * session running `command`. Shared by `launchSession` and `launchWatcher` —
 * tmux is pup's process supervisor everywhere (decision 1), and both spawn
 * paths need the kill-then-spawn sequence to survive a re-launch.
 * `name` must be BARE (never `pinned()`): '=' and ':' are legal in session
 * names, so `-s` would happily create a pin-shaped name no pinned lookup can
 * ever find again — an orphan pane invisible to every later command.
 * `command` must have at least 2 elements: tmux shell-evaluates a lone
 * trailing argument instead of treating it as an argv vector.
 */
function spawnDetachedSession(
  name: string,
  opts: {
    cwd: string;
    window?: { x: number; y: number };
    env?: Record<string, string>;
    command: string[];
  },
): void {
  killIfExists(name);
  tmux(
    'new-session',
    '-d',
    '-s',
    name,
    ...(opts.window ? ['-x', String(opts.window.x), '-y', String(opts.window.y)] : []),
    '-c',
    opts.cwd,
    ...Object.entries(opts.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    ...opts.command,
  );
}

/**
 * Pre-seed trust so the launched session skips the trust dialog. Claude Code
 * keys the dialog on the git common-dir ROOT, not the launch cwd (verified on
 * 2.1.218: a trusted worktree under an untrusted repo still shows the dialog,
 * and accepting it writes `hasTrustDialogAccepted` on the repo root) — so both
 * paths are seeded. `claudeJsonPath` is overridable for tests only.
 */
export function preseedTrust(worktreePath: string, claudeJsonPath = CLAUDE_JSON): void {
  const config = existsSync(claudeJsonPath)
    ? (JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as Record<string, unknown>)
    : {};
  const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
  for (const path of new Set([worktreePath, ...mainRepoRoot(worktreePath)])) {
    projects[path] = { ...projects[path], hasTrustDialogAccepted: true };
  }
  config.projects = projects;
  writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
}

/** Empty when the path is not a git checkout. */
function mainRepoRoot(worktreePath: string): string[] {
  try {
    const commonDir = execFileSync(
      'git',
      [
        ...GIT_SAFE_CONFIG,
        '-C',
        worktreePath,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ],
      { encoding: 'utf8', env: scrubbedGitEnv() },
    ).trim();
    return [realpathSync(dirname(commonDir))];
  } catch {
    return [];
  }
}

/**
 * Args for the `claude` process. Setting sources are restricted to `user`
 * (decision 19): repo-committed ask-rules pierce bypass permissions and ask
 * outranks allow ACROSS scopes (verified on 2.1.218), so the only way to keep a
 * repo's `.claude/settings.json` from wedging a session on a prompt is to not
 * load it. The compiled `--settings` file still applies (separate source).
 */
export function launchArgs(opts: LaunchOptions): string[] {
  return [
    ...(opts.model ? ['--model', opts.model] : []),
    '--dangerously-skip-permissions',
    '--settings',
    opts.settingsPath,
    '--setting-sources',
    'user',
  ];
}

export function launchSession(opts: LaunchOptions): { target: string } {
  const target = tmuxName(opts.sessionId);
  preseedTrust(opts.worktreePath);
  const claudeBin = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  spawnDetachedSession(target, {
    cwd: opts.worktreePath,
    window: { x: 220, y: 50 },
    env: {
      PUP_SESSION_ID: opts.sessionId,
      // Absolute path to this CLI, so `pup session done` works even when `pup`
      // is not on the session's PATH (dev). Production installs the `pup` bin.
      PUP_BIN: process.argv[1] ?? 'pup',
    },
    command: [claudeBin, ...launchArgs(opts)],
  });
  return { target };
}

/**
 * A steer that was not submitted: either its paste never showed up whole in
 * the session's input box (the box was then cleared), or the box held text
 * Ctrl-U could not clear, so nothing was pasted at all. Either way nothing
 * was submitted and the session runs on untouched.
 */
export class SteerNotDeliveredError extends Error {
  readonly sessionId: string;

  constructor(
    sessionId: string,
    chars: number,
    reason: 'never-landed' | 'box-not-cleared' = 'never-landed',
  ) {
    super(
      reason === 'never-landed'
        ? `Steer to session ${sessionId} did not land: its input box never held the whole ` +
            `${chars}-char message. Cleared the box and submitted nothing; the session is ` +
            'still running with an empty prompt.'
        : `Steer to session ${sessionId} did not land: its input box held text that Ctrl-U ` +
            `could not clear, so the ${chars}-char message was not pasted. Nothing was ` +
            'submitted; the session is still running with the box as it was.',
    );
    this.name = 'SteerNotDeliveredError';
    this.sessionId = sessionId;
  }
}

/**
 * Steer a running session mid-turn. paste-buffer keeps arbitrary text intact;
 * `-p` brackets it, so the UI folds the whole message into one paste instead
 * of one per ~1 KB chunk the pty delivers. Enter is sent only once the pane
 * shows the message whole: a fixed settle let Enter fire mid-ingestion and
 * submit the tail of a 1.5 KB steer, or of the compiled kickoff context, with
 * the head lost (decision 45). A paste that never lands is cleared and refused,
 * never submitted in part. After Enter, submission is verified against the
 * pane and Enter retried: an extra Enter on an empty input box is a no-op, so
 * a false "still pending" read is harmless.
 */
export function steerSession(sessionId: string, message: string): void {
  const target = tmuxTarget(sessionId);
  // A paste appends to whatever the box holds (a draft, a leftover), and the
  // box then never reads as the message alone; start from an empty one, and
  // say so when one cannot be had rather than paste into it and refuse later.
  if (hasUnsubmittedInput(capturePane(sessionId)) && !clearInputBox(sessionId)) {
    throw new SteerNotDeliveredError(sessionId, message.length, 'box-not-cleared');
  }
  execFileSync('tmux', ['load-buffer', '-'], { input: message });
  tmux('paste-buffer', '-d', '-p', '-t', target);
  if (!awaitPasteLanded(sessionId, message)) {
    clearInputBox(sessionId);
    throw new SteerNotDeliveredError(sessionId, message.length);
  }
  tmux('send-keys', '-t', target, 'Enter');
  for (let retry = 0; retry < SUBMIT_RETRY_LIMIT; retry++) {
    syncSleep(SUBMIT_VERIFY_MS);
    if (!hasUnsubmittedInput(capturePane(sessionId))) return;
    tmux('send-keys', '-t', target, 'Enter');
  }
}

/** Settle, then look for the message in the input box; bounded by its length. */
function awaitPasteLanded(sessionId: string, message: string): boolean {
  const settles = Math.max(PASTE_SETTLE_MIN, Math.ceil(message.length / PASTE_SETTLE_CHARS));
  for (let settle = 0; settle < settles; settle++) {
    syncSleep(PASTE_SETTLE_MS);
    if (pasteLanded(capturePane(sessionId), message)) return true;
  }
  return false;
}

/** Press Ctrl-U until the input box is empty; false when the press budget is spent first. */
function clearInputBox(sessionId: string): boolean {
  const target = tmuxTarget(sessionId);
  for (let press = 0; press < CLEAR_KEY_LIMIT; press++) {
    tmux('send-keys', '-t', target, 'C-u');
    syncSleep(CLEAR_SETTLE_MS);
    if (!hasUnsubmittedInput(capturePane(sessionId))) return true;
  }
  return false;
}

/**
 * Abort a session's in-flight tool call by sending Escape to its pane — the
 * escape hatch for a hung tool (e.g. a transient network error wedging a
 * session), which `steerSession` cannot reach because steers deliver only
 * after the current tool call ends. The trailing settle gives the UI a beat
 * to return to its input box, so a steer issued right after lands as a paste
 * instead of vanishing into the interrupt redraw.
 */
export function interruptSession(sessionId: string): void {
  tmux('send-keys', '-t', tmuxTarget(sessionId), 'Escape');
  syncSleep(INTERRUPT_SETTLE_MS);
}

/** Wait until the session UI is interactive. Returns false on timeout. */
function waitUntilReady(sessionId: string, timeoutMs = READY_TIMEOUT_MS): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (READY_MARKER.test(capturePane(sessionId))) return true;
    syncSleep(READY_POLL_MS);
  }
  return false;
}

/**
 * Send the first prompt once the session is ready (the compiled task context).
 * Returns false when the UI never became ready; throws SteerNotDeliveredError
 * when the context never landed whole, so a launch fails loudly rather than
 * start the agent on the tail of its own task (decision 45).
 */
export function kickoff(sessionId: string, prompt: string): boolean {
  if (!waitUntilReady(sessionId)) return false;
  steerSession(sessionId, prompt);
  return true;
}

function capturePane(sessionId: string): string {
  return tmux('capture-pane', '-p', '-t', tmuxTarget(sessionId));
}

export function killSession(sessionId: string): void {
  killIfExists(tmuxName(sessionId));
}

function killIfExists(name: string): void {
  try {
    // Expected to fail when the session (or the tmux server itself) does not
    // exist; pipe stderr so the probe stays silent instead of leaking
    // "error connecting to /tmp/tmux-*" to the operator's terminal. Pinned to
    // exact match, or a stale name would prefix-match and kill a live sibling.
    execFileSync('tmux', ['kill-session', '-t', pinned(name)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    // not running — nothing to kill
  }
}

/** Transcript directory Claude Code uses for a given worktree (munged real path). */
export function transcriptDir(worktreePath: string): string {
  const munged = worktreePath.replace(/[^a-zA-Z0-9]/g, '-');
  return join(homedir(), '.claude', 'projects', munged);
}

function watcherTarget(repoProjectId: string): string {
  return `pup-watch-${repoProjectId}`;
}

/**
 * Run the conflict radar in a detached tmux session — tmux is pup's process
 * supervisor everywhere else (decision 1), and it makes the radar log one
 * `tmux attach` away. Absolute node + CLI paths, since the tmux server's PATH
 * may not carry the dev toolchain.
 */
export function launchWatcher(repoProjectId: string, repoPath: string): { target: string } {
  const target = watcherTarget(repoProjectId);
  spawnDetachedSession(target, {
    cwd: repoPath,
    command: [process.execPath, process.argv[1] ?? 'pup', 'watch'],
  });
  return { target };
}

export function killWatcher(repoProjectId: string): void {
  killIfExists(watcherTarget(repoProjectId));
}
