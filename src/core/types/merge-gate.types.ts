import type { Adapter } from '../../adapters/types/adapter.types.js';
import type { GateStageStatus } from '../enums/gate-stage-status.enums.js';
import type { MergeStatus } from '../enums/merge-status.enums.js';
import type { PullRequestRef } from './github.types.js';
import type { DebtBaseline, ProjectBaseline } from './init.types.js';
import type { LedgerEntryRow } from './ledger.types.js';
import type { TaskSpec } from './profile.types.js';
import type { RegatePlan } from './regate.types.js';
import type { ProjectRow, SessionRow } from './session.types.js';

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

/** A changed path's new mode, and the path it was renamed or copied from if git paired one. */
export interface RawDiffEntry {
  mode: string;
  renamedFrom?: string;
  copiedFrom?: string;
}

export type DiffSizeKind = 'source' | 'test' | 'docs';

/**
 * What the branch's tree tells the diff-size split beyond a path's own name
 * (decision 110): every path on it, whether a symlink can reach the path,
 * whether the tree also holds the path, or one of its directories, in another
 * ASCII case, and whether a Docusaurus config compiles the Markdown under
 * `docs/`. And every blob's oid and size by path, so the reach checks read
 * blobs in one batch (decision 154).
 */
export interface BranchTree {
  paths: string[];
  blobs: Map<string, { oid: string; size: number }>;
  linked: (path: string) => boolean;
  foldsOntoAnother: (path: string) => boolean;
  markdownIsCode: boolean;
}

export interface MergeLockStatus {
  command: string;
  /** When the lock was taken, epoch ms. */
  since: number;
  /** The holder's status-line label; empty before its first stage. */
  stage: string;
}

/** Which directory a lock is, so a later step can tell it from one swapped in for it. */
export interface LockIdentity {
  dev: number;
  ino: number;
}

/**
 * A take of the merge lock: the directory it made, the token it wrote there,
 * and the status file it made there, held open.
 */
export interface LockTake extends LockIdentity {
  token: string;
  statusFd: number;
}

/** What `planMerge` settled before the lock, for the run under it. */
export interface MergePlan {
  session: SessionRow;
  /** `sessionMark` before the plan read anything. */
  mark: string;
  sandbox: string;
  target: string;
  pullRequest?: PullRequestPlan;
  regate?: RegatePlan;
}

/** Who asks `pushTarget`, and what its refusal leaves undone, for the message. */
export interface OriginUse {
  command: string;
  untouched: string;
}

export interface PullRequestPlan extends PullRequestRef {
  /** The push target recorded at setup; the push goes here literally (decision 56). */
  originUrl: string;
  /** Set when an open PR for this branch already exists and passed adoption checks. */
  adoptedUrl?: string;
}

/** What the stages measured, for the caller that lands it. */
export interface BranchMeasurement {
  changedPaths: string[];
  flaggedDebt: FlaggedDebt[];
  debtCandidates: { id: number; description: string }[];
  /** The project's open ledger entries, read before this run filed any. */
  openEntries: LedgerEntryRow[];
  projectId: string;
  spec: TaskSpec;
  project: ProjectRow | undefined;
  baseline: ProjectBaseline | undefined;
  ratchet: DebtBaseline;
}

export type FlaggedDebt = { description: string; files: string[] };
