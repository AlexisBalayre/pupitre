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

export interface ConductorLaunchOptions {
  projectId: string;
  /** The main checkout: the conductor reads the repo, edits nothing, and launches from here. */
  repoPath: string;
  settingsPath: string;
  model?: string;
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
/** Columns and rows a detached window opens at, so Claude Code's UI has room to fold a paste. */
const WINDOW_SIZE = { x: 220, y: 50 };

/** What tmux 3.7b prints when the pane, or the whole server, is gone. */
const PANE_GONE = /can't find pane|error connecting to|no server running/;

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
 * Exact-match pin for the two commands that address a session by NAME:
 * kill-session, and the stale-name kill before new-session. The '=' pins tmux
 * to exact matching — a bare name resolves exact -> fnmatch -> PREFIX, so once
 * `pup-t-abc` is gone its keys land in a live `pup-t-abc-1`, and session
 * slugs mint exactly such prefix pairs. The trailing ':' is required: bare
 * '=name' fails pane resolution with can't-find-pane, '=name:' works
 * (verified on tmux 3.7b). ':' and '=' are both legal in session NAMES, so a
 * double-pinned or unpinned target resolves to something else — or to
 * nothing, silently; this is the single place the pin format lives. Nothing
 * that types into a pane may use it: it names a session, and tmux resolves a
 * session to whichever pane is active (decision 46).
 */
function pinned(name: string): string {
  return `=${name}:`;
}

function isPaneId(value: string): boolean {
  return /^%\d+$/.test(value);
}

/**
 * The session's pane, or a refusal. Raised before anything is sent: a pane
 * that was never recorded, or that is not a pane id — a row from before panes
 * were pinned holds the session name, which tmux would resolve to the active
 * pane — cannot be steered, and one tmux reports gone cannot be either. The
 * session runs on untouched, or is already gone; either way nothing landed
 * anywhere else.
 */
export class SessionPaneMissingError extends Error {
  readonly sessionId: string;
  readonly paneId: string | null;

  constructor(sessionId: string, paneId: string | null, reason: 'unrecorded' | 'gone') {
    super(
      paneId === null
        ? `Session ${sessionId} has no pane recorded at launch; nothing was sent.`
        : reason === 'unrecorded'
          ? `Session ${sessionId} recorded ${JSON.stringify(paneId)} as its pane, which is not ` +
            'a tmux pane id (it was launched before panes were pinned); nothing was sent. ' +
            `Respawn it: \`pup kill --respawn ${sessionId}\`.`
          : `Session ${sessionId}'s pane ${paneId} no longer exists; nothing was sent.`,
    );
    this.name = 'SessionPaneMissingError';
    this.sessionId = sessionId;
    this.paneId = paneId;
  }
}

/**
 * The `-t` for every command that types into or reads a pane. The single
 * place a pane target is formed, so nothing below can fall back to a session
 * name: a value that is not `%N` is refused, never passed to tmux, where a
 * bare name would resolve to the active pane.
 */
function paneTarget(pane: SessionPane): string {
  if (!isPaneId(pane.paneId)) {
    throw new SessionPaneMissingError(pane.sessionId, pane.paneId, 'unrecorded');
  }
  return pane.paneId;
}

/**
 * Run a tmux command addressed to the session's pane. stderr is piped rather
 * than inherited, so a gone pane is a named refusal instead of tmux's own
 * line on the operator's terminal; any other failure is rethrown as is.
 */
function tmuxAt(pane: SessionPane, args: string[], input?: string): string {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && PANE_GONE.test(stderr)) {
      throw new SessionPaneMissingError(pane.sessionId, pane.paneId, 'gone');
    }
    throw error;
  }
}

/**
 * Kill any stale session named `name`, then launch a fresh detached tmux
 * session running `command`, and return the id of the pane it opened in.
 * Shared by `launchSession` and `launchWatcher` — tmux is pup's process
 * supervisor everywhere (decision 1), and both spawn paths need the
 * kill-then-spawn sequence to survive a re-launch.
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
): string {
  killIfExists(name);
  const printed = tmux(
    'new-session',
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
    '-s',
    name,
    ...(opts.window ? ['-x', String(opts.window.x), '-y', String(opts.window.y)] : []),
    '-c',
    opts.cwd,
    ...Object.entries(opts.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    ...opts.command,
  ).trim();
  // Checked where it is minted: this id is what every later command trusts,
  // and a launch is the one place a bad one can fail loudly instead of late.
  if (!isPaneId(printed)) {
    throw new Error(`tmux new-session printed ${JSON.stringify(printed)}, not a pane id.`);
  }
  return printed;
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
 * The display name is the tmux name: it is what a peer session sees in
 * ListAgents and addresses with SendMessage, so the conductor reaches a
 * session by the same `pup-<id>` the operator attaches to (decision 47).
 */
export function launchArgs(opts: LaunchOptions): string[] {
  return [
    ...(opts.model ? ['--model', opts.model] : []),
    '--name',
    tmuxName(opts.sessionId),
    '--dangerously-skip-permissions',
    '--settings',
    opts.settingsPath,
    '--setting-sources',
    'user',
  ];
}

/**
 * Open the session's window and return the pane it runs in. The caller stores
 * the pane (`sessions.tmux_target`) and hands it to every later command: the
 * id is minted here, once, and nothing later re-derives it from the session.
 */
export function launchSession(opts: LaunchOptions): SessionPane {
  preseedTrust(opts.worktreePath);
  const claudeBin = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  const paneId = spawnDetachedSession(tmuxName(opts.sessionId), {
    cwd: opts.worktreePath,
    window: WINDOW_SIZE,
    env: {
      PUP_SESSION_ID: opts.sessionId,
      // Absolute path to this CLI, so `pup session done` works even when `pup`
      // is not on the session's PATH (dev). Production installs the `pup` bin.
      PUP_BIN: process.argv[1] ?? 'pup',
    },
    command: [claudeBin, ...launchArgs(opts)],
  });
  return { sessionId: opts.sessionId, paneId };
}

/** The conductor's id, one per project: its tmux name and peer name are `pup-` + this. */
function conductorId(repoProjectId: string): string {
  return `conductor-${repoProjectId}`;
}

/** The name the conductor's window and its peer entry both carry. */
export function conductorName(repoProjectId: string): string {
  return tmuxName(conductorId(repoProjectId));
}

/**
 * Open the conductor's window in the repo's main checkout and return its
 * pane. Same launch as a session — bypass permissions, compiled settings,
 * user setting sources, a peer name — but `PUP_CONDUCTOR` in place of
 * `PUP_SESSION_ID`: the conductor is not a session (no task, worktree or row)
 * and the guards tell the two apart by which variable is set (decision 47).
 * Tmux's `-e` sets the new session's environment, not the server's, so the
 * variable does not leak into the sessions the conductor launches from it.
 */
export function launchConductor(opts: ConductorLaunchOptions): SessionPane {
  preseedTrust(opts.repoPath);
  const claudeBin = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  const sessionId = conductorId(opts.projectId);
  const paneId = spawnDetachedSession(tmuxName(sessionId), {
    cwd: opts.repoPath,
    window: WINDOW_SIZE,
    env: {
      PUP_CONDUCTOR: opts.projectId,
      PUP_BIN: process.argv[1] ?? 'pup',
    },
    command: [
      claudeBin,
      ...launchArgs({
        sessionId,
        worktreePath: opts.repoPath,
        settingsPath: opts.settingsPath,
        model: opts.model,
      }),
    ],
  });
  return { sessionId, paneId };
}

/**
 * Kill the conductor's window by its pinned name. No pane is recorded for it
 * — nothing types into the conductor after its kickoff — so a rename from
 * inside would leave it running, as decision 46 notes for a name-only kill;
 * the conductor is the operator's delegate, not a worker to contain.
 */
export function killConductor(repoProjectId: string): void {
  killIfExists(conductorName(repoProjectId));
}

/** Whether a window wearing the conductor's name exists; false when no server runs. */
export function hasConductorWindow(repoProjectId: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', pinned(conductorName(repoProjectId))], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
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
 * Steer a running session mid-turn, into the pane it was launched in.
 * paste-buffer keeps arbitrary text intact; `-p` brackets it, so the UI folds
 * the whole message into one paste instead of one per ~1 KB chunk the pty
 * delivers. Enter is sent only once the pane shows the message whole: a fixed
 * settle let Enter fire mid-ingestion and submit the tail of a 1.5 KB steer,
 * or of the compiled kickoff context, with the head lost (decision 45). A
 * paste that never lands is cleared and refused, never submitted in part.
 * After Enter, submission is verified against the pane and Enter retried: an
 * extra Enter on an empty input box is a no-op, so a false "still pending"
 * read is harmless.
 */
export function steerPane(pane: SessionPane, message: string): void {
  const target = paneTarget(pane);
  // A paste appends to whatever the box holds (a draft, a leftover), and the
  // box then never reads as the message alone; start from an empty one, and
  // say so when one cannot be had rather than paste into it and refuse later.
  if (hasUnsubmittedInput(captureInputBox(pane)) && !clearInputBox(pane)) {
    throw new SteerNotDeliveredError(pane.sessionId, message.length, 'box-not-cleared');
  }
  tmuxAt(pane, ['load-buffer', '-'], message);
  tmuxAt(pane, ['paste-buffer', '-d', '-p', '-t', target]);
  if (!awaitPasteLanded(pane, message)) {
    clearInputBox(pane);
    throw new SteerNotDeliveredError(pane.sessionId, message.length);
  }
  tmuxAt(pane, ['send-keys', '-t', target, 'Enter']);
  for (let retry = 0; retry < SUBMIT_RETRY_LIMIT; retry++) {
    syncSleep(SUBMIT_VERIFY_MS);
    if (!hasUnsubmittedInput(captureInputBox(pane))) return;
    tmuxAt(pane, ['send-keys', '-t', target, 'Enter']);
  }
}

/** Settle, then look for the message in the input box; bounded by its length. */
function awaitPasteLanded(pane: SessionPane, message: string): boolean {
  const settles = Math.max(PASTE_SETTLE_MIN, Math.ceil(message.length / PASTE_SETTLE_CHARS));
  for (let settle = 0; settle < settles; settle++) {
    syncSleep(PASTE_SETTLE_MS);
    if (pasteLanded(captureInputBox(pane), message)) return true;
  }
  return false;
}

/** Press Ctrl-U until the input box is empty; false when the press budget is spent first. */
function clearInputBox(pane: SessionPane): boolean {
  const target = paneTarget(pane);
  for (let press = 0; press < CLEAR_KEY_LIMIT; press++) {
    tmuxAt(pane, ['send-keys', '-t', target, 'C-u']);
    syncSleep(CLEAR_SETTLE_MS);
    if (!hasUnsubmittedInput(captureInputBox(pane))) return true;
  }
  return false;
}

/**
 * Abort a session's in-flight tool call by sending Escape to its pane — the
 * escape hatch for a hung tool (e.g. a transient network error wedging a
 * session), which `steerPane` cannot reach because steers deliver only after
 * the current tool call ends. The trailing settle gives the UI a beat to
 * return to its input box, so a steer issued right after lands as a paste
 * instead of vanishing into the interrupt redraw.
 */
export function interruptPane(pane: SessionPane): void {
  tmuxAt(pane, ['send-keys', '-t', paneTarget(pane), 'Escape']);
  syncSleep(INTERRUPT_SETTLE_MS);
}

/** Wait until the session UI is interactive. Returns false on timeout. */
function waitUntilReady(pane: SessionPane, timeoutMs = READY_TIMEOUT_MS): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (READY_MARKER.test(capturePane(pane))) return true;
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
export function kickoff(pane: SessionPane, prompt: string): boolean {
  if (!waitUntilReady(pane)) return false;
  steerPane(pane, prompt);
  return true;
}

/** The pane as plain text, for the markers that carry no styling of their own. */
function capturePane(pane: SessionPane): string {
  return tmuxAt(pane, ['capture-pane', '-p', '-t', paneTarget(pane)]);
}

/**
 * The pane with its styling kept. Every look at the input box takes this one:
 * Claude Code renders the box's ghost text — the idle hint, and the next
 * prompt it suggests once a turn ends — dim, and only the escapes tell that
 * apart from a draft. Without them a suggestion reads as unsubmitted text, and
 * `steerPane` spends its whole Ctrl-U budget on a box that was already empty
 * (addendum to decision 45).
 */
function captureInputBox(pane: SessionPane): string {
  return tmuxAt(pane, ['capture-pane', '-p', '-e', '-t', paneTarget(pane)]);
}

/**
 * Kill the session's window: the session holding its launch pane, wherever a
 * rename moved it (kill-session resolves a pane id to the session it is in),
 * then any session still wearing the name, for a row whose pane was never
 * recorded or is already gone. Both kills are silent no-ops when there is
 * nothing to kill, so together they leave nothing of either behind.
 */
export function killSession(sessionId: string, paneId?: string | null): void {
  if (paneId && isPaneId(paneId)) killTarget(paneId);
  killIfExists(tmuxName(sessionId));
}

function killIfExists(name: string): void {
  // Pinned to exact match, or a stale name would prefix-match and kill a
  // live sibling.
  killTarget(pinned(name));
}

function killTarget(target: string): void {
  try {
    // Expected to fail when the session (or the tmux server itself) does not
    // exist; pipe stderr so the probe stays silent instead of leaking
    // "error connecting to /tmp/tmux-*" to the operator's terminal.
    execFileSync('tmux', ['kill-session', '-t', target], {
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
 * may not carry the dev toolchain. Nothing types into the radar, so its pane
 * id is not kept; the watcher is addressed by name alone.
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
