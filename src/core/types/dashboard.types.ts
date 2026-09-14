import type { SessionState } from '../db.client.js';
import type { OverlapPair } from './overlap.types.js';
import type { SessionActivity } from './session-activity.types.js';

/**
 * Every string in a snapshot has already been through `sanitizeReason`: the
 * store is session-writable, and both readers print to a terminal, where an
 * ANSI escape in a goal or a debt description repaints the one screen the
 * operator decides from (decision 29). Sanitizing at the source is what keeps
 * a second reader from having to remember.
 */

/** The debt figures `pup init` last measured, as the dashboard shows them. */
export interface DashboardBaseline {
  capturedAt: string;
  /** Repo-wide covered/instrumented line ratio in [0, 1]; absent when unmeasured. */
  coverageRatio?: number;
  duplicatedLines?: number;
  /** How many dead exports the baseline found; absent when unmeasured. */
  deadExports?: number;
}

interface DashboardConductor {
  running: boolean;
  /** The conductor window's tmux name, up or not. */
  name: string;
  /**
   * What the operator types to attach. Carries the `-L` socket: the window is
   * on the conductor's own tmux server, so a bare `attach -t` finds nothing
   * (decision 47). Who may be shown it is the reader's call, not the model's.
   */
  attachCommand: string;
}

/** The newest steer a session received, whoever sent it. */
export interface DashboardSteer {
  /** `kickoff`, `manual`, `message`, `gate-rejection`, … as the event recorded it. */
  kind?: string;
  /** `operator`, `conductor` or `session:<id>` — only message steers name a sender. */
  by?: string;
  at: string;
}

/** The newest gate run that left a report behind. */
export interface DashboardGate {
  passed: boolean;
  /** The first stage that failed; absent on a pass. */
  failedStage?: string;
  at: string;
}

/**
 * What the turn watchdog recorded against the stall a session is in right now
 * (addendum to decision 35). Store-derived like every other field here — the
 * persisted `turn_died` event matched against the stall stamp — so a second
 * surface showing the line is not a second reader of the pane.
 */
export interface DashboardDeadTurn {
  /** The pane's own error line, as the watcher sanitized it. */
  reason: string;
  /** When the watcher recorded the death, ISO. */
  at: string;
  /** Why nothing was typed, when the resume steer was refused; then it needs a human. */
  refusal?: string;
}

export interface DashboardSession {
  id: string;
  state: SessionState;
  branch: string;
  taskId: string;
  /** First line of the task's goal, fitted by the reader, not here. */
  goal: string;
  /** Who asked for the work: the task's origin. */
  origin: string;
  rejectCount: number;
  /**
   * What the hook events say the session is doing (decision 2). Present only
   * for a running session that has an events file — there is nothing to
   * classify otherwise, and a finished session's last event is not activity.
   */
  activity?: SessionActivity;
  /** How long the events file has been quiet, once past the stall bar (decision 35). */
  stalledAgeMs?: number;
  /**
   * The dead turn the watchdog recorded for the stall this session is in, when
   * that is why it went quiet. Only ever set alongside `stalledAgeMs`.
   */
  deadTurn?: DashboardDeadTurn;
  /** Tokens the last turn carried, for running sessions with a transcript. */
  contextTokens?: number;
  lastSteer?: DashboardSteer;
  lastGate?: DashboardGate;
  /**
   * Nothing moves here until a person acts: blocked, stalled, or waiting on an
   * answer. Wider than what sorts first — an awaiting-input session is a
   * five-second permission ask as often as a wedge, so it is flagged without
   * being hoisted above the sessions that have stopped for good.
   */
  needsHuman: boolean;
}

interface DashboardBacklogTask {
  id: string;
  /** First line of the goal, as on a session row. */
  goal: string;
  /** The task's scope-in globs. */
  scope: string[];
  origin: string;
}

/** One open ledger entry whose review-by date has passed (docs/04). */
interface DashboardDebt {
  id: number;
  description: string;
  reviewBy: string;
}

/**
 * One reading of a project, taken from one store at one instant: what `pup
 * status` prints and what `pup ui` will draw, so the two cannot disagree about
 * what is running. Everything here is answered by the store and the events
 * files — nothing spawns git or tmux beyond the conductor's window check.
 */
export interface DashboardSnapshot {
  projectId: string;
  repoPath: string;
  /** Absent until `pup init` has captured one. */
  baseline?: DashboardBaseline;
  conductor: DashboardConductor;
  /** Blocked and stalled sessions first, then oldest first. */
  sessions: DashboardSession[];
  /** Unclaimed tasks, oldest first — the queue order `pup plan` lists them in. */
  backlog: DashboardBacklogTask[];
  overdueDebt: DashboardDebt[];
  openDebtCount: number;
  /** Live sessions whose diffs touch the same file, as the radar last left them. */
  overlaps: OverlapPair[];
  /** The radar's heartbeat has gone quiet: the overlaps above may be stale. */
  radarStale: boolean;
}
