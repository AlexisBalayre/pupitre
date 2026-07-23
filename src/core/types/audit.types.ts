import type { BaselineStageStatus, ProjectBaseline } from './init.types.js';

/** 'changed' covers fail<->skipped moves: neither passes, so neither word fits. */
export type StageDelta = 'regressed' | 'improved' | 'changed' | 'unchanged';

export interface StageTransition {
  stage: string;
  before: BaselineStageStatus;
  after: BaselineStageStatus;
  delta: StageDelta;
}

export interface AuditReport {
  projectId: string;
  /** Baseline stored before this audit ran; null means first run (behaves like `pup init`). */
  previous: ProjectBaseline | null;
  /** Fresh result, already stored as the new baseline. */
  baseline: ProjectBaseline;
  /** Empty when there was no previous baseline to compare against. */
  transitions: StageTransition[];
  hasRegression: boolean;
  findings: string[];
}
