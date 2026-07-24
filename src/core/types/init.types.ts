import type { DeadExport } from '../../adapters/types/adapter.types.js';

export type BaselineStageStatus = 'pass' | 'fail' | 'skipped';

export interface BaselineStageResult {
  stage: string;
  status: BaselineStageStatus;
  detail?: string;
  durationMs: number;
}

/**
 * Repo-wide debt metrics the gate flags increases against. Ratcheted to the
 * measured value on every merge (docs/04); a field is absent when no adapter
 * can measure it, and the matching gate stage skips as "not measured".
 */
export interface DebtBaseline {
  deadExports?: DeadExport[];
  duplicatedLines?: number;
  /** Repo-wide covered/instrumented line ratio in [0, 1]; the patch-coverage bar. */
  coverageRatio?: number;
}

/** Stored on projects.baseline as JSON; day one blocks nothing (docs/04). */
export interface ProjectBaseline {
  capturedAt: string;
  adapters: string[];
  stages: BaselineStageResult[];
  debt?: DebtBaseline;
}

export interface InitReport {
  projectId: string;
  baseline: ProjectBaseline;
  /** Gaps a human should look at: missing commands, stages failing at baseline. */
  findings: string[];
}
