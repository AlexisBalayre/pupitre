import { availableParallelism, loadavg } from 'node:os';
import type { Database } from 'better-sqlite3';
import { lockBacklogBudgetMinutes } from './project-config.config.js';
import { parseJsonOr } from './report-data.utils.js';
import {
  decodeEvent,
  listEvents,
  listSessions,
  newestEventOf,
  type SessionRow,
} from './session.repository.js';
import { holdingStates } from './session-state.utils.js';
import { percentile } from './usage-report.service.js';

/**
 * How long a merge-lock use is taken to last while the store has timed no gate
 * run: pupitre's own gates and lands held the lock 6 to 7 minutes in the week to
 * 2026-11-16, rounded up so the default budget refuses a fifth fresh session,
 * as the old fixed cap's default did (decision 197).
 */
export const UNTIMED_GATE_MS = 8 * 60_000;

/** How many of the newest timed gate runs the median is taken over, so it follows the suite. */
const GATE_SAMPLE = 30;

/** The merge-lock uses a session not yet through its gate still needs: its gate, then its land. */
const USES_BEFORE_GATE = 2;

/** The machine's 1-minute load average and the cores it is held to. */
export interface MachineLoad {
  average: number;
  cores: number;
}

/** The merge-lock work the project's sessions have ahead of them (decision 197). */
export interface LockBacklog {
  minutes: number;
  budgetMinutes: number;
  /** Gates and lands the live and unlanded sessions still need. */
  uses: number;
  /** The median gate run's time, `UNTIMED_GATE_MS` while `gatesTimed` is 0. */
  gateMs: number;
  gatesTimed: number;
}

/** Both signals a launch is held to, as `pup status` prints them and `pup launch` reads them. */
export interface LaunchRoom {
  backlog: LockBacklog;
  load: MachineLoad;
}

/** A launch refused because the merge lock already has more work queued than the project's budget. */
export class LockBacklogOverBudgetError extends Error {
  constructor(backlog: LockBacklog) {
    super(
      `The merge lock's backlog is ${minutes(backlog.minutes)} minutes, over the project's ` +
        `budget of ${minutes(backlog.budgetMinutes)} (${backlogTerms(backlog)}); nothing was ` +
        'launched. lockBacklogBudgetMinutes in .pupitre/project.yml sets the budget; only the ' +
        "operator's --over-cap goes beyond.",
    );
    this.name = 'LockBacklogOverBudgetError';
  }
}

/** A launch refused because the machine's load average is above its cores. */
export class MachineLoadedError extends Error {
  constructor(load: MachineLoad) {
    super(
      `The machine's 1-minute load average is ${load.average.toFixed(1)}, above its ` +
        `${load.cores} cores; nothing was launched. Wait for the load to fall; only the ` +
        "operator's --over-cap goes beyond.",
    );
    this.name = 'MachineLoadedError';
  }
}

/** The 1-minute load average, 0 on a platform with none, against the cores the gate's own wait uses. */
export function machineLoad(): MachineLoad {
  return { average: loadavg()[0] ?? 0, cores: availableParallelism() };
}

/**
 * The project's merge-lock backlog: every session's remaining lock uses times
 * the median gate run (decision 197). A live session, whether it awaits its
 * first gate or is back in a round after a rejection or a CI failure, still
 * needs a gate and a land; a merged one whose PR is open and not landed, its
 * land; any other, none.
 */
export function lockBacklog(db: Database, repoPath: string): LockBacklog {
  const uses = listSessions(db).reduce((sum, session) => sum + lockUsesLeft(db, session), 0);
  const timed = gateRunTimes(db);
  const gateMs = timed.length > 0 ? percentile(timed, 0.5) : UNTIMED_GATE_MS;
  return {
    minutes: (uses * gateMs) / 60_000,
    budgetMinutes: lockBacklogBudgetMinutes(repoPath),
    uses,
    gateMs,
    gatesTimed: timed.length,
  };
}

function lockUsesLeft(db: Database, session: SessionRow): number {
  if (holdingStates().includes(session.state)) return USES_BEFORE_GATE;
  if (session.state !== 'merged') return 0;
  const newest = newestEventOf(db, session.id, ['merge', 'landed', 'retired', 'pr_closed']);
  if (newest?.type !== 'merge') return 0;
  const merge = decodeEvent(newest);
  // A merge with no PR moved the target itself, under the gate's own lock use.
  return merge.type === 'merge' && merge.prUrl !== undefined ? 1 : 0;
}

/**
 * The newest `GATE_SAMPLE` gate runs' times, newest first, each its longest
 * stage: the stages run alongside one another, so the longest is the closest
 * the report comes to the run's own time. A payload is session-writable, so a
 * time that is not a finite, non-negative number is passed over.
 */
function gateRunTimes(db: Database): number[] {
  const runs = listSessions(db)
    .flatMap((session) => listEvents(db, session.id))
    .filter((event) => event.type === 'gate_result')
    .sort((a, b) => b.id - a.id);
  const times: number[] = [];
  for (const run of runs) {
    const time = longestStage(parseJsonOr<unknown>(run.payload, undefined));
    if (time !== undefined) times.push(time);
    if (times.length === GATE_SAMPLE) break;
  }
  return times;
}

function longestStage(payload: unknown): number | undefined {
  const stages = (payload as { report?: { stages?: unknown } } | null)?.report?.stages;
  if (!Array.isArray(stages)) return undefined;
  const times = stages
    .map((stage) => (stage as { durationMs?: unknown } | null)?.durationMs)
    .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0);
  return times.length > 0 ? Math.max(...times) : undefined;
}

/** Both signals: the backlog read now, beside the machine's `load`, `machineLoad()` in use. */
export function launchRoom(db: Database, repoPath: string, load: MachineLoad): LaunchRoom {
  return { backlog: lockBacklog(db, repoPath), load };
}

/** Refuse a launch while either signal is past its limit, the backlog named first. */
export function assertLaunchRoom(room: LaunchRoom): void {
  if (room.backlog.minutes > room.backlog.budgetMinutes) {
    throw new LockBacklogOverBudgetError(room.backlog);
  }
  if (room.load.average > room.load.cores) throw new MachineLoadedError(room.load);
}

/** `pup status`'s lines for both signals and whether a launch would go ahead. */
export function launchRoomLines(room: LaunchRoom): string[] {
  const { backlog, load } = room;
  const over = [
    backlog.minutes > backlog.budgetMinutes ? 'merge-lock backlog over budget' : undefined,
    load.average > load.cores ? 'load above the cores' : undefined,
  ].filter(Boolean);
  const verdict =
    over.length > 0
      ? `refused (${over.join(', ')}); only the operator's --over-cap goes beyond`
      : 'allowed';
  return [
    `Launch: ${verdict}`,
    `  merge-lock backlog: ${minutes(backlog.minutes)} of ${minutes(backlog.budgetMinutes)} minutes (${backlogTerms(backlog)})`,
    `  load: ${load.average.toFixed(1)} of ${load.cores} cores`,
  ];
}

/** The backlog's sum, kept short: a refusal is printed clipped at 300 characters. */
function backlogTerms(backlog: LockBacklog): string {
  const gate = minutes(backlog.gateMs / 60_000);
  const measure =
    backlog.gatesTimed === 0
      ? 'minutes each, no gate timed yet'
      : backlog.gatesTimed === 1
        ? 'minutes, the only gate timed'
        : `minutes, the median of the last ${backlog.gatesTimed} gates`;
  return `${backlog.uses} gates and lands to go at ${gate} ${measure}`;
}

function minutes(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
