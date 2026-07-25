import type { Database } from 'better-sqlite3';
import type { EventType, SessionState } from './db.client.js';
import { canTransition } from './session-state.utils.js';

export interface SessionRow {
  id: string;
  task_id: string;
  worktree_path: string;
  branch: string;
  tmux_target: string | null;
  pid: number | null;
  state: SessionState;
  profile_hash: string;
  transcript_path: string | null;
  reject_count: number;
  created_at: string;
}

export class InvalidTransitionError extends Error {
  constructor(from: SessionState, to: SessionState) {
    super(`Illegal session transition ${from} -> ${to}.`);
    this.name = 'InvalidTransitionError';
  }
}

export interface NewSessionInput {
  id: string;
  taskId: string;
  worktreePath: string;
  branch: string;
  profileHash: string;
  tmuxTarget?: string;
  pid?: number;
  transcriptPath?: string;
}

export interface ProjectRow {
  id: string;
  repo_path: string;
  /** JSON array of adapter ids. */
  adapters: string;
  /** JSON ProjectBaseline; null until `pup init` runs. */
  baseline: string | null;
  created_at: string;
}

export function ensureProject(db: Database, id: string, repoPath: string): void {
  db.prepare('INSERT OR IGNORE INTO projects (id, repo_path) VALUES (?, ?)').run(id, repoPath);
}

export function getProject(db: Database, id: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
}

export function saveProjectBaseline(
  db: Database,
  id: string,
  adapters: string[],
  baseline: string,
): void {
  db.prepare('UPDATE projects SET adapters = ?, baseline = ? WHERE id = ?').run(
    JSON.stringify(adapters),
    baseline,
    id,
  );
}

export function insertTask(
  db: Database,
  input: { id: string; projectId: string; spec: string; role?: string; origin?: string },
): void {
  db.prepare('INSERT INTO tasks (id, project_id, spec, role, origin) VALUES (?, ?, ?, ?, ?)').run(
    input.id,
    input.projectId,
    input.spec,
    input.role ?? null,
    input.origin ?? 'human',
  );
}

export function insertSession(db: Database, input: NewSessionInput): void {
  db.prepare(
    `INSERT INTO sessions (id, task_id, worktree_path, branch, profile_hash, tmux_target, pid, transcript_path)
     VALUES (@id, @taskId, @worktreePath, @branch, @profileHash, @tmuxTarget, @pid, @transcriptPath)`,
  ).run({
    id: input.id,
    taskId: input.taskId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    profileHash: input.profileHash,
    tmuxTarget: input.tmuxTarget ?? null,
    pid: input.pid ?? null,
    transcriptPath: input.transcriptPath ?? null,
  });
}

export function getSession(db: Database, id: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

/**
 * The session whose worktree contains `path`, if any. Unlike `PUP_SESSION_ID`
 * this cannot be unset by the process being identified, so it is the primary
 * answer to "is a session running this command?" (decision 27).
 */
export function findSessionByWorktree(db: Database, path: string): SessionRow | undefined {
  return listSessions(db).find(
    (session) => path === session.worktree_path || path.startsWith(`${session.worktree_path}/`),
  );
}

export function listSessions(db: Database, states?: SessionState[]): SessionRow[] {
  if (states?.length) {
    const placeholders = states.map(() => '?').join(', ');
    return db
      .prepare(`SELECT * FROM sessions WHERE state IN (${placeholders}) ORDER BY created_at`)
      .all(...states) as SessionRow[];
  }
  return db.prepare('SELECT * FROM sessions ORDER BY created_at').all() as SessionRow[];
}

/**
 * Move a session to a new state, validating the transition and recording the
 * change as an event in the same write. Returns the updated row.
 */
export function transitionSession(
  db: Database,
  id: string,
  to: SessionState,
  eventPayload: Record<string, unknown> = {},
): SessionRow {
  const tx = db.transaction((sessionId: string, target: SessionState) => {
    const row = getSession(db, sessionId);
    if (!row) throw new Error(`No session ${sessionId}.`);
    if (row.state === target) return row;
    if (!canTransition(row.state, target)) throw new InvalidTransitionError(row.state, target);
    db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(target, sessionId);
    appendEvent(db, sessionId, 'gate_result', { from: row.state, to: target, ...eventPayload });
    return { ...row, state: target };
  });
  return tx(id, to);
}

export function appendEvent(
  db: Database,
  sessionId: string | null,
  type: EventType,
  payload: Record<string, unknown> = {},
): void {
  db.prepare('INSERT INTO events (session_id, type, payload) VALUES (?, ?, ?)').run(
    sessionId,
    type,
    JSON.stringify(payload),
  );
}

export function incrementRejectCount(db: Database, id: string): number {
  const row = db
    .prepare(
      'UPDATE sessions SET reject_count = reject_count + 1 WHERE id = ? RETURNING reject_count',
    )
    .get(id) as { reject_count: number } | undefined;
  if (!row) throw new Error(`No session ${id}.`);
  return row.reject_count;
}
