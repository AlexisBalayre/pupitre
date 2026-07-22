import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/** Pre-seed trust for a worktree so the launched session skips the trust dialog. */
export function preseedTrust(worktreePath: string): void {
  const config = existsSync(CLAUDE_JSON)
    ? (JSON.parse(readFileSync(CLAUDE_JSON, 'utf8')) as Record<string, unknown>)
    : {};
  const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
  projects[worktreePath] = { ...projects[worktreePath], hasTrustDialogAccepted: true };
  config.projects = projects;
  writeFileSync(CLAUDE_JSON, JSON.stringify(config, null, 2));
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

/** Steer a running session mid-turn. paste-buffer keeps arbitrary text intact. */
export function steerSession(sessionId: string, message: string): void {
  const target = tmuxTarget(sessionId);
  execFileSync('tmux', ['load-buffer', '-'], { input: message });
  tmux('paste-buffer', '-d', '-t', target);
  tmux('send-keys', '-t', target, 'Enter');
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
