import type { Adapter } from '../../adapters/types/adapter.types.js';
import type { SessionRow } from '../session.repository.js';
import type { AuditOutcome } from './audit.types.js';
import type { GateReport } from './merge-gate.types.js';

/** What `pup land` did, for the CLI to print (decision 84). */
export interface LandOutcome {
  prUrl: string;
  /** The commit GitHub's merge made, as the `landed` event records it. */
  mergeCommit: string;
  target: string;
  /** Where the local target stands after the land: origin's tip, or past it. */
  targetSha: string;
  fastForwarded: boolean;
  removedWorktree: boolean;
  /**
   * Set when the local branch held commits neither main nor the pinned sha
   * does, and was kept. Never
   * set with `keptWorktree`, which keeps the branch too: read both.
   */
  keptBranch?: string;
  /**
   * Set when git could not remove the worktree (a session can lock its own):
   * it is kept with its branch, which `keptBranch` then does not name, since
   * deleting the branch a surviving worktree has checked out would leave that
   * worktree on a branch that does not exist.
   */
  keptWorktree?: string;
  /**
   * The running sessions overlapping the landed PR that were not steered: the
   * steer failed, or git could not read the branch to tell (decision 99).
   * Absent when every one was steered. `reason` is store and git text.
   */
  unsteered?: { sessionId: string; reason: string }[];
  /** With `--remeasure`: the gate's stages on the merge commit, every one passed (decision 185). */
  remeasure?: GateReport;
  /** Absent when the land skipped it (`--no-audit`, decision 132): `pup audit` is then the operator's. */
  audit?: AuditOutcome;
}

/** What `pup land <session> <session> ...` did (decision 195). */
export interface LandBatchOutcome {
  /** Each session landed, in the order GitHub merged them; no outcome carries an audit. */
  landed: { sessionId: string; outcome: LandOutcome }[];
  /** Each session its own checks refused, with the refusal: it landed nothing. */
  refused: { sessionId: string; reason: string }[];
  /** The one audit after the last land; absent when none landed or `--no-audit` skipped it. */
  audit?: AuditOutcome;
  /** Why that audit failed: the lands stand, and `pup audit` is the operator's to re-run. */
  auditFailure?: string;
}

export interface LandRequest {
  repoPath: string;
  sessionId: string;
  adapters: Adapter[];
  gateEnv?: string[];
  /** Wait for a merge lock a live run holds, as `pup land` does, rather than refuse (decision 88). */
  wait?: boolean;
  /** `false` lands without the audit, so several lands share one `pup audit` (decision 132). */
  audit?: boolean;
  /**
   * The operator's word for a head the PR merged at past the pin (decision
   * 164): the full sha GitHub reports, after reading the commits between them.
   */
  acceptHead?: string;
  /**
   * The gate's word for a head the PR merged at past the pin (decision 185):
   * its stages run on the merge commit under the lock, and only a pass lands.
   */
  remeasure?: boolean;
  /**
   * Who approved a remeasure whose commits past the pin touch a critical area
   * (decision 185), scrubbed by the caller; the land event records it.
   */
  approvedBy?: string;
}

/** A merged session and the PR its newest merge pinned, as `landablePullRequest` reads them. */
export interface PinnedPullRequest {
  session: SessionRow;
  id: string;
  prUrl: string;
  sha: string;
  target: string;
  originUrl: string;
  repo: string;
}

/** A session `checkLanding` passed: what GitHub says merged it, read before the lock. */
export interface Landable extends Omit<PinnedPullRequest, 'repo'> {
  head: string;
  mergeCommit: string;
  pullRef: string;
}
