import type { GATE_METRICS } from '../web-dashboard-sheet.utils.js';
import type { DashboardBaseline } from './dashboard.types.js';

export type Figures = Omit<DashboardBaseline, 'capturedAt'>;

export type MetricKey = keyof Figures;

export type Metric = (typeof GATE_METRICS)[number];

/** One `baseline_history` capture as the Health sheet reads it. */
export interface HealthCapture {
  at: number;
  /** Printed from `at`, so no store text reaches the page through it. */
  label: string;
  figures: Figures;
  /** The rule each figure was counted under: only duplication has one (decision 39). */
  rules: Partial<Record<MetricKey, string | undefined>>;
}

/** A session's first merge, the one that landed its work. */
export interface HealthMerge {
  /** When its work reached the target: the merge, or for a pull request its first `landed` event. */
  at: number;
  label: string;
  /** The session id, or `UNMINTED_LABEL` for one outside the minted shape. */
  session: string;
  /** Through `sanitizeReason` and `displayText`, empty for a local merge; a link only in a PR url's shape. */
  prUrl: string;
}

export interface HealthView {
  captures: HealthCapture[];
  merges: HealthMerge[];
}

/** A capture that measured a metric, and the one it compares with, if any. */
export interface Point {
  capture: HealthCapture;
  value: number;
  previous: Point | undefined;
}

/** One metric's points, keyed by the capture that measured them. */
export interface Series {
  metric: Metric;
  points: Map<HealthCapture, Point>;
}

/** One metric's change at a capture. */
export interface Move {
  metric: Metric;
  before: number;
  after: number;
  /** When the capture it is compared with was taken. */
  since: number;
}

export interface Movement {
  capture: HealthCapture;
  moves: Move[];
  /** The largest relative change among its moves. */
  size: number;
  /** The sessions whose merge is placed after the earliest `since` and at or before the capture. */
  merged: HealthMerge[];
}
