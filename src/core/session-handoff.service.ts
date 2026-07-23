import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  kickoff,
  killSession as killTmux,
  launchSession,
  steerSession,
} from '../claude/session-runtime.service.js';
import { projectPaths } from './paths.utils.js';
import { appendEvent, getSession, type SessionRow } from './session.repository.js';

export const HANDOFF_POLL_MS = 5_000;
export const HANDOFF_WAIT_DEFAULT_MS = 10 * 60 * 1000;

/**
 * Suggest a respawn above this context size. Conservative for 200k-window
 * models; sessions on larger windows can simply ignore the hint.
 */
export const RESPAWN_SUGGEST_TOKENS = 120_000;

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function requireRunning(db: Database, sessionId: string): SessionRow {
  const session = getSession(db, sessionId);
  if (!session) throw new Error(`No session ${sessionId}.`);
  if (session.state !== 'running') {
    throw new Error(`Session ${sessionId} is ${session.state}; only running sessions respawn.`);
  }
  return session;
}

function handoffInstructions(handoffPath: string): string {
  return [
    'Pupitre is about to respawn this session with a fresh context window.',
    `Write a handoff document to ${handoffPath} (overwrite it if it exists) for the fresh`,
    'session that will replace you. It knows nothing you have not written down. Cover:',
    'what the task is, what is already done (with file paths), what remains, decisions made',
    'and why, and any gotchas or dead ends that cost you time. Do NOT commit the handoff',
    'file. When the file is written, run exactly: `pup session handoff-done`',
    '(or `node "$PUP_BIN" session handoff-done` if pup is not on PATH), then stop.',
  ].join('\n');
}

/** Steer the running session to write its handoff (decision 4: queues until turn end). */
export function requestHandoff(
  db: Database,
  repoPath: string,
  sessionId: string,
  pathsBase?: string,
): string {
  requireRunning(db, sessionId);
  const handoffPath = projectPaths(repoPath, pathsBase).handoffFile(sessionId);
  steerSession(sessionId, handoffInstructions(handoffPath));
  appendEvent(db, sessionId, 'steer', { kind: 'handoff-request' });
  return handoffPath;
}

/** True once the session has signalled handoff-done after the request steer. */
export function isHandoffReady(db: Database, sessionId: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'handoff_ready'
       AND id > COALESCE((SELECT MAX(id) FROM events WHERE session_id = ? AND type = 'steer'
                          AND payload LIKE '%handoff-request%'), 0)`,
    )
    .get(sessionId, sessionId) as { n: number };
  return row.n > 0;
}

/** Recorded by `pup session handoff-done` (run by the agent). */
export function markHandoffReady(db: Database, sessionId: string): void {
  appendEvent(db, sessionId, 'handoff_ready', {});
}

export function awaitHandoffReady(
  db: Database,
  sessionId: string,
  timeoutMs = HANDOFF_WAIT_DEFAULT_MS,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isHandoffReady(db, sessionId)) return true;
    syncSleep(HANDOFF_POLL_MS);
  }
  return isHandoffReady(db, sessionId);
}

/**
 * Replace the session's tmux pane with a fresh `claude` in the same worktree,
 * branch, and session id, kicked off with the original compiled context plus
 * the handoff. The session row is untouched: this is the same session on a
 * fresh context window, not a new one — profile hash and history carry over.
 */
export function respawnSession(
  db: Database,
  repoPath: string,
  sessionId: string,
  pathsBase?: string,
): void {
  const session = requireRunning(db, sessionId);
  const paths = projectPaths(repoPath, pathsBase);
  const handoffPath = paths.handoffFile(sessionId);
  if (!existsSync(handoffPath)) {
    throw new Error(
      `No handoff at ${handoffPath}. Run \`pup respawn ${sessionId}\` to request one first.`,
    );
  }
  const compiledDir = paths.compiledDir(sessionId);
  const contextMarkdown = readFileSync(join(compiledDir, 'context.md'), 'utf8');
  const handoff = readFileSync(handoffPath, 'utf8');

  killTmux(sessionId);
  const { target } = launchSession({
    sessionId,
    worktreePath: session.worktree_path,
    settingsPath: join(compiledDir, 'settings.json'),
  });
  db.prepare('UPDATE sessions SET tmux_target = ? WHERE id = ?').run(target, sessionId);
  const prompt = `${contextMarkdown}\n\n## Handoff from your previous run\n${handoff}`;
  const delivered = kickoff(sessionId, prompt);
  appendEvent(db, sessionId, 'respawn', { delivered, handoffBytes: handoff.length });
}
