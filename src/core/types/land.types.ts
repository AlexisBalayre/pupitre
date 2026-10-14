import type { AuditOutcome } from '../audit.service.js';

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
  /** Set when the local branch held commits main does not, and was kept. */
  keptBranch?: string;
  audit: AuditOutcome;
}
