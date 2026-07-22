import type { DiffFileStat } from '../git-diff.client.js';
import type { GateReport } from './merge-gate.types.js';
import type { TaskSpec } from './profile.types.js';

export interface ReviewQueueEntry {
  sessionId: string;
  branch: string;
  goal: string;
  changedLines: number;
  filesChanged: number;
  rejectCount: number;
  /** scope_violation events logged by the session's hooks. */
  scopeViolations: number;
  /** Other live sessions whose diffs touch at least one of the same files. */
  overlaps: number;
  /** Weighted sum of the signals above — higher means deeper human review. */
  risk: number;
}

export interface SessionReviewDetail {
  entry: ReviewQueueEntry;
  spec: TaskSpec;
  state: string;
  worktreePath: string;
  files: DiffFileStat[];
  /** Most recent gate report, if the session has been through the gate. */
  lastGateReport?: GateReport;
}
