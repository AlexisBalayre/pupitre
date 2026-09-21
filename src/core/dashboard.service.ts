import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import { conductorName, conductorSocket } from '../claude/session-runtime.service.js';
import { latestContextTokens } from '../claude/transcript.service.js';
import { isConductorRunning } from './conductor.service.js';
import { eventDetail } from './dashboard-events.utils.js';
import type { SessionState } from './db.client.js';
import { listLedgerEntries, listOverdueLedgerEntries } from './ledger.repository.js';
import { getWatcherBeat, listOverlaps } from './overlap.repository.js';
import { WATCH_STALE_AFTER_MS } from './overlap.service.js';
import { projectId, projectPaths } from './paths.utils.js';
import { asStageArray, asStringArray, parseJsonOr, toIsoUtc } from './report-data.utils.js';
import {
  type EventRow,
  getProject,
  listBacklogTasks,
  listEvents,
  listSessions,
  listTasks,
  type SessionRow,
  type TaskRow,
} from './session.repository.js';
import { classifySessionActivity, isSessionStalled } from './session-activity.utils.js';
import type {
  DashboardBaseline,
  DashboardDeadTurn,
  DashboardEvent,
  DashboardGate,
  DashboardSession,
  DashboardSnapshot,
  DashboardSteer,
  FleetSummary,
} from './types/dashboard.types.js';
import type { ProjectBaseline } from './types/init.types.js';
import type { GateReport } from './types/merge-gate.types.js';
import type { TaskSpec } from './types/profile.types.js';

/**
 * One reading of the project for every surface that shows it: `pup status`
 * prints from this, and `pup ui` draws from it. Built in one place because the
 * two must never disagree about what is running — the terminal list and the
 * dashboard reading the same store through different queries is how a session
 * ends up STALLED on one and fine on the other.
 *
 * `now` is passed in rather than read here so a test can put the clock where it
 * needs it; the stall rule and the radar's staleness are both ages.
 */
export function buildDashboardSnapshot(
  db: Database,
  repoPath: string,
  now: number,
): DashboardSnapshot {
  const pid = projectId(repoPath);
  const paths = projectPaths(repoPath);
  const tasks = new Map(listTasks(db, pid).map((task) => [task.id, task]));
  const stalls = new Map(findStalledSessions(db, repoPath, now).map((stall) => [stall.id, stall]));
  const sessions = listSessions(db).map((row) =>
    dashboardSession(db, row, tasks.get(row.task_id), paths.eventsFile(row.id), stalls.get(row.id)),
  );
  const beat = getWatcherBeat(db, pid);
  const baseline = baselineOf(db, pid);
  return {
    projectId: pid,
    repoPath,
    ...(baseline ? { baseline } : {}),
    conductor: {
      running: isConductorRunning(repoPath),
      name: conductorName(pid),
      attachCommand: `tmux -L ${conductorSocket(pid)} attach -t ${conductorName(pid)}`,
    },
    // `listSessions` returns oldest first and `sort` is stable, so the tie
    // between two sessions that both need a human stays in creation order.
    sessions: sessions.sort((a, b) => Number(sortsFirst(b)) - Number(sortsFirst(a))),
    backlog: listBacklogTasks(db, pid).map((task) => {
      const spec = parseJsonOr<Partial<TaskSpec>>(task.spec, {});
      return {
        // The store is not always the caller's own since the fleet views
        // (decisions 60, 61), and `pup ui` draws the backlog, the ledger and
        // the radar, which the fleet `pup status` does not: every id is
        // scrubbed like the session row's.
        id: sanitizeReason(task.id),
        goal: goalHeadline(spec.goal),
        scope: asStringArray(spec.scopeIn).map(sanitizeReason),
        acceptance: asStringArray(spec.acceptance).map(sanitizeReason),
        origin: sanitizeReason(task.origin),
      };
    }),
    overdueDebt: listOverdueLedgerEntries(db, pid, new Date(now)).map((entry) => ({
      // Integer by the schema pup lays down, but a planted store can have
      // created `ledger_entries` with a TEXT id first, so affinity is no pin.
      id: sanitizeReason(String(entry.id)),
      description: sanitizeReason(entry.description),
      reviewBy: sanitizeReason(entry.review_by),
    })),
    openDebtCount: listLedgerEntries(db, pid).length,
    overlaps: listOverlaps(db).map((pair) => ({
      sessionA: sanitizeReason(pair.sessionA),
      sessionB: sanitizeReason(pair.sessionB),
      files: pair.files.map(sanitizeReason),
    })),
    radarStale: !beat || now - beat.getTime() > WATCH_STALE_AFTER_MS,
  };
}

/**
 * A project folded to what the operator has to act on (decision 60). Awaiting
 * review is here though nothing is wrong with it, because nothing moves until
 * a person merges it; awaiting-input is not, because a permission ask answers
 * itself or turns into a stall within minutes, and the fleet is read across
 * projects rather than watched.
 */
export function fleetSummary(snapshot: DashboardSnapshot): FleetSummary {
  const count = (state: DashboardSession['state']): number =>
    snapshot.sessions.filter((session) => session.state === state).length;
  return {
    needsYou: snapshot.sessions.filter(
      (session) => sortsFirst(session) || session.state === 'awaiting-review',
    ),
    running: count('running'),
    planned: snapshot.backlog.length,
    merged: count('merged'),
  };
}

/**
 * How many stored events a session row carries: enough for the detail pane to
 * say what happened to the session last, and the part of its history an
 * operator deciding what to do next reads. `pup report` is where the rest is.
 */
const RECENT_EVENT_COUNT = 5;

/**
 * One stall: how long the session has been quiet, and the name of the stall
 * itself. `stalledAt` is the events file's mtime — the clock decision 35 ages a
 * stall by, which stands still for exactly as long as the session does, so it
 * names *this* quiet spell and no other. The turn watchdog stamps its
 * `turn_died` events with it; both readers match against it.
 */
interface StalledSession {
  id: string;
  ageMs: number;
  stalledAt: string;
}

/**
 * Running sessions whose events file has gone quiet past `STALLED_AFTER_MS`
 * (decision 35). Lives beside the snapshot that reports it because `pup watch`
 * asks the same question on its own sweep, where there is no snapshot to build.
 */
export function findStalledSessions(db: Database, repoPath: string, now: number): StalledSession[] {
  const paths = projectPaths(repoPath);
  const stalled: StalledSession[] = [];
  for (const row of listSessions(db, ['running'])) {
    const eventsFile = paths.eventsFile(row.id);
    if (!existsSync(eventsFile)) continue;
    const mtimeMs = statSync(eventsFile).mtimeMs;
    const ageMs = now - mtimeMs;
    if (isSessionStalled(ageMs))
      stalled.push({ id: row.id, ageMs, stalledAt: new Date(mtimeMs).toISOString() });
  }
  return stalled;
}

/**
 * One terminal-safe line of a task's goal. Goals are multi-line prose an agent
 * or the operator wrote, so only the first line is a headline, and only after
 * decision 29's sanitizing. Fitting it to a column is the reader's job: the
 * width belongs to the surface, not to the reading.
 */
export function goalHeadline(goal: string | undefined): string {
  return sanitizeReason((goal ?? '').split('\n')[0] ?? '');
}

/**
 * What sorts to the top of the list: a session that has stopped for good.
 * Deliberately narrower than `needsHuman`, which also counts awaiting-input —
 * hoisting a five-second permission ask above a blocked session would bury the
 * row the operator actually has to act on.
 */
function sortsFirst(session: DashboardSession): boolean {
  return session.state === 'blocked' || session.stalledAgeMs !== undefined;
}

function dashboardSession(
  db: Database,
  row: SessionRow,
  task: TaskRow | undefined,
  eventsFile: string,
  stall: StalledSession | undefined,
): DashboardSession {
  const spec = task ? parseJsonOr<Partial<TaskSpec>>(task.spec, {}) : {};
  // Decision 2: hook events, never pane contents. Nothing to classify for a
  // session that is not running, or has yet to fire a hook.
  const activity =
    row.state === 'running' && existsSync(eventsFile)
      ? classifySessionActivity(readFileSync(eventsFile, 'utf8'))
      : undefined;
  const stalledAgeMs = stall?.ageMs;
  // Only a running session has a context window to fill; a merged one's last
  // transcript is history, and reading it is I/O per row for nothing.
  const contextTokens =
    row.state === 'running' && row.transcript_path
      ? latestContextTokens(row.transcript_path)
      : undefined;
  // Newest first, so `find` returns the latest matching event.
  const events = listEvents(db, row.id).reverse();
  const lastSteer = newestSteer(events);
  const lastGate = newestGate(events);
  // Only for the stall the session is in now: an hour-old resume belongs to a
  // stall the session has worked its way out of since.
  const deadTurn = stall && newestDeadTurn(events, stall.stalledAt);
  return {
    // The store is session-writable and, since the fleet view (decision 60),
    // not always the caller's own: all three print as stored, and no CHECK
    // constraint holds `state` to its type, so it is scrubbed like the others.
    id: sanitizeReason(row.id),
    state: sanitizeReason(row.state) as SessionState,
    branch: sanitizeReason(row.branch),
    taskId: row.task_id,
    goal: goalHeadline(spec.goal),
    // The task row is the only record of who asked for the work. It outlives
    // the session, so the join misses only on a store someone has edited by
    // hand — which is a row to render, not a reason to drop the session.
    origin: sanitizeReason(task?.origin ?? 'unknown'),
    scope: asStringArray(spec.scopeIn).map(sanitizeReason),
    acceptance: asStringArray(spec.acceptance).map(sanitizeReason),
    rejectCount: row.reject_count,
    ...(activity ? { activity } : {}),
    ...(stalledAgeMs === undefined ? {} : { stalledAgeMs }),
    ...(deadTurn ? { deadTurn } : {}),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(lastSteer ? { lastSteer } : {}),
    ...(lastGate ? { lastGate } : {}),
    recentEvents: events.slice(0, RECENT_EVENT_COUNT).reverse().map(dashboardEvent),
    needsHuman:
      row.state === 'blocked' || stalledAgeMs !== undefined || activity?.kind === 'awaiting-input',
  };
}

/**
 * The newest dead turn the watchdog recorded against this stall, or nothing —
 * no record, or a record from a stall the session has since worked out of
 * (addendum to decision 35). Read here, off events the store already holds,
 * rather than from the watchdog: the pane the watcher captured is evidence it
 * did not keep, so this is the store telling both surfaces what recovery did,
 * not a second reading of the session. Newest wins, because one stall can be
 * resumed more than once through an outage.
 */
function newestDeadTurn(newestFirst: EventRow[], stalledAt: string): DashboardDeadTurn | undefined {
  for (const event of newestFirst) {
    if (event.type !== 'turn_died') continue;
    const payload = parseJsonOr<{ reason?: unknown; stalledAt?: unknown; refusal?: unknown }>(
      event.payload,
      {},
    );
    if (payload.stalledAt !== stalledAt) continue;
    return {
      // Sanitized again on the way out, like every other stored text on a row:
      // the error line is the session's own pane (decision 29), and a torn
      // payload must render as a row rather than end the snapshot.
      reason: typeof payload.reason === 'string' ? sanitizeReason(payload.reason) : '',
      at: toIsoUtc(event.created_at),
      ...(typeof payload.refusal === 'string' ? { refusal: sanitizeReason(payload.refusal) } : {}),
    };
  }
  return undefined;
}

function newestSteer(newestFirst: EventRow[]): DashboardSteer | undefined {
  const steer = newestFirst.find((event) => event.type === 'steer');
  if (!steer) return undefined;
  const payload = parseJsonOr<{ kind?: unknown; by?: unknown }>(steer.payload, {});
  return {
    ...(typeof payload.kind === 'string' ? { kind: sanitizeReason(payload.kind) } : {}),
    ...(typeof payload.by === 'string' ? { by: sanitizeReason(payload.by) } : {}),
    at: toIsoUtc(steer.created_at),
  };
}

/**
 * Every state transition logs a `gate_result`; only a real gate run carries a
 * report payload, and the ones without it say nothing about passing (same
 * filter as review.service's `lastGateReport`).
 */
function newestGate(newestFirst: EventRow[]): DashboardGate | undefined {
  for (const event of newestFirst) {
    const gate = event.type === 'gate_result' ? gateOf(event) : undefined;
    if (gate) return gate;
  }
  return undefined;
}

/**
 * The gate run a `gate_result` event reports, or nothing for a bare transition.
 * The stages go through `asStageArray`'s shape guard first — one `null` member
 * a session wrote must drop out of the list, not end the snapshot — and then
 * through decision 29's terminal sanitizing, because a stage detail is a failing
 * test's own output.
 */
function gateOf(event: EventRow): DashboardGate | undefined {
  const report = parseJsonOr<{ report?: GateReport }>(event.payload, {}).report;
  if (!report) return undefined;
  const stages = asStageArray(report.stages).map(({ stage, status, detail }) => ({
    stage: sanitizeReason(stage),
    status: sanitizeReason(status),
    ...(detail === null ? {} : { detail: sanitizeReason(detail) }),
  }));
  const failed = stages.find((stage) => stage.status === 'fail');
  return {
    passed: report.passed === true,
    ...(failed ? { failedStage: failed.stage } : {}),
    stages,
    at: toIsoUtc(event.created_at),
  };
}

function dashboardEvent(event: EventRow): DashboardEvent {
  const detail = eventDetail(event, event.type === 'gate_result' ? gateOf(event) : undefined);
  return {
    type: sanitizeReason(event.type),
    at: toIsoUtc(event.created_at),
    ...(detail ? { detail } : {}),
  };
}

/**
 * The stored baseline, or nothing. A baseline with no capture time is not a
 * baseline a reader can date, so it degrades to absent rather than to a row
 * claiming figures from no particular moment.
 */
function baselineOf(db: Database, pid: string): DashboardBaseline | undefined {
  const stored = getProject(db, pid)?.baseline;
  if (!stored) return undefined;
  const baseline = parseJsonOr<Partial<ProjectBaseline>>(stored, {});
  if (typeof baseline.capturedAt !== 'string') return undefined;
  const debt = baseline.debt ?? {};
  return {
    capturedAt: toIsoUtc(baseline.capturedAt),
    ...(typeof debt.coverageRatio === 'number' ? { coverageRatio: debt.coverageRatio } : {}),
    ...(typeof debt.duplicatedLines === 'number' ? { duplicatedLines: debt.duplicatedLines } : {}),
    ...(Array.isArray(debt.deadExports) ? { deadExports: debt.deadExports.length } : {}),
  };
}

/**
 * Why the gate parked this session, read back out of the store: the `reason` on
 * the newest `gate_result` that moved it to `blocked` — the reject cap of
 * decision 7, or the re-steer refusal decision 45's addendum records. Newest
 * wins and an older block is never consulted, so a session parked twice is
 * described by the parking that is current. Undefined when the transition
 * carried no reason, which is every block older than those two reasons.
 *
 * Not on the snapshot, and deliberately: it is read when an operator asks to
 * lift a block, not on every two-second redraw of every row. Both surfaces that
 * ask — `pup unblock` and the dashboard's `u` — ask through this, so neither
 * can describe a parking the other would describe differently.
 */
export function blockedReason(db: Database, sessionId: string): string | undefined {
  for (const event of listEvents(db, sessionId).reverse()) {
    if (event.type !== 'gate_result') continue;
    const payload = parseJsonOr<{ to?: unknown; reason?: unknown }>(event.payload, {});
    if (payload.to !== 'blocked') continue;
    // Sanitized like every other stored text a reader prints: the reason quotes
    // a steer refusal, and the report that refused to land is the session's own
    // output (decision 29).
    return typeof payload.reason === 'string' ? sanitizeReason(payload.reason) : undefined;
  }
  return undefined;
}
