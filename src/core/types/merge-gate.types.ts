import type { Adapter } from '../../adapters/types/adapter.types.js';

type GateStageStatus = 'pass' | 'fail' | 'flagged' | 'skipped';

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

interface AcceptDebtRequest {
  reason: string;
  reviewBy: string;
}

export interface MergeRequest {
  repoPath: string;
  sessionId: string;
  adapter: Adapter;
  acceptDebt?: AcceptDebtRequest;
  /** Push the branch and open a pull request instead of merging locally (decision 26). */
  openPr?: boolean;
}

/**
 * `merged` landed on the target branch — or, with `openPr`, passed the gate and
 * left pupitre's custody as a pull request; `refused` means the soft diff-size
 * flag blocked the merge but the session stays in awaiting-review (a human
 * decides); `rejected` re-steered the session with the report; `blocked` parked
 * it (reject cap reached or the session was unreachable).
 */
type MergeStatus = 'merged' | 'refused' | 'rejected' | 'blocked';

export interface MergeOutcome {
  status: MergeStatus;
  report: GateReport;
  rejectCount: number;
  /** With `openPr`: the pull request the gate opened on pass. */
  prUrl?: string;
  /**
   * On merge: open ledger entries whose files this diff touched — candidates
   * for `pup debt close`, pending human confirmation (docs/04).
   */
  debtCandidates?: { id: number; description: string }[];
  /** On merge: the drafted decision record, for one-keystroke human approval. */
  decisionRecordId?: number;
}
