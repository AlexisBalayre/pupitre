import type { Database } from 'better-sqlite3';
import type { EventType, SessionState } from './db.client.js';
import { InvalidProfileError } from './profile.errors.js';
import { parseJsonOr } from './report-data.utils.js';
import { canTransition, claimedStates } from './session-state.utils.js';
import { assertPlannableSpec } from './task-spec.utils.js';
import type { TaskId, TaskSpec } from './types/profile.types.js';

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

/**
 * A stored spec a command that acts on it cannot use: not JSON, the wrong shape,
 * or failing the checks `pup plan add` runs. An InvalidProfileError, so every
 * command that already refuses an unplannable spec refuses this one too.
 *
 * The message is store text: it names the task id, and through
 * `assertPlannableSpec` the glob that failed, so whoever prints it scrubs it
 * (decision 68). What it never carries is the raw blob — a SyntaxError's
 * message quotes the bytes it choked on, and that one is swallowed here.
 */
export class MalformedTaskSpecError extends InvalidProfileError {
  constructor(
    readonly taskId: string,
    reason: string,
  ) {
    super(`Task ${taskId} has an unusable spec: ${reason}`);
    this.name = 'MalformedTaskSpecError';
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
  /**
   * When `pup project dormant` put the project to sleep, or null while it is
   * active; the fleet views and the radar pass over it (decision 62).
   */
  dormant_at: string | null;
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
 * Put a project to sleep, or wake it with `null`. The one writer of
 * `dormant_at`, reached only from the operator's `pup project dormant|wake`
 * (decision 62).
 */
export function saveProjectDormantAt(db: Database, id: string, dormantAt: string | null): void {
  db.prepare('UPDATE projects SET dormant_at = ? WHERE id = ?').run(dormantAt, id);
}

/** Whether the project's row says it is dormant; a project with no row is not. */
export function isProjectDormant(db: Database, id: string): boolean {
  return (getProject(db, id)?.dormant_at ?? null) !== null;
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * The spec as stored, shape-checked only (decision 68). The row key wins over
 * the blob: identity comes from the trusted primary key, the spec is
 * authoritative only for intent. A spec whose `id` had drifted would compile
 * one task's hooks under another task's session row, leaving the gate auditing
 * a different spec than the hooks enforce.
 */
function decodeTaskSpec(row: TaskRow): TaskSpec {
  let value: unknown;
  try {
    value = JSON.parse(row.spec);
  } catch {
    throw new MalformedTaskSpecError(row.id, 'it is not valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MalformedTaskSpecError(row.id, 'it is not a JSON object.');
  }
  const spec = value as Partial<Record<keyof TaskSpec, unknown>>;
  for (const field of ['scopeIn', 'scopeOut'] as const) {
    if (spec[field] !== undefined && !isStringArray(spec[field])) {
      throw new MalformedTaskSpecError(row.id, `its ${field} is not a list of globs.`);
    }
  }
  const decoded = value as Partial<TaskSpec>;
  return {
    ...(decoded as TaskSpec),
    id: row.id as TaskId,
    scopeIn: decoded.scopeIn ?? [],
    scopeOut: decoded.scopeOut ?? [],
  };
}

/**
 * The one reader of a stored spec for a command that acts on it — launch, the
 * gate, review, the overlap check. Strict: a spec this cannot use is a refusal
 * naming the task, never a SyntaxError or a TypeError further down. Runs the
 * checks `pup plan add` ran, because a row can predate them (decision 40).
 */
export function readTaskSpec(db: Database, taskId: string): TaskSpec {
  const row = getTask(db, taskId);
  if (!row) throw new MalformedTaskSpecError(taskId, 'no such task is stored.');
  const spec = decodeTaskSpec(row);
  try {
    assertPlannableSpec(spec);
  } catch (error) {
    if (!(error instanceof InvalidProfileError)) throw error;
    throw new MalformedTaskSpecError(row.id, error.message);
  }
  return spec;
}

/**
 * The spec for a page that only shows it — the report, the dossier, the
 * dashboard, the backlog listing. Tolerant: one bad row degrades to the empty
 * copy instead of killing the page. Shape only; renderers keep their own
 * scrubbing (decision 68).
 */
export function taskSpecForDisplay(row: Pick<TaskRow, 'spec'> | undefined): Partial<TaskSpec> {
  return row ? parseJsonOr<Partial<TaskSpec>>(row.spec, {}) : {};
}

type TaskSpecPatch = Partial<Pick<TaskSpec, 'goal' | 'scopeIn' | 'scopeOut' | 'acceptance'>>;

/**
 * `pup plan edit`: merge the given fields over the stored spec, validate the
 * result, write it. The only `UPDATE tasks SET spec` there is, so it runs
 * exactly the validation `plan add` runs — otherwise edit could store a spec
 * add would have refused, and the failure would surface at launch. The stored
 * spec is not validated first: edit is how a row that fails it gets repaired.
 */
export function editTaskSpec(
  db: Database,
  id: string,
  patch: TaskSpecPatch,
): 'updated' | 'unknown' | 'claimed' {
  const row = getTask(db, id);
  if (!row) return 'unknown';
  const spec = decodeTaskSpec(row);
  const edited: TaskSpec = {
    ...spec,
    goal: patch.goal ?? spec.goal,
    scopeIn: patch.scopeIn ?? spec.scopeIn,
    scopeOut: patch.scopeOut ?? spec.scopeOut,
    acceptance: patch.acceptance ?? spec.acceptance,
  };
  assertPlannableSpec(edited);
  return updateTaskSpec(db, id, JSON.stringify(edited)) ? 'updated' : 'claimed';
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
