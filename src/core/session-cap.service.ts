import { availableParallelism, loadavg } from 'node:os';
import type { Database } from 'better-sqlite3';
import { lockBacklogBudgetMinutes } from './project-config.config.js';
import { parseJsonOr, toIsoUtc } from './report-data.utils.js';
import {
  decodeEvent,
  listEvents,
  listSessions,
  newestEventOf,
  type SessionRow,
} from './session.repository.js';
import { holdingStates } from './session-state.utils.js';
import { availableMemoryBytes, MIN_AVAILABLE_MEMORY_BYTES } from './test-slot.service.js';
import { assertUsageRoom, UsageLimitReachedError } from './usage-limits.service.js';
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

/**
 * The bounds the median gate run is held to. The reports are session-writable:
 * thirty forged at 0 would turn the backlog off, and one forged huge would hold
 * every launch, so neither end goes past what a real suite takes.
 */
export const GATE_FLOOR_MS = UNTIMED_GATE_MS / 2;
export const GATE_CEILING_MS = 60 * 60_000;

/** The most stages read from one report, which a session can write as long as it likes. */
const STAGES_READ = 64;

/**
 * How long a PR merged by the gate counts as awaiting its land: one merged in
 * GitHub's UI, or one `pup land` never recorded, would otherwise count forever.
 */
export const LAND_WINDOW_MS = 2 * 24 * 60 * 60_000;

/** The most unlanded sessions `pup status` names, the rest counted. */
const UNLANDED_SHOWN = 8;

/**
 * A session id `pup status` prints as is. The store is session-writable, so an
 * id outside it, which could carry a terminal escape, is counted, not printed.
 */
const PRINTABLE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The merge-lock uses a session not yet through its gate still needs: its gate, then its land. */
const USES_BEFORE_GATE = 2;

/** The machine's 1-minute load average and the cores it is held to. */
interface MachineLoad {
  average: number;
  cores: number;
}

/** The merge-lock work the project's sessions have ahead of them (decision 197). */
export interface LockBacklog {
  minutes: number;
  budgetMinutes: number;
  /** Gates and lands the working and unlanded sessions still need. */
  uses: number;
  /** The median gate run's time within its bounds, `UNTIMED_GATE_MS` while `gatesTimed` is 0. */
  gateMs: number;
  gatesTimed: number;
  /** The merged sessions counted for a land, for the operator to land or close a stale one. */
  unlanded: string[];
}

/** Both signals a launch is held to, as `pup status` prints them and `pup launch` reads them. */
interface LaunchRoom {
  backlog: LockBacklog;
  load: MachineLoad;
}

/**
 * What holds a launch beside the two signals, which `--over-cap` does not
 * lift: the memory floor (decision 96) and the plan's usage hold (decision 156).
 */
interface LaunchHolds {
  memoryBytes: number;
  usageHeld: boolean;
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

/**
 * A launch or a fix round refused because the machine's load average is above
 * its cores. A fix round has no `--over-cap`, so its refusal offers none.
 */
export class MachineLoadedError extends Error {
  constructor(load: MachineLoad, refused: 'launch' | 'fix round' = 'launch') {
    super(
      `The machine's 1-minute load average is ${load.average.toFixed(1)}, above its ` +
        `${load.cores} cores; ` +
        (refused === 'launch'
          ? "nothing was launched. Wait for the load to fall; only the operator's --over-cap goes beyond."
          : 'the fix round was not started. Wait for the load to fall, then run it again.'),
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
 * the median gate run (decision 197). A working session, whether it awaits its
 * first round or is back in one after a rejection or a CI failure, still needs
 * a gate and a land; one awaiting review, none, as decision 144 counts it; a
 * merged one whose PR the gate opened in the last `LAND_WINDOW_MS`, with no
 * land, retirement or close recorded since, its land; any other, none.
 */
export function lockBacklog(db: Database, repoPath: string, now = Date.now()): LockBacklog {
  let uses = 0;
  const unlanded: string[] = [];
  for (const session of listSessions(db)) {
    if (session.state === 'awaiting-review') continue;
    if (holdingStates().includes(session.state)) uses += USES_BEFORE_GATE;
    else if (awaitsLand(db, session, now)) {
      uses += 1;
      unlanded.push(session.id);
    }
  }
  const timed = gateRunTimes(db);
  const median = Math.min(Math.max(percentile(timed, 0.5), GATE_FLOOR_MS), GATE_CEILING_MS);
  const gateMs = timed.length > 0 && Number.isFinite(median) ? median : UNTIMED_GATE_MS;
  return {
    minutes: (uses * gateMs) / 60_000,
    budgetMinutes: lockBacklogBudgetMinutes(repoPath),
    uses,
    gateMs,
    gatesTimed: timed.length,
    unlanded,
  };
}

function awaitsLand(db: Database, session: SessionRow, now: number): boolean {
  if (session.state !== 'merged') return false;
  const newest = newestEventOf(db, session.id, ['merge', 'landed', 'retired', 'pr_closed']);
  if (newest?.type !== 'merge') return false;
  // A time that does not parse is counted: dropping it would hide the session.
  const at = mergedAt(newest.created_at);
  if (Number.isFinite(at) && now - at >= LAND_WINDOW_MS) return false;
  const merge = decodeEvent(newest);
  // A merge with no PR moved the target itself, under the gate's own lock use.
  return merge.type === 'merge' && merge.prUrl !== undefined;
}

/** A merge's time, NaN when the store holds one that is not text or not a time. */
function mergedAt(createdAt: string): number {
  try {
    return Date.parse(toIsoUtc(createdAt));
  } catch {
    return Number.NaN;
  }
}

/**
 * The newest `GATE_SAMPLE` gate runs' times, newest first, each its longest
 * stage: the stages run alongside one another, so the longest is the closest
 * the report comes to the run's own time. Only a report shaped like the gate's
 * own verdict is read, a move out of review to merged or rejected; a payload
 * is session-writable, so a time that is not a finite, non-negative number is
 * passed over, and the median is held to its bounds.
 */
function gateRunTimes(db: Database): number[] {
  const runs = listSessions(db)
    .flatMap((session) => listEvents(db, session.id))
    .filter((event) => event.type === 'gate_result')
    .sort((a, b) => b.id - a.id);
  const times: number[] = [];
  for (const run of runs) {
    const payload = parseJsonOr<unknown>(run.payload, undefined);
    if (!isGateVerdict(payload)) continue;
    const time = longestStage(payload);
    if (time !== undefined) times.push(time);
    if (times.length === GATE_SAMPLE) break;
  }
  return times;
}

/** A transition the gate writes when it rules on a session in review. */
function isGateVerdict(payload: unknown): boolean {
  const { from, to } = (payload ?? {}) as { from?: unknown; to?: unknown };
  return from === 'awaiting-review' && (to === 'merged' || to === 'rejected');
}

function longestStage(payload: unknown): number | undefined {
  const stages = (payload as { report?: { stages?: unknown } } | null)?.report?.stages;
  if (!Array.isArray(stages)) return undefined;
  let longest: number | undefined;
  for (const stage of stages.slice(0, STAGES_READ)) {
    const ms = (stage as { durationMs?: unknown } | null)?.durationMs;
    const timed = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;
    if (timed && (longest === undefined || ms > longest)) longest = ms;
  }
  return longest;
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

/** The memory available now and whether the plan's usage holds launches, as `pup launch` reads them. */
export function launchHolds(repoPath: string, now = Date.now()): LaunchHolds {
  let usageHeld = false;
  try {
    assertUsageRoom(repoPath, now);
  } catch (error) {
    if (!(error instanceof UsageLimitReachedError)) throw error;
    usageHeld = true;
  }
  return { memoryBytes: availableMemoryBytes(), usageHeld };
}

/**
 * `pup status`'s lines for both signals, the memory floor, and whether a launch
 * would go ahead: the verdict names every check `pup launch` makes, so it never
 * reads `allowed` while a launch would be refused.
 */
export function launchRoomLines(room: LaunchRoom, holds: LaunchHolds): string[] {
  const { backlog, load } = room;
  const capOver = backlog.minutes > backlog.budgetMinutes || load.average > load.cores;
  const lowMemory = holds.memoryBytes < MIN_AVAILABLE_MEMORY_BYTES;
  const over = [
    backlog.minutes > backlog.budgetMinutes ? 'merge-lock backlog over budget' : undefined,
    load.average > load.cores ? 'load above the cores' : undefined,
    lowMemory ? `under ${gigabytes(MIN_AVAILABLE_MEMORY_BYTES)} GB of memory available` : undefined,
    holds.usageHeld ? "the plan's usage at its hold line" : undefined,
  ].filter(Boolean);
  const beyond = [
    capOver ? '--over-cap lifts the backlog and the load' : undefined,
    holds.usageHeld ? '--over-limit the usage hold' : undefined,
  ].filter(Boolean);
  const verdict =
    over.length === 0
      ? 'allowed'
      : `refused (${over.join(', ')})` +
        (beyond.length > 0 ? `; only the operator's ${beyond.join(', ')}` : '');
  return [
    `Launch: ${verdict}`,
    `  merge-lock backlog: ${minutes(backlog.minutes)} of ${minutes(backlog.budgetMinutes)} minutes (${backlogTerms(backlog)})`,
    ...unlandedLine(backlog.unlanded),
    `  load: ${load.average.toFixed(1)} of ${load.cores} cores`,
    `  memory: ${gigabytes(holds.memoryBytes)} GB available, ${gigabytes(MIN_AVAILABLE_MEMORY_BYTES)} GB a launch needs`,
  ];
}

function gigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** The merged sessions counted for a land, so the operator can land or close a stale one. */
function unlandedLine(unlanded: string[]): string[] {
  if (unlanded.length === 0) return [];
  const printable = unlanded.filter((id) => PRINTABLE_ID.test(id));
  const unnamed = unlanded.length - printable.length;
  const more = printable.length - UNLANDED_SHOWN;
  const rest = [
    more > 0 ? `${more} more` : undefined,
    unnamed > 0 ? `${unnamed} unnamed` : undefined,
  ].filter(Boolean);
  const named = [printable.slice(0, UNLANDED_SHOWN).join(', '), rest.join(' and ')]
    .filter(Boolean)
    .join(' and ');
  return [
    `    awaiting a land: ${named} (\`pup land\` records each, --abandon-closed a closed PR)`,
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
