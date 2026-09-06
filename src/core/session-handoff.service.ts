import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  kickoff,
  killSession as killTmux,
  launchSession,
  steerPane,
} from '../claude/session-runtime.service.js';
import { projectPaths } from './paths.utils.js';
import { appendEvent, getSession, type SessionRow } from './session.repository.js';
import { sessionPane } from './session-lifecycle.service.js';

const HANDOFF_POLL_MS = 5_000;
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
  const session = requireRunning(db, sessionId);
  const handoffPath = projectPaths(repoPath, pathsBase).handoffFile(sessionId);
  steerPane(sessionPane(session), handoffInstructions(handoffPath));
  appendEvent(db, sessionId, 'steer', { kind: 'handoff-request' });
  return handoffPath;
}

/**
 * True once the session has signalled handoff-done after the request steer.
 * With no request on record `MAX(id)` is NULL and the comparison is never
 * true: a `handoff_ready` nobody asked for does not make a session ready, so
 * a respawn cannot be staged by writing the event first (decision 44).
 */
export function isHandoffReady(db: Database, sessionId: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'handoff_ready'
       AND id > (SELECT MAX(id) FROM events WHERE session_id = ? AND type = 'steer'
                 AND payload LIKE '%handoff-request%')`,
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
  const handoff = readFileSync(handoffPath, 'utf8');
  relaunchWindow(db, sessionId, session, paths.compiledDir(sessionId), {
    promptSuffix: `\n\n## Handoff from your previous run\n${handoff}`,
    eventPayload: { handoffBytes: handoff.length },
  });
}

/**
 * `pup kill --respawn`: the escape hatch for a wedged or crashed window that
 * cannot answer a handoff steer. Same session, fresh window, no handoff — the
 * kickoff tells the fresh run its predecessor was killed so it inspects the
 * worktree instead of assuming a clean start.
 */
export function hardRespawnSession(
  db: Database,
  repoPath: string,
  sessionId: string,
  pathsBase?: string,
): void {
  const session = requireRunning(db, sessionId);
  const paths = projectPaths(repoPath, pathsBase);
  relaunchWindow(db, sessionId, session, paths.compiledDir(sessionId), {
    promptSuffix:
      '\n\n## Fresh start after a kill\n' +
      'The previous run of this session was killed without writing a handoff (it was ' +
      'likely wedged or crashed). The worktree may hold partial work: check `git status` ' +
      'and `git log` before doing anything, keep what is sound, and continue the task.',
    eventPayload: { hard: true },
  });
}

function relaunchWindow(
  db: Database,
  sessionId: string,
  session: SessionRow,
  compiledDir: string,
  extras: { promptSuffix: string; eventPayload: Record<string, unknown> },
): void {
  const contextMarkdown = readFileSync(join(compiledDir, 'context.md'), 'utf8');
  killTmux(sessionId, session.tmux_target);
  const pane = launchSession({
    sessionId,
    worktreePath: session.worktree_path,
    settingsPath: join(compiledDir, 'settings.json'),
  });
  // A fresh window is a fresh pane: stored before the kickoff types into it,
  // so a steer that races the respawn is refused or lands here, never in the
  // old pane's successor.
  db.prepare('UPDATE sessions SET tmux_target = ? WHERE id = ?').run(pane.paneId, sessionId);
  const delivered = kickoff(pane, contextMarkdown + extras.promptSuffix);
  appendEvent(db, sessionId, 'respawn', { delivered, ...extras.eventPayload });
}
