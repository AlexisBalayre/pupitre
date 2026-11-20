import type { DashboardSession, DashboardSnapshot } from '../../core/types/dashboard.types.js';
import type { ProjectReading } from './snapshot.types.js';

/** What the screen is waiting for the operator to answer. */
export type ControlPrompt =
  | { kind: 'confirm'; question: string }
  | { kind: 'input'; label: string; value: string };

/** A merge child's output, as the log pane shows it. */
export interface MergeLog {
  sessionId: string;
  /** The tail the pane keeps, oldest first. */
  lines: string[];
  /** Where `lines[0]` sits in everything the child has written, counting from 0. */
  firstLine: number;
  running: boolean;
}

/**
 * The row the detail pane shows: the session or the planned task under the
 * cursor, as the snapshot carries it. The row itself rather than an index, so
 * the pane is drawn from the reading and has nothing to look up.
 */
export type DetailRow =
  | { kind: 'session'; session: DashboardSession }
  | { kind: 'task'; task: DashboardSnapshot['backlog'][number] };

/**
 * A row of the table and the project it was read from. The keys act on the row
 * through that project's store and repo, never through whichever store the
 * dashboard was opened in: with `--all` the rows come from several (decision 61).
 */
export interface LiveRow {
  session: DashboardSession;
  project: ProjectReading;
}

export interface PlannedRow {
  task: DashboardSnapshot['backlog'][number];
  project: ProjectReading;
}

export interface ControlStatus {
  message: string;
  failed: boolean;
}

/**
 * What `useControls` hands the layout. Only the hook names it, like the reading
 * hook's own return type: it is the shape of one function's answer, and a
 * second reader that named it would be building a dashboard's state by hand.
 */
export interface Controls {
  /** The row the keys act on, clamped to the list as it currently stands. */
  cursor: number;
  prompt?: ControlPrompt;
  mergeLog?: MergeLog;
  /** Set while the detail pane is open and the cursor is on a row. */
  detail?: DetailRow;
  status?: ControlStatus;
  /** An action is in flight and the keys are deaf until it lands. */
  busy: boolean;
}

/** A prompt and what to do with the answer; `run` is the action itself. */
export type PendingPrompt =
  | { kind: 'confirm'; question: string; run: () => void }
  | { kind: 'input'; label: string; value: string; run: (value: string) => void };
