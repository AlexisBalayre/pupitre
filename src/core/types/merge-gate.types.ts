import type { Adapter } from '../../adapters/types/adapter.types.js';

export type GateStageStatus = 'pass' | 'fail' | 'flagged' | 'skipped';

export interface GateStageResult {
  stage: string;
  status: GateStageStatus;
  detail?: string;
}

export interface GateReport {
  sessionId: string;
  passed: boolean;
  stages: GateStageResult[];
}

export interface AcceptDebtRequest {
  reason: string;
  reviewBy: string;
}

export interface MergeRequest {
  repoPath: string;
  sessionId: string;
  adapter: Adapter;
  acceptDebt?: AcceptDebtRequest;
}

/**
 * `merged` landed on the target branch; `refused` means the soft diff-size flag
 * blocked the merge but the session stays in awaiting-review (a human decides);
 * `rejected` re-steered the session with the report; `blocked` parked it
 * (reject cap reached or the session was unreachable).
 */
export type MergeStatus = 'merged' | 'refused' | 'rejected' | 'blocked';

export interface MergeOutcome {
  status: MergeStatus;
  report: GateReport;
  rejectCount: number;
  /**
   * On merge: open ledger entries whose files this diff touched — candidates
   * for `pup debt close`, pending human confirmation (docs/04).
   */
  debtCandidates?: { id: number; description: string }[];
}
