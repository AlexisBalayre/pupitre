export type BaselineStageStatus = 'pass' | 'fail' | 'skipped';

export interface BaselineStageResult {
  stage: string;
  status: BaselineStageStatus;
  detail?: string;
  durationMs: number;
}

/** Stored on projects.baseline as JSON; day one blocks nothing (docs/04). */
export interface ProjectBaseline {
  capturedAt: string;
  adapters: string[];
  stages: BaselineStageResult[];
}

export interface InitReport {
  projectId: string;
  baseline: ProjectBaseline;
  /** Gaps a human should look at: missing commands, stages failing at baseline. */
  findings: string[];
}
