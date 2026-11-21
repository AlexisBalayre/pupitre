import type { ChartDatum } from './chart.types.js';

/** A live session sharing tracked files with a backlog task, under the gate's own scope rule. */
export interface TaskOverlap {
  session: string;
  files: string[];
}

/** One backlog task, every string through `sanitizeReason` and `displayText`. */
export interface BacklogTask {
  id: string;
  /** The goal's first sentence. */
  goal: string;
  scope: string[];
  scopeOut: string[];
  overlaps: TaskOverlap[];
}

/** One session that reached a PR, its counts read off its events. */
export interface PrSession {
  session: string;
  prUrl: string;
  /** Gate runs that left a report: the first gate, each rejection, each re-gate. */
  gates: number;
  failed: number;
  /** Every steer but the kickoff, which launched it. */
  steers: number;
  respawns: number;
  /** Gate runs after its first `merge` event, on the PR's new head (decision 86). */
  regates: number;
  mergedAt: number;
  /** From launch to its first `merge` event, in ms; NaN when a time does not parse. */
  toMerge: number;
  /** From launch to its first `landed` event, in ms; undefined until `pup land`. */
  toLanded: number | undefined;
}

export interface TasksView {
  backlog: BacklogTask[];
  /** Why the overlaps could not be read, when they could not. */
  overlapError?: string;
  sessions: PrSession[];
  /** Each week's share of gate runs that passed, NaN in a week with none. */
  passRate: ChartDatum[];
  runs: { total: number; passed: number };
  /** Gate runs that failed, by each stage that failed or flagged them. */
  failures: ChartDatum[];
}

/** What a session's events add up to, as the read meets them in order. */
export interface Tally {
  launchedAt: string;
  gates: number;
  failed: number;
  steers: number;
  respawns: number;
  regates: number;
  mergedAt?: string;
  prUrl?: string;
  landedAt?: string;
}
