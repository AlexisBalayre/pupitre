import type { BaselineStageResult, DebtBaseline } from './init.types.js';

export interface BaselineHistoryRow {
  id: number;
  project_id: string;
  /** ISO timestamp copied from ProjectBaseline.capturedAt, not a DB default. */
  captured_at: string;
  /** JSON BaselineStageResult[]. */
  stages: string;
  /** JSON DebtBaseline; null when no adapter could measure debt. */
  debt: string | null;
}

export interface NewBaselineHistoryInput {
  projectId: string;
  capturedAt: string;
  stages: BaselineStageResult[];
  debt?: DebtBaseline;
}
