/** What `pup retire` did, for the CLI to print (decision 141). */
export interface RetireOutcome {
  prUrl: string;
  supersededBy: string;
  removedWorktree: boolean;
  /** Set when the local branch held commits past the pinned sha, and was kept. */
  keptBranch?: string;
}
