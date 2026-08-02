import type { BaselineStageStatus, ProjectBaseline } from './init.types.js';

/** 'changed' covers fail<->skipped moves: neither passes, so neither word fits. */
export type StageDelta = 'regressed' | 'improved' | 'changed' | 'unchanged';

export interface StageTransition {
  stage: string;
  before: BaselineStageStatus;
  after: BaselineStageStatus;
  delta: StageDelta;
}

export type DebtMetric = 'deadExports' | 'duplicatedLines' | 'coverageRatio';

/** deadExports compares counts, not the export identities merge-gate diffs (docs/09 decision 34). */
export interface DebtTransition {
  metric: DebtMetric;
  before: number;
  after: number;
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
  /** Empty when there was no previous debt baseline, or a metric wasn't measured on both sides. */
  debtTransitions: DebtTransition[];
  hasRegression: boolean;
  findings: string[];
}
