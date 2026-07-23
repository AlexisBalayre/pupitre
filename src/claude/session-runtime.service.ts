import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { scrubbedGitEnv } from '../core/git-diff.client.js';
import { hasUnsubmittedInput } from './pane.utils.js';

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
 * Delay between paste-buffer and Enter: the UI needs a beat to fold a large
 * paste into its input box, or the Enter lands mid-processing and the prompt
 * sits unsubmitted (observed on Claude Code 2.1.218 with multi-KB kickoffs).
 */
const PASTE_SETTLE_MS = 700;
/** After Enter, how long to wait before checking that the input box cleared. */
const SUBMIT_VERIFY_MS = 1000;
const SUBMIT_RETRY_LIMIT = 2;

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

/** Block the current thread without spawning a process (CLI-only, short waits). */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function tmuxTarget(sessionId: string): string {
  return `pup-${sessionId}`;
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
      ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', env: scrubbedGitEnv() },
    ).trim();
    return [realpathSync(dirname(commonDir))];
  } catch {
    return [];
  }
}

export function launchSession(opts: LaunchOptions): { target: string } {
  const target = tmuxTarget(opts.sessionId);
  preseedTrust(opts.worktreePath);
  const claudeBin = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  killIfExists(target);
  tmux(
    'new-session',
    '-d',
    '-s',
    target,
    '-x',
    '220',
    '-y',
    '50',
    '-c',
    opts.worktreePath,
    '-e',
    `PUP_SESSION_ID=${opts.sessionId}`,
    // Absolute path to this CLI, so `pup session done` works even when `pup` is
    // not on the session's PATH (dev). Production installs the `pup` bin.
    '-e',
    `PUP_BIN=${process.argv[1] ?? 'pup'}`,
    claudeBin,
    ...(opts.model ? ['--model', opts.model] : []),
    '--dangerously-skip-permissions',
    '--settings',
    opts.settingsPath,
  );
  return { target };
}

/**
 * Steer a running session mid-turn. paste-buffer keeps arbitrary text intact.
 * Enter can land while the UI is still folding a large paste and leave the
 * message unsubmitted (kickoff `delivered:false` in the wild), so submission is
 * verified against the pane and Enter retried. An extra Enter on an already
 * empty input box is a no-op, so a false "still pending" read is harmless.
 */
export function steerSession(sessionId: string, message: string): void {
  const target = tmuxTarget(sessionId);
  execFileSync('tmux', ['load-buffer', '-'], { input: message });
  tmux('paste-buffer', '-d', '-t', target);
  syncSleep(PASTE_SETTLE_MS);
  tmux('send-keys', '-t', target, 'Enter');
  for (let retry = 0; retry < SUBMIT_RETRY_LIMIT; retry++) {
    syncSleep(SUBMIT_VERIFY_MS);
    if (!hasUnsubmittedInput(capturePane(sessionId))) return;
    tmux('send-keys', '-t', target, 'Enter');
  }
}

/** Wait until the session UI is interactive. Returns false on timeout. */
export function waitUntilReady(sessionId: string, timeoutMs = READY_TIMEOUT_MS): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (READY_MARKER.test(capturePane(sessionId))) return true;
    syncSleep(READY_POLL_MS);
  }
  return false;
}

/** Send the first prompt once the session is ready (the compiled task context). */
export function kickoff(sessionId: string, prompt: string): boolean {
  if (!waitUntilReady(sessionId)) return false;
  steerSession(sessionId, prompt);
  return true;
}

export function capturePane(sessionId: string): string {
  return tmux('capture-pane', '-p', '-t', tmuxTarget(sessionId));
}

export function sessionExists(sessionId: string): boolean {
  try {
    tmux('has-session', '-t', tmuxTarget(sessionId));
    return true;
  } catch {
    return false;
  }
}

export function killSession(sessionId: string): void {
  killIfExists(tmuxTarget(sessionId));
}

function killIfExists(target: string): void {
  try {
    tmux('kill-session', '-t', target);
  } catch {
    // not running — nothing to kill
  }
}

/** Transcript directory Claude Code uses for a given worktree (munged real path). */
export function transcriptDir(worktreePath: string): string {
  const munged = worktreePath.replace(/[^a-zA-Z0-9]/g, '-');
  return join(homedir(), '.claude', 'projects', munged);
}
