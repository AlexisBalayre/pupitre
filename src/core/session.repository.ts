import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import type { Tier } from '../claude/model-ladder.constants.js';
import type { EventType, SessionState } from './db.client.js';
import { InvalidProfileError } from './profile.errors.js';
import { asStringArray, parseJsonOr } from './report-data.utils.js';
import { canTransition, claimedStates } from './session-state.utils.js';
import { assertPlannableSpec } from './task-spec.utils.js';
import type { TaskId, TaskSpec } from './types/profile.types.js';
import type {
  EventPayloads,
  SessionEvent,
  StoredGateReport,
  StoredGateStage,
  TransitionPayload,
} from './types/session-event.types.js';

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
  /** The task's tier when the session launched; null on a session launched before routing (decision 92). */
  tier: string | null;
  /** Where on its tier's ladder the session's window runs, counted from 0. */
  rung: number | null;
  /** The model and effort its window's argv carries. */
  model: string | null;
  effort: string | null;
  /** Why the rung last climbed: a `ClimbReason`, or null on the first rung. */
  rung_reason: string | null;
  /** 1 when an explicit --model/--effort overrode the rung's; the rung still tracks the climb. */
  route_override: number;
  created_at: string;
}

/**
 * What a session's window runs on, as the store records it (decision 92). The
 * rung is kept under an override too, so a later relaunch without one climbs
 * from where the task actually stands.
 */
export interface SessionRoute {
  tier: Tier;
  rung: number;
  model: string;
  effort: string;
  reason?: string;
  override: boolean;
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
  route?: SessionRoute;
}

export interface TaskRow {
  id: string;
  project_id: string;
  /** JSON TaskSpec. */
  spec: string;
  role: string | null;
  origin: string;
  /** The tier the operator set with `--tier`; null when the scope-in decides it (decision 92). */
  tier: string | null;
  created_at: string;
}

/**
 * Every type the store holds: the schema's, `landed`, which `pup land` writes
 * (decision 84), `fix_round`, which `pup fix` writes (decision 90), and
 * `rescope`, which `pup plan edit --rescope` writes (decision 115), the three
 * `EventType` has yet to join.
 */
type StoredEventType = EventType | 'landed' | 'fix_round' | 'rescope';

export interface EventRow {
  id: number;
  session_id: string | null;
  type: StoredEventType;
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
  input: {
    id: string;
    projectId: string;
    spec: string;
    role?: string;
    origin?: string;
    tier?: Tier;
  },
): void {
  db.prepare(
    'INSERT INTO tasks (id, project_id, spec, role, origin, tier) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    input.id,
    input.projectId,
    input.spec,
    input.role ?? null,
    input.origin ?? 'human',
    input.tier ?? null,
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
 * Rewrite a planned task's spec, and its tier when one is given. Refuses once
 * a session has claimed the task: the spec is compiled into that session's
 * `context.md` at launch and is what the merge gate audits scope against, and
 * the tier chose the model it runs on, so editing either afterwards would
 * leave the store disagreeing with what the agent was actually told.
 */
export function updateTaskSpec(db: Database, id: string, spec: string, tier?: Tier): boolean {
  const claimed = claimedStates();
  return (
    db
      .prepare(
        `UPDATE tasks SET spec = ?, tier = COALESCE(?, tier)
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM sessions s
               WHERE s.task_id = tasks.id AND s.state IN (${claimed.map(() => '?').join(', ')})
            )`,
      )
      .run(spec, tier ?? null, id, ...claimed).changes > 0
  );
}

/**
 * States in which a session is at work on its task: about to launch, editing,
 * or steered back by the gate that rejected it. Its hooks were compiled from
 * the spec it holds, so a rescope waits for it to stop (decision 115).
 */
const WORKING_STATES: SessionState[] = ['queued', 'running', 'rejected'];

/** The session, if any, at work on this task right now. */
export function workingSession(db: Database, taskId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT id FROM sessions
        WHERE task_id = ? AND state IN (${WORKING_STATES.map(() => '?').join(', ')})
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(taskId, ...WORKING_STATES) as { id: string } | undefined;
  return row?.id;
}

/**
 * Rewrite a claimed task's spec for `pup plan edit --rescope`. Refused, with
 * nothing written, while a session is at work on the task: the guard is in the
 * statement, so a launch or fix round that starts after the caller checked
 * still wins (decision 115).
 */
export function rescopeTaskSpec(db: Database, id: string, spec: string): boolean {
  return (
    db
      .prepare(
        `UPDATE tasks SET spec = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM sessions s
               WHERE s.task_id = tasks.id
                 AND s.state IN (${WORKING_STATES.map(() => '?').join(', ')})
            )`,
      )
      .run(spec, id, ...WORKING_STATES).changes > 0
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

type TaskSpecPatch = Partial<Pick<TaskSpec, 'goal' | 'scopeIn' | 'scopeOut' | 'acceptance'>> & {
  tier?: Tier;
};

/**
 * `pup plan edit`: merge the given fields over the stored spec, validate the
 * result, write it, with the tier when `--tier` set one. The only
 * `UPDATE tasks SET spec` there is, so it runs exactly the validation
 * `plan add` runs — otherwise edit could store a spec add would have refused,
 * and the failure would surface at launch. The stored spec is not validated
 * first: edit is how a row that fails it gets repaired.
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
  return updateTaskSpec(db, id, JSON.stringify(edited), patch.tier) ? 'updated' : 'claimed';
}

export function insertSession(db: Database, input: NewSessionInput): void {
  db.prepare(
    `INSERT INTO sessions (id, task_id, worktree_path, branch, profile_hash, tmux_target, pid, transcript_path,
                           tier, rung, model, effort, rung_reason, route_override)
     VALUES (@id, @taskId, @worktreePath, @branch, @profileHash, @tmuxTarget, @pid, @transcriptPath,
             @tier, @rung, @model, @effort, @reason, @override)`,
  ).run({
    id: input.id,
    taskId: input.taskId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    profileHash: input.profileHash,
    tmuxTarget: input.tmuxTarget ?? null,
    pid: input.pid ?? null,
    transcriptPath: input.transcriptPath ?? null,
    ...routeColumns(input.route),
  });
}

/** Record what a respawned session's fresh window runs on (decision 92). */
export function recordSessionRoute(db: Database, id: string, route: SessionRoute): void {
  db.prepare(
    `UPDATE sessions
        SET tier = @tier, rung = @rung, model = @model, effort = @effort,
            rung_reason = @reason, route_override = @override
      WHERE id = @id`,
  ).run({ id, ...routeColumns(route) });
}

function routeColumns(route: SessionRoute | undefined) {
  return {
    tier: route?.tier ?? null,
    rung: route?.rung ?? null,
    model: route?.model ?? null,
    effort: route?.effort ?? null,
    reason: route?.reason ?? null,
    override: route?.override ? 1 : 0,
  };
}

/** Every session a task has had, oldest first: the newest is where a relaunch climbs from. */
export function listTaskSessions(db: Database, taskId: string): SessionRow[] {
  return db
    .prepare('SELECT * FROM sessions WHERE task_id = ? ORDER BY created_at, rowid')
    .all(taskId) as SessionRow[];
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
  eventPayload: TransitionPayload = {},
): SessionRow {
  const tx = db.transaction((sessionId: string, target: SessionState) => {
    const row = getSession(db, sessionId);
    if (!row) throw new Error(`No session ${sessionId}.`);
    if (row.state === target) return row;
    if (!canTransition(row.state, target)) throw new InvalidTransitionError(row.state, target);
    db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(target, sessionId);
    logTransition(db, sessionId, { from: row.state, to: target }, eventPayload);
    return { ...row, state: target };
  });
  return tx(id, to);
}

/**
 * Move a session along an edge `canTransition` refuses, the CI fix round's
 * (decision 90), logged as every transition is in the same write. Refused,
 * with nothing written, when the row is no longer at `edge.from`.
 */
export function transitionSessionAlong(
  db: Database,
  id: string,
  edge: { from: SessionState; to: SessionState },
  eventPayload: TransitionPayload,
): void {
  db.transaction(() => {
    const moved = db
      .prepare('UPDATE sessions SET state = ? WHERE id = ? AND state = ?')
      .run(edge.to, id, edge.from);
    if (moved.changes === 0) {
      throw new Error(`Session ${sanitizeReason(id)} is no longer ${edge.from}.`);
    }
    logTransition(db, id, edge, eventPayload);
  })();
}

function logTransition(
  db: Database,
  sessionId: string,
  { from, to }: { from: SessionState; to: SessionState },
  eventPayload: TransitionPayload,
): void {
  appendEvent(db, sessionId, 'gate_result', { from, to, ...eventPayload });
}

export function appendEvent<TType extends StoredEventType>(
  db: Database,
  sessionId: string | null,
  type: TType,
  payload: EventPayloads[TType],
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

/**
 * The `fix_round` event of the CI fix round a session is in (decision 90):
 * the newest of its `fix_round`, `merge` and `landed` events, when that is a
 * `fix_round`. A round ends at the merge its re-gate records.
 */
export function currentFixRound(db: Database, sessionId: string): EventRow | undefined {
  const newest = listEvents(db, sessionId)
    .reverse()
    .find((event) => ['fix_round', 'merge', 'landed'].includes(event.type));
  return newest?.type === 'fix_round' ? newest : undefined;
}

/**
 * Read one stored event back as the shape its type was written with — the one
 * place a payload is parsed. A payload is session-writable: one that is not
 * JSON, or a field of the wrong type, reads as absent rather than throwing, so
 * a torn row degrades the reader that meets it instead of ending it. It guards
 * shape and never sanitizes (decision 68).
 */
export function decodeEvent(row: Pick<EventRow, 'type' | 'payload'>): SessionEvent {
  const parsed = parseJsonOr<Record<string, unknown>>(row.payload, {});
  // Every writer stores an object; a top-level array is a torn row like any other.
  const fields = Array.isArray(parsed) ? {} : parsed;
  const text = (key: string): string | undefined => {
    const value = fields[key];
    return typeof value === 'string' ? value : undefined;
  };
  switch (row.type) {
    case 'gate_result':
      return {
        type: 'gate_result',
        report: decodeGateReport(fields.report),
        from: text('from'),
        to: text('to'),
        outcome: text('outcome'),
        reason: text('reason'),
      };
    case 'merge':
      return {
        type: 'merge',
        sha: text('sha'),
        target: text('target'),
        files: asStringArray(fields.files),
        prUrl: text('prUrl'),
        leftBehind: Number.isSafeInteger(fields.leftBehind)
          ? (fields.leftBehind as number)
          : undefined,
      };
    case 'steer':
      return { type: 'steer', kind: text('kind'), by: text('by') };
    case 'session_done':
      return { type: 'session_done', summary: text('summary') };
    case 'question':
      return { type: 'question', text: text('text') };
    case 'turn_died':
      // Keys in the order the watchdog writes them: the dossier prints this
      // event as the JSON it was stored as.
      return {
        type: 'turn_died',
        reason: text('reason'),
        stalledAt: text('stalledAt'),
        refusal: text('refusal'),
      };
    case 'handoff_ready':
      return { type: 'handoff_ready', hash: text('hash') };
    default:
      return { type: 'other', eventType: row.type, fields };
  }
}

function decodeGateReport(value: unknown): StoredGateReport | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const report = value as { passed?: unknown; stages?: unknown };
  return {
    passed: report.passed === true,
    stages: Array.isArray(report.stages) ? report.stages.flatMap(decodeGateStage) : [],
  };
}

/** One `null` member, or a stage with no `status`, drops out rather than ending the list. */
function decodeGateStage(member: unknown): StoredGateStage[] {
  if (member === null || typeof member !== 'object') return [];
  const { stage, status, detail } = member as {
    stage?: unknown;
    status?: unknown;
    detail?: unknown;
  };
  if (typeof stage !== 'string' || typeof status !== 'string') return [];
  return [{ stage, status, ...(typeof detail === 'string' ? { detail } : {}) }];
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
