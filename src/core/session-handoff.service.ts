import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  kickoff,
  killSession as killTmux,
  launchSession,
  steerPane,
} from '../claude/session-runtime.service.js';
import { codegraphBinary, prepareGraph } from './codegraph.client.js';
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

/** Thrown when `handoff-done` is run before the handoff document exists. */
export class HandoffMissingError extends Error {
  constructor(sessionId: string, handoffPath: string) {
    super(
      `No handoff at ${handoffPath}. Write the document for ${sessionId} before running ` +
        '`pup session handoff-done`.',
    );
    this.name = 'HandoffMissingError';
  }
}

/**
 * The handoff document, or undefined when there is none. Read as text rather
 * than hashed in place so a caller hashes the very bytes it goes on to use:
 * two reads are two chances for the file to change between them (decision 49).
 */
function readHandoff(handoffPath: string): string | undefined {
  return existsSync(handoffPath) ? readFileSync(handoffPath, 'utf8') : undefined;
}

function hashHandoff(document: string): string {
  return createHash('sha256').update(document).digest('hex');
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
  // A new request answers with a new file. Whatever is on disk now — the
  // session's own handoff from an earlier round, or one another session wrote
  // while waiting for this moment — must not be able to satisfy this request
  // by sitting there unchanged (decision 49).
  rmSync(handoffPath, { force: true });
  steerPane(sessionPane(session), handoffInstructions(handoffPath));
  appendEvent(db, sessionId, 'steer', { kind: 'handoff-request' });
  return handoffPath;
}

/**
 * The hash the session signalled for, from the latest `handoff_ready` that
 * follows the request steer. With no request on record `MAX(id)` is NULL and
 * the comparison is never true, so a `handoff_ready` nobody asked for names no
 * hash and no session is ready by it (decision 44).
 */
function signalledHash(db: Database, sessionId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT payload FROM events WHERE session_id = ? AND type = 'handoff_ready'
       AND id > (SELECT MAX(id) FROM events WHERE session_id = ? AND type = 'steer'
                 AND payload LIKE '%handoff-request%')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(sessionId, sessionId) as { payload: string } | undefined;
  const hash = row ? (JSON.parse(row.payload) as { hash?: unknown }).hash : undefined;
  return typeof hash === 'string' ? hash : undefined;
}

/**
 * True once the session has signalled handoff-done after the request steer and
 * the file on disk is still the one it signalled for. A tampered file is not
 * readiness but a fresh request: `pup respawn` asks again rather than wedging
 * on a document the respawn is going to refuse anyway (decision 49).
 */
export function isHandoffReady(
  db: Database,
  repoPath: string,
  sessionId: string,
  pathsBase?: string,
): boolean {
  const signalled = signalledHash(db, sessionId);
  if (signalled === undefined) return false;
  const document = readHandoff(projectPaths(repoPath, pathsBase).handoffFile(sessionId));
  return document !== undefined && hashHandoff(document) === signalled;
}

/**
 * Recorded by `pup session handoff-done` (run by the agent). The event names
 * the content the session is signalling for, which is what lets the respawn
 * tell that document from one substituted afterwards (decision 49).
 */
export function markHandoffReady(
  db: Database,
  repoPath: string,
  sessionId: string,
  pathsBase?: string,
): void {
  const handoffPath = projectPaths(repoPath, pathsBase).handoffFile(sessionId);
  const document = readHandoff(handoffPath);
  if (document === undefined) throw new HandoffMissingError(sessionId, handoffPath);
  appendEvent(db, sessionId, 'handoff_ready', { hash: hashHandoff(document) });
}

export function awaitHandoffReady(
  db: Database,
  repoPath: string,
  sessionId: string,
  timeoutMs = HANDOFF_WAIT_DEFAULT_MS,
  pathsBase?: string,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isHandoffReady(db, repoPath, sessionId, pathsBase)) return true;
    syncSleep(HANDOFF_POLL_MS);
  }
  return isHandoffReady(db, repoPath, sessionId, pathsBase);
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
  const handoff = readHandoff(handoffPath);
  if (handoff === undefined) {
    throw new Error(
      `No handoff at ${handoffPath}. Run \`pup respawn ${sessionId}\` to request one first.`,
    );
  }
  // The file is writable by anything running as this user, and the wait above
  // polls every 5 s, so the document read here need not be the one the session
  // signalled for. Hashing the read itself leaves no second read to substitute
  // for: either these are the bytes handoff-done named, or nothing is kicked
  // off on them (decision 49).
  const signalled = signalledHash(db, sessionId);
  if (hashHandoff(handoff) !== signalled) {
    throw new Error(
      `Handoff for ${sessionId} at ${handoffPath} is not the document it signalled ` +
        `(handoff-done recorded ${signalled ?? 'no hash'}, on disk ${hashHandoff(handoff)}); ` +
        `something replaced it since. Re-run \`pup respawn ${sessionId}\` to ask again.`,
    );
  }
  relaunchWindow(db, repoPath, sessionId, session, paths.compiledDir(sessionId), {
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
  relaunchWindow(db, repoPath, sessionId, session, paths.compiledDir(sessionId), {
    promptSuffix:
      '\n\n## Fresh start after a kill\n' +
      'The previous run of this session was killed without writing a handoff (it was ' +
      'likely wedged or crashed). The worktree may hold partial work: check `git status` ' +
      'and `git log` before doing anything, keep what is sound, and continue the task.',
    eventPayload: { hard: true },
  });
}

/**
 * The respawned window's code graph, or undefined when it gets none. The
 * compiled `mcp.json` is the launch's, binary and worktree path already fixed
 * at compile time — nothing is recompiled here, because a respawn is the same
 * session on a fresh context window and its profile hash must not move.
 *
 * The index IS re-run: the worktree has been edited since the launch, and an
 * index the session's own commits have outrun answers its questions out of code
 * that is no longer there. Withheld when the operator's codegraph has gone
 * since, so a window is never pointed at a server that cannot start
 * (decision 51).
 */
function graphForRespawn(
  repoPath: string,
  worktreePath: string,
  compiledDir: string,
): string | undefined {
  const mcpConfigPath = join(compiledDir, 'mcp.json');
  if (!existsSync(mcpConfigPath)) return undefined;
  return prepareGraph(codegraphBinary(repoPath), repoPath, worktreePath)
    ? mcpConfigPath
    : undefined;
}

function relaunchWindow(
  db: Database,
  repoPath: string,
  sessionId: string,
  session: SessionRow,
  compiledDir: string,
  extras: { promptSuffix: string; eventPayload: Record<string, unknown> },
): void {
  const contextMarkdown = readFileSync(join(compiledDir, 'context.md'), 'utf8');
  killTmux(sessionId, session.tmux_target);
  // After the kill: the previous run writes to this worktree until it dies, and
  // an index taken while it is still editing is an index of a tree nothing will
  // ever see again.
  const mcpConfigPath = graphForRespawn(repoPath, session.worktree_path, compiledDir);
  const pane = launchSession({
    sessionId,
    worktreePath: session.worktree_path,
    settingsPath: join(compiledDir, 'settings.json'),
    // The context carries the `## Code graph` section whenever the launch
    // compiled one, so a respawn without this flag tells the session to use a
    // tool that is not connected — the gap decision 51's addendum named.
    mcpConfigPath,
  });
  // A fresh window is a fresh pane: stored before the kickoff types into it,
  // so a steer that races the respawn is refused or lands here, never in the
  // old pane's successor.
  db.prepare('UPDATE sessions SET tmux_target = ? WHERE id = ?').run(pane.paneId, sessionId);
  const delivered = kickoff(pane, contextMarkdown + extras.promptSuffix);
  appendEvent(db, sessionId, 'respawn', { delivered, ...extras.eventPayload });
}
