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
   * What the operator types to attach, as `attachCommand` spells it: the `-L`
   * socket, because the window is on the conductor's own tmux server and a
   * bare `attach -t` finds nothing (decision 47), and a pinned target quoted
   * for the shell it is pasted into. Who may be shown it is the reader's
   * call, not the model's.
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

/** One stage of a gate run, as the report recorded it. */
interface DashboardGateStage {
  stage: string;
  /** `pass`, `fail`, `skip`, … as the gate wrote it. */
  status: string;
  detail?: string;
}

/** The newest gate run that left a report behind. */
export interface DashboardGate {
  passed: boolean;
  /** The first stage that failed; absent on a pass. */
  failedStage?: string;
  /** Every stage the report carried, in the order the gate ran them. */
  stages: DashboardGateStage[];
  at: string;
}

/** One stored event on a session, as the detail pane lists it. */
export interface DashboardEvent {
  /** The event type: `steer`, `gate_result`, `turn_died`, … */
  type: string;
  at: string;
  /** The payload in one line — a transition, a steer's kind, a summary — when it says anything. */
  detail?: string;
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

/**
 * What a session's window runs on and how it got there (decision 92), as its
 * row records it, each string scrubbed like the rest of the row.
 */
export interface DashboardRoute {
  /** `standard` or `critical`. */
  tier: string;
  model: string;
  effort: string;
  /** The rung counted from 1, out of `rungs`, the length of the tier's ladder. */
  rung: number;
  rungs: number;
  /** Why the rung last climbed: `gate-rejection`, `ci-fix-round`, `turn-death` or `stall`. */
  reason?: string;
  /** An explicit `--model`/`--effort` chose the model or effort over the rung's. */
  override: boolean;
  /**
   * What the window ran into on the top rung, for a killed session that is the
   * newest of a task back in the backlog: nothing is left to climb, so the
   * task's relaunch is refused and waits on the operator.
   */
  topReached?: string;
}

export interface DashboardSession {
  id: string;
  /**
   * Whether the stored id has the minted shape (`SESSION_ID_PATTERN`), judged
   * on the raw row before the scrub: a row a session wrote in another shape
   * gets no command built around it and prints as a placeholder, since the
   * inbox's answer is acted on (decision 83).
   */
  isMintedId: boolean;
  state: SessionState;
  branch: string;
  taskId: string;
  /** First line of the task's goal, fitted by the reader, not here. */
  goal: string;
  /** Who asked for the work: the task's origin. */
  origin: string;
  /** The task's scope-in globs. */
  scope: string[];
  /** The task's acceptance criteria, one per entry. */
  acceptance: string[];
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
  /**
   * The question the session asked with `pup session ask` that no steer has
   * answered yet, scrubbed and cut (decision 76).
   */
  question?: string;
  /**
   * The PR the gate opened for a merged session, while the target branch of
   * this checkout does not yet hold the commit it pinned and no `landed` event
   * has come after it (decision 83). Absent on a local fast-forward, which
   * carries no PR and has already landed. The url is there only in the
   * pull-request shape: it is printed as the thing to act on.
   */
  openPr?: { url?: string };
  lastGate?: DashboardGate;
  /**
   * The gate refused this awaiting-review session on flagged debt, and no
   * steer or new finish came after: accepting the debt takes a human, never
   * the conductor (decision 102).
   */
  gateRefused?: boolean;
  /** Absent on a session launched before routing, or a row whose route does not read back. */
  route?: DashboardRoute;
  /** The newest few stored events, oldest of them first — the order they happened in. */
  recentEvents: DashboardEvent[];
  /**
   * Nothing moves here until a person acts: blocked, stalled, or waiting on an
   * answer. Wider than what sorts first — an awaiting-input session is a
   * five-second permission ask as often as a wedge, so it is flagged without
   * being hoisted above the sessions that have stopped for good.
   */
  needsHuman: boolean;
}

/**
 * One line of the needs-you inbox (decision 83): the session, why it waits on
 * the operator, and the one command — or the PR url — that answers it.
 */
export interface DashboardNeed {
  /** The inbox's own order: question, blocked, top-rung, stalled, awaiting-review, pr-open. */
  kind: 'question' | 'blocked' | 'top-rung' | 'stalled' | 'awaiting-review' | 'pr-open';
  sessionId: string;
  /** What prints for the session: its id, or a placeholder for one outside the minted shape. */
  label: string;
  reason: string;
  answer: string;
}

interface DashboardBacklogTask {
  id: string;
  /** First line of the goal, as on a session row. */
  goal: string;
  /** The task's scope-in globs. */
  scope: string[];
  /** The task's acceptance criteria, one per entry. */
  acceptance: string[];
  origin: string;
}

/** One open ledger entry whose review-by date has passed (docs/04). */
interface DashboardDebt {
  /** The ledger id as text, sanitized like every field a foreign store holds (decision 61). */
  id: string;
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

/**
 * One project as the fleet view prints it (decision 60): the rows that wait on
 * the operator, and the rest as counts. Read off a `DashboardSnapshot`, never
 * off the store, so the fleet and the single-project table cannot disagree.
 */
export interface FleetSummary {
  /** The snapshot's needs-you inbox, in its order (decision 83). */
  needsYou: DashboardNeed[];
  running: number;
  planned: number;
  merged: number;
}
