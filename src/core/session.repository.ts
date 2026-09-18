import type { Database } from 'better-sqlite3';
import type { EventType, SessionState } from './db.client.js';
import { canTransition, claimedStates } from './session-state.utils.js';

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

export interface TaskRow {
  id: string;
  project_id: string;
  /** JSON TaskSpec. */
  spec: string;
  role: string | null;
  origin: string;
  created_at: string;
}

export interface EventRow {
  id: number;
  session_id: string | null;
  type: EventType;
  /** JSON object; shape depends on `type`. */
  payload: string;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  repo_path: string;
  /** JSON array of adapter ids. */
  adapters: string;
  /** JSON ProjectBaseline; null until `pup init` runs. */
  baseline: string | null;
  /**
   * Origin's URL as the trusted checkout had it when `pup init` recorded it —
   * the push target `pup merge --pr` is held to. Null until a `pup init` run
   * the operator made records one (decision 56).
   */
  origin_url: string | null;
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

/**
 * Record the push target. The one writer of `origin_url`, and it is reached
 * only from an operator's `pup init`: a value a session could nominate would
 * be the thing the gate compares against, which is the whole defence
 * (decision 56).
 */
export function saveProjectOriginUrl(db: Database, id: string, originUrl: string): void {
  db.prepare('UPDATE projects SET origin_url = ? WHERE id = ?').run(originUrl, id);
}

/**
 * How many sessions have ever run for a project. Zero is the only state in
 * which the shared git config has had no writer but the operator, which is what
 * makes a first push-target record trustworthy (decision 56).
 */
export function countProjectSessions(db: Database, projectId: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM sessions s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ?',
    )
    .get(projectId) as { n: number };
  return row.n;
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

/**
 * All tasks in a project, oldest first — `pup report` joins them to sessions
 * by task_id to render each session's intent. `id` breaks ties within one
 * `datetime('now')` second.
 */
export function listTasks(db: Database, projectId: string): TaskRow[] {
  return db
    .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id')
    .all(projectId) as TaskRow[];
}

export function getTask(db: Database, id: string): TaskRow | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
}

/** The session, if any, that has claimed this task and so freezes its spec. */
export function claimingSession(db: Database, taskId: string): string | undefined {
  const claimed = claimedStates();
  const row = db
    .prepare(
      `SELECT id FROM sessions
        WHERE task_id = ? AND state IN (${claimed.map(() => '?').join(', ')})
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(taskId, ...claimed) as { id: string } | undefined;
  return row?.id;
}

/**
 * The backlog: tasks no live or finished session has claimed, oldest first.
 *
 * Derived rather than stored. `tasks.status` used to carry this and was written
 * but never read, so it could drift from the sessions table without anything
 * noticing; the sessions table is the one place session state actually lives,
 * so the backlog is a question asked of it (decision 40).
 */
export function listBacklogTasks(db: Database, projectId: string): TaskRow[] {
  const claimed = claimedStates();
  return db
    .prepare(
      `SELECT * FROM tasks t
        WHERE t.project_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM sessions s
             WHERE s.task_id = t.id AND s.state IN (${claimed.map(() => '?').join(', ')})
          )
        ORDER BY t.created_at, t.id`,
    )
    .all(projectId, ...claimed) as TaskRow[];
}

/**
 * Returns false when the task does not exist or any session ever ran for it.
 *
 * The guard is "no session row at all", not "no claiming session": a killed
 * session's task returns to the backlog, but `sessions.task_id` is a NOT NULL
 * foreign key, so deleting the task would abort on the constraint rather than
 * refuse. History outlives the backlog entry (decision 40).
 */
export function deleteTask(db: Database, id: string): boolean {
  return (
    db
      .prepare(
        `DELETE FROM tasks
          WHERE id = ?
            AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.task_id = tasks.id)`,
      )
      .run(id).changes > 0
  );
}

/**
 * Rewrite a planned task's spec. Refuses once a session has claimed the task:
 * the spec is compiled into that session's `context.md` at launch and is what
 * the merge gate audits scope against, so editing it afterwards would leave the
 * store disagreeing with what the agent was actually told.
 */
export function updateTaskSpec(db: Database, id: string, spec: string): boolean {
  const claimed = claimedStates();
  return (
    db
      .prepare(
        `UPDATE tasks SET spec = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM sessions s
               WHERE s.task_id = tasks.id AND s.state IN (${claimed.map(() => '?').join(', ')})
            )`,
      )
      .run(spec, id, ...claimed).changes > 0
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

/** All events for one session, oldest first (autoincrement id = insertion order). */
export function listEvents(db: Database, sessionId: string): EventRow[] {
  return db
    .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id')
    .all(sessionId) as EventRow[];
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
