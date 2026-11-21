import type { PullRequestPlan } from './merge-gate.types.js';

/**
 * A re-gate's plan (decision 86): the merged session's open PR, and the head
 * GitHub reports for it, which the local branch must hold when it is pinned.
 */
export interface RegatePlan extends PullRequestPlan {
  regate: { head: string; prUrl: string };
}

export interface MergeToRegate {
  prUrl: string;
  sha: string;
  target: string;
  /** The operator recorded the PR closed unmerged, freeing its ADR numbers (decision 146). */
  closedOnRecord: boolean;
}
