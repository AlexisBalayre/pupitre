import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import { conductorName, conductorSocket } from '../claude/session-runtime.service.js';
import { latestContextTokens } from '../claude/transcript.service.js';
import { isConductorRunning } from './conductor.service.js';
import { listLedgerEntries, listOverdueLedgerEntries } from './ledger.repository.js';
import { getWatcherBeat, listOverlaps } from './overlap.repository.js';
import { WATCH_STALE_AFTER_MS } from './overlap.service.js';
import { projectId, projectPaths } from './paths.utils.js';
import { asStringArray, parseJsonOr, toIsoUtc } from './report-data.utils.js';
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
  DashboardGate,
  DashboardSession,
  DashboardSnapshot,
  DashboardSteer,
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
  const stalledAges = new Map(
    findStalledSessions(db, repoPath, now).map((session) => [session.id, session.ageMs]),
  );
  const sessions = listSessions(db).map((row) =>
    dashboardSession(db, row, tasks.get(row.task_id), paths.eventsFile(row.id), stalledAges),
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
        id: task.id,
        goal: goalHeadline(spec.goal),
        scope: asStringArray(spec.scopeIn).map(sanitizeReason),
        origin: sanitizeReason(task.origin),
      };
    }),
    overdueDebt: listOverdueLedgerEntries(db, pid, new Date(now)).map((entry) => ({
      id: entry.id,
      description: sanitizeReason(entry.description),
      reviewBy: sanitizeReason(entry.review_by),
    })),
    openDebtCount: listLedgerEntries(db, pid).length,
    overlaps: listOverlaps(db).map((pair) => ({
      sessionA: pair.sessionA,
      sessionB: pair.sessionB,
      files: pair.files.map(sanitizeReason),
    })),
    radarStale: !beat || now - beat.getTime() > WATCH_STALE_AFTER_MS,
  };
}

/**
 * Running sessions whose events file has gone quiet past `STALLED_AFTER_MS`
 * (decision 35). Lives beside the snapshot that reports it because `pup watch`
 * asks the same question on its own sweep, where there is no snapshot to build.
 */
export function findStalledSessions(
  db: Database,
  repoPath: string,
  now: number,
): Array<{ id: string; ageMs: number }> {
  const paths = projectPaths(repoPath);
  const stalled: Array<{ id: string; ageMs: number }> = [];
  for (const row of listSessions(db, ['running'])) {
    const eventsFile = paths.eventsFile(row.id);
    if (!existsSync(eventsFile)) continue;
    const ageMs = now - statSync(eventsFile).mtimeMs;
    if (isSessionStalled(ageMs)) stalled.push({ id: row.id, ageMs });
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
  stalledAges: Map<string, number>,
): DashboardSession {
  const spec = task ? parseJsonOr<Partial<TaskSpec>>(task.spec, {}) : {};
  // Decision 2: hook events, never pane contents. Nothing to classify for a
  // session that is not running, or has yet to fire a hook.
  const activity =
    row.state === 'running' && existsSync(eventsFile)
      ? classifySessionActivity(readFileSync(eventsFile, 'utf8'))
      : undefined;
  const stalledAgeMs = stalledAges.get(row.id);
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
  return {
    id: row.id,
    state: row.state,
    branch: row.branch,
    taskId: row.task_id,
    goal: goalHeadline(spec.goal),
    // The task row is the only record of who asked for the work. It outlives
    // the session, so the join misses only on a store someone has edited by
    // hand — which is a row to render, not a reason to drop the session.
    origin: sanitizeReason(task?.origin ?? 'unknown'),
    rejectCount: row.reject_count,
    ...(activity ? { activity } : {}),
    ...(stalledAgeMs === undefined ? {} : { stalledAgeMs }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(lastSteer ? { lastSteer } : {}),
    ...(lastGate ? { lastGate } : {}),
    needsHuman:
      row.state === 'blocked' || stalledAgeMs !== undefined || activity?.kind === 'awaiting-input',
  };
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
    if (event.type !== 'gate_result') continue;
    const report = parseJsonOr<{ report?: GateReport }>(event.payload, {}).report;
    if (!report) continue;
    const failed = (report.stages ?? []).find((stage) => stage?.status === 'fail');
    return {
      passed: report.passed === true,
      ...(failed ? { failedStage: sanitizeReason(failed.stage) } : {}),
      at: toIsoUtc(event.created_at),
    };
  }
  return undefined;
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
