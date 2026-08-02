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
  /**
   * How the stage children were confined, as `sandboxLabel()` phrases it. It
   * rides in the report — the operator's terminal, the PR body, the stored
   * event — because a run on a platform pup cannot sandbox has to say so where
   * the result is read, not only in the docs (decisions 29, 36).
   */
  sandbox: string;
  stages: GateStageResult[];
}

interface AcceptDebtRequest {
  reason: string;
  reviewBy: string;
  /**
   * Who the ledger records as accepting the debt: the session id when the
   * merge runs inside a session, `'human'` otherwise — the audit trail must
   * not claim human attribution for an agent's call (decision 27).
   */
  acceptedBy: string;
}

export interface MergeRequest {
  repoPath: string;
  sessionId: string;
  adapter: Adapter;
  acceptDebt?: AcceptDebtRequest;
  /** Push the branch and open a pull request instead of merging locally (decision 26). */
  openPr?: boolean;
  /** Env names `--gate-env` lets through to gate children (decision 36). */
  gateEnv?: string[];
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
   * True when `prUrl` was an open PR pupitre found rather than created — a
   * retry of a run that died after the push. Its description was rewritten
   * with the real gate report, but the operator is told it was adopted.
   */
  prWasAdopted?: boolean;
  /**
   * On merge: open ledger entries whose files this diff touched — candidates
   * for `pup debt close`, pending human confirmation (docs/04).
   */
  debtCandidates?: { id: number; description: string }[];
  /** On merge: the drafted decision record, for one-keystroke human approval. */
  decisionRecordId?: number;
}
