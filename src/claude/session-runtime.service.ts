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
  /**
   * Compiled mcp.json path, passed to `claude --mcp-config`. Absent when the
   * session gets no code graph — either the operator has no codegraph binary,
   * or indexing this worktree failed (decision 51).
   */
  mcpConfigPath?: string;
}

export interface ConductorLaunchOptions {
  projectId: string;
  /** The main checkout: the conductor reads the repo, edits nothing, and launches from here. */
  repoPath: string;
  settingsPath: string;
  model?: string;
  /**
   * Compiled mcp.json path, passed to `claude --mcp-config`. Absent when the
   * conductor gets no code graph — either the operator has no codegraph binary,
   * or indexing the main checkout failed (decision 51).
   */
  mcpConfigPath?: string;
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

/**
 * Claude Code's own line for a turn that died on the network — a machine that
 * slept through one, a DNS outage — printed where the next tool call would
 * have gone. Nothing else marks it: no Stop hook fires, so the events file
 * stops dead and the session sits at an empty prompt (addendum to decision 35).
 */
const TURN_DIED_LINE = /^⏺ API Error:/;

/**
 * The same line while the turn is still alive: Claude Code backs off and
 * retries, and says so on the line itself (`… · Retrying in 4 seconds…
 * (attempt 1/10)`). A backoff series can outlast the stall window over an
 * empty box, and a resume pasted into it would queue behind a turn that is
 * about to come back on its own.
 */
const TURN_RETRYING = /Retrying/;

/**
 * The glyph the input box's prompt opens with, at column 0. `pane.utils.ts`
 * owns what is IN the box; this file only needs where the box starts, so the
 * transcript above it can be read.
 */
const BOX_PROMPT = '❯';

/** Rows the box draws itself out of: its borders, and the blank filler around them. */
const BOX_CHROME = /^[\s─│╭╮╯╰]*$/;

/**
 * tmux's argv with the server it means in front. tmux reads `-L` first and
 * only then `$TMUX`, so the flag is the whole isolation: a client on one
 * socket cannot address, read or even connect to a window on another.
 * `undefined` means the default server, which `tmuxEnv` keeps an inherited
 * `$TMUX` from redirecting.
 */
function onSocket(socket: string | undefined, args: string[]): string[] {
  return socket === undefined ? args : ['-L', socket, ...args];
}

/**
 * What no tmux call here hands the client. A tmux client that starts a server
 * — and `pup launch` from the conductor's Bash starts the default one whenever
 * the operator has no tmux up — gives that server its GLOBAL environment, which
 * every window opened on it afterwards inherits and ANY client can read back
 * with `show-environment -g` (verified on tmux 3.7b). So this is not a list of
 * variables that would confuse tmux; it is everything about the caller that
 * must not become a server-wide, world-readable fact:
 *
 * - `TMUX` picks the server when no `-L` is given, and in the conductor's pane
 *   it names the conductor's own socket — a launch from there would open the
 *   session on the conductor's server, back within `send-keys` reach of it.
 * - `PUP_CONDUCTOR` and `PUP_SESSION_ID` say what a window IS; leaked into a
 *   server's global environment they make every later window read as their
 *   caller to every guard.
 * - `CLAUDE*` carries the agent's own credentials — `CLAUDE_CODE_MESSAGING_SOCKET`
 *   and `_TOKEN` are the peer channel, so a session that read them back could
 *   speak on it AS the conductor, past the tier entirely. `ANTHROPIC_*` is the
 *   API key family for the same reason.
 * - `NODE_OPTIONS` is code execution: `--require` in a server's environment runs
 *   in every node process a window later starts.
 *
 * What a window is, its own `-e` says. Everything else the caller has — `PATH`,
 * `HOME`, `TERM`, `SHELL`, `LANG`, `TMUX_TMPDIR` — is passed through untouched
 * (decision 47).
 */
const NOT_INHERITED = [
  /^TMUX$/,
  /^PUP_CONDUCTOR$/,
  /^PUP_SESSION_ID$/,
  /^CLAUDE/,
  /^ANTHROPIC_/,
  /^NODE_OPTIONS$/,
];

function tmuxEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !NOT_INHERITED.some((pattern) => pattern.test(key)),
    ),
  );
}

function tmux(socket: string | undefined, args: string[]): string {
  return execFileSync('tmux', onSocket(socket, args), { encoding: 'utf8', env: tmuxEnv() });
}

/**
 * A tmux command whose failure is an answer rather than an error: `undefined`
 * when tmux refused it — no window by that name, no server on that socket —
 * with stderr piped, so a probe never leaves tmux's own line on the operator's
 * terminal.
 */
function tmuxProbe(socket: string | undefined, args: string[]): string | undefined {
  try {
    return execFileSync('tmux', onSocket(socket, args), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: tmuxEnv(),
    });
  } catch {
    return undefined;
  }
}

/** Whether a window wearing `name` is up on `socket` — the default server when unset. */
function hasWindow(name: string, socket?: string): boolean {
  return tmuxProbe(socket, ['has-session', '-t', pinned(name)]) !== undefined;
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
    return execFileSync('tmux', onSocket(pane.socket, args), {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: tmuxEnv(),
      input,
    });
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
    /** The server to open it on; the default one when unset. */
    socket?: string;
  },
): string {
  killIfExists(name, opts.socket);
  const printed = tmux(opts.socket, [
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
  ]).trim();
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
 *
 * `--mcp-config` adds the code graph without `--strict-mcp-config`: strict mode
 * would drop the operator's own MCP servers, and sessions inherit user config
 * (decision 9). The flag is only passed when there is a graph to serve
 * (decision 51).
 */
export function launchArgs(
  opts: Pick<LaunchOptions, 'sessionId' | 'settingsPath' | 'model' | 'mcpConfigPath'>,
): string[] {
  return [
    ...(opts.model ? ['--model', opts.model] : []),
    '--name',
    tmuxName(opts.sessionId),
    '--dangerously-skip-permissions',
    '--settings',
    opts.settingsPath,
    ...(opts.mcpConfigPath ? ['--mcp-config', opts.mcpConfigPath] : []),
    '--setting-sources',
    'user',
  ];
}

interface ClaudeWindowOptions {
  sessionId: string;
  /** Where the window opens: a session's worktree, the conductor's main checkout. */
  cwd: string;
  settingsPath: string;
  model?: string;
  mcpConfigPath?: string;
  /**
   * The one variable that names the caller — `PUP_SESSION_ID` or
   * `PUP_CONDUCTOR` — which is all that separates a session's window from the
   * conductor's: the guards tell the two apart by which is set (decision 47).
   */
  caller: Record<string, string>;
  /** The tmux server to open it on: the conductor's own, or the default one. */
  socket?: string;
}

/**
 * Open a detached window running Claude Code on a compiled profile, and return
 * the pane it runs in. The single launch both windows take: trust the checkout
 * (the dialog is keyed on the repo root, so a worktree needs its parent seeded
 * too), resolve `claude` on this PATH rather than the tmux server's, and hand
 * the process the same bypass-permissions, user-setting-sources argv.
 */
function spawnClaudeWindow(opts: ClaudeWindowOptions): SessionPane {
  preseedTrust(opts.cwd);
  const claudeBin = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  const paneId = spawnDetachedSession(tmuxName(opts.sessionId), {
    cwd: opts.cwd,
    window: WINDOW_SIZE,
    env: {
      ...opts.caller,
      // Absolute path to this CLI, so `pup session done` works even when `pup`
      // is not on the session's PATH (dev). Production installs the `pup` bin.
      PUP_BIN: process.argv[1] ?? 'pup',
    },
    command: [claudeBin, ...launchArgs(opts)],
    socket: opts.socket,
  });
  return { sessionId: opts.sessionId, paneId, socket: opts.socket };
}

/**
 * Open the session's window and return the pane it runs in. The caller stores
 * the pane (`sessions.tmux_target`) and hands it to every later command: the
 * id is minted here, once, and nothing later re-derives it from the session.
 */
export function launchSession(opts: LaunchOptions): SessionPane {
  return spawnClaudeWindow({
    sessionId: opts.sessionId,
    cwd: opts.worktreePath,
    settingsPath: opts.settingsPath,
    model: opts.model,
    mcpConfigPath: opts.mcpConfigPath,
    caller: { PUP_SESSION_ID: opts.sessionId },
  });
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
 * The tmux socket the conductor's window lives on (`-L`), one per project.
 * Its own server, not the default one every session holds `$TMUX` for: the
 * window's name is computable from the repo path, so on the shared server one
 * `send-keys -t =pup-conductor-<id>:` from a session typed into the operator's
 * delegate as the operator, and `capture-pane` read its whole transcript. A
 * socket is not a namespace to guess past — a client asks one server and sees
 * nothing of any other (decision 47). Spelled the same as the window name,
 * from the same project id; the two are separate namespaces, and this is the
 * one place the label is formed.
 */
export function conductorSocket(repoProjectId: string): string {
  return conductorName(repoProjectId);
}

/**
 * Open the conductor's window in the repo's main checkout and return its
 * pane. Same launch as a session — bypass permissions, compiled settings,
 * user setting sources, a peer name — but `PUP_CONDUCTOR` in place of
 * `PUP_SESSION_ID`: the conductor is not a session (no task, worktree or row)
 * and the guards tell the two apart by which variable is set (decision 47).
 * Tmux's `-e` sets the new session's environment, not the server's, so the
 * variable does not leak into the sessions the conductor launches from it.
 * On its own socket, where no session can address it — and the pane it
 * returns carries that socket, so the kickoff types onto the same server.
 */
export function launchConductor(opts: ConductorLaunchOptions): SessionPane {
  // The whole server, not the window: a name kill leaves a server up, and
  // whoever STARTED it owns its global environment — a session that pre-starts
  // one on this label (the label is as computable as the name) with, say,
  // `NODE_OPTIONS=--require` in its own environment would hand that to the
  // conductor's `claude` at spawn. Killing the server means the conductor's
  // window always opens on one pup started, with the environment above.
  killServerOn(conductorSocket(opts.projectId));
  return spawnClaudeWindow({
    sessionId: conductorId(opts.projectId),
    cwd: opts.repoPath,
    settingsPath: opts.settingsPath,
    model: opts.model,
    mcpConfigPath: opts.mcpConfigPath,
    caller: { PUP_CONDUCTOR: opts.projectId },
    socket: conductorSocket(opts.projectId),
  });
}

/**
 * Kill the conductor's window by its pinned name. No pane is recorded for it
 * — nothing types into the conductor after its kickoff — so a rename from
 * inside would leave it running, as decision 46 notes for a name-only kill;
 * the conductor is the operator's delegate, not a worker to contain.
 */
export function killConductor(repoProjectId: string): void {
  const name = conductorName(repoProjectId);
  killIfExists(name, conductorSocket(repoProjectId));
  // And on the default server, where nothing pup runs wears this name: what
  // is there is a conductor window from before the socket split, or one a
  // session minted to look like the conductor. `pup conductor stop` is what
  // the operator has for either, and an exact-name kill reaches nothing else.
  killIfExists(name);
}

/**
 * Whether a window wearing the conductor's name exists on the conductor's own
 * socket; false when that server does not run. The default server is not
 * probed: a window there is not the conductor, and answering for one would let
 * any session make `pup status` report a conductor that is not running.
 */
export function hasConductorWindow(repoProjectId: string): boolean {
  return hasWindow(conductorName(repoProjectId), conductorSocket(repoProjectId));
}

/**
 * The pane the conductor's window runs in, or undefined when no conductor is
 * up. Nothing typed into it after its kickoff until the turn watchdog did, so
 * no pane id was ever recorded for it the way a session's launch records one;
 * it is resolved here instead — by the window's pinned name, and then
 * addressed as a PANE, never as a session, because a session target resolves
 * to whichever pane is active and a split from inside moves that (decision 46).
 *
 * Listed with `-s`, every pane in the tmux session and not only the current
 * window's: a `tmux new-window` from the conductor's own Bash makes that new
 * window current, and a plain `list-panes -t =name:` would then not show the
 * launch pane at all. Among them the conductor's own is the lowest id on the
 * socket: `launchConductor` kills the whole server before it opens the
 * window, and tmux never reissues a pane id within a server, so the first one
 * minted there is the pane Claude Code runs in.
 */
export function conductorPane(repoProjectId: string): SessionPane | undefined {
  const socket = conductorSocket(repoProjectId);
  const printed = tmuxProbe(socket, [
    'list-panes',
    '-s',
    '-t',
    pinned(conductorName(repoProjectId)),
    '-F',
    '#{pane_id}',
  ]);
  if (printed === undefined) return undefined;
  const paneId = printed
    .split('\n')
    .map((line) => line.trim())
    .filter(isPaneId)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))[0];
  return paneId === undefined
    ? undefined
    : { sessionId: conductorId(repoProjectId), paneId, socket };
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
 * The error a dead turn left on a pane, or undefined when there is nothing to
 * recover. Both halves have to hold: the transcript's last line is Claude
 * Code's API-error line, AND the input box is empty. A turn that is still
 * running has its tool calls under the error; a box with a draft in it is
 * someone typing, and a resume would be pasted onto their sentence.
 *
 * The pane is read for recovery only, and nothing about it is stored: session
 * state is hooks and transcripts (decision 2), and this answers the narrower
 * question of whether there is a turn to restart. What gets recorded is the
 * event and the steer; the pane is the evidence, not the state.
 */
export function deadTurnError(pane: SessionPane): string | undefined {
  // Styled, like every other look at the box: what Claude Code suggests once a
  // turn ends is dim, and reading a suggestion as a draft would hide every
  // dead turn there is (addendum to decision 45).
  if (hasUnsubmittedInput(captureInputBox(pane))) return undefined;
  const line = lastTranscriptLine(capturePane(pane));
  return line !== undefined && TURN_DIED_LINE.test(line) && !TURN_RETRYING.test(line)
    ? line
    : undefined;
}

/**
 * The last line the transcript printed above the input box. Undefined when the
 * pane shows no box — a dialog, a window that died — or nothing above it.
 */
function lastTranscriptLine(pane: string): string | undefined {
  const lines = pane.split('\n');
  let boxIndex = -1;
  lines.forEach((line, index) => {
    if (line.startsWith(BOX_PROMPT)) boxIndex = index;
  });
  if (boxIndex === -1) return undefined;
  for (let index = boxIndex - 1; index >= 0; index--) {
    const line = (lines[index] as string).trimEnd();
    if (!BOX_CHROME.test(line)) return line;
  }
  return undefined;
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

function killIfExists(name: string, socket?: string): void {
  // Pinned to exact match, or a stale name would prefix-match and kill a
  // live sibling.
  killTarget(pinned(name), socket);
}

/**
 * Kill the whole server on `socket`, so what comes next opens on one this
 * process started. Only the conductor's socket is ever passed: on the default
 * server this would kill the operator's every window. Silent when no server is
 * there, like `killTarget`.
 */
function killServerOn(socket: string): void {
  try {
    execFileSync('tmux', onSocket(socket, ['kill-server']), {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: tmuxEnv(),
    });
  } catch {
    // no server on that socket — nothing to kill
  }
}

function killTarget(target: string, socket?: string): void {
  try {
    // Expected to fail when the session (or the tmux server itself) does not
    // exist; pipe stderr so the probe stays silent instead of leaking
    // "error connecting to /tmp/tmux-*" to the operator's terminal.
    execFileSync('tmux', onSocket(socket, ['kill-session', '-t', target]), {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: tmuxEnv(),
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
