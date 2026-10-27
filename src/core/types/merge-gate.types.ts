import type { Adapter } from '../../adapters/types/adapter.types.js';

type GateStageStatus = 'pass' | 'fail' | 'flagged' | 'skipped';

export interface GateStageResult {
  stage: string;
  status: GateStageStatus;
  detail?: string;
  /**
   * Wall time of what the stage ran, in ms, printed with it (decision 95).
   * Stages run alongside one another, so the times overlap rather than add up
   * to the gate's. Absent on a stage that ran nothing.
   */
  durationMs?: number;
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
   * Who the ledger records as accepting the debt: `'human'` for the operator,
   * or the approver a conductor names with `--approved-by` — the audit trail
   * must not claim the operator's attribution for a call the operator did not
   * make (decisions 27, 75). Scrubbed before it is stored.
   */
  acceptedBy: string;
}

export interface MergeRequest {
  repoPath: string;
  sessionId: string;
  /**
   * Every adapter detected for the repo, in detection order. Debt is measured
   * over all of them, so a TypeScript+Python repo gates against the same bar
   * `pup init` recorded; the hard stages and the nested-package check stay with
   * the first, whose runner owns the repo's scripts (decision 72, amending 22).
   */
  adapters: Adapter[];
  acceptDebt?: AcceptDebtRequest;
  /** Push the branch and open a pull request instead of merging locally (decision 26). */
  openPr?: boolean;
  /** Env names `--gate-env` lets through to gate children (decision 36). */
  gateEnv?: string[];
  /**
   * Wait, bounded, for a merge lock a live run holds and for the machine's load
   * to fall before the tests, rather than refuse at once (decision 88). Only
   * the CLI opts in.
   */
  wait?: boolean;
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
   * True when this run re-gated a merged session on its PR's new head
   * (decision 86): passed or refused, the session has no window to steer, and
   * a refusal leaves the PR vouching for the earlier pin only.
   */
  regated?: boolean;
  /**
   * On merge: open ledger entries whose files this diff touched — candidates
   * for `pup debt close`, pending human confirmation (docs/04).
   */
  debtCandidates?: { id: number; description: string }[];
  /** On merge: the drafted decision record, for one-keystroke human approval. */
  decisionRecordId?: number;
  /**
   * On merge: the session worktree git could not remove (a lock, most likely),
   * kept with its branch; the ratchet and the draft ran all the same.
   */
  keptWorktree?: string;
}
