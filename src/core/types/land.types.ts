import type { AuditOutcome } from './audit.types.js';

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
   * Set when the local branch held commits main does not, and was kept. Never
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
  audit: AuditOutcome;
}
