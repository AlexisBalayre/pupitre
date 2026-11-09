import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import { rethrowIfKilled, runGit } from './git-diff.client.js';
import { COMMIT_SHA } from './merge-gate.constants.js';
import {
  deleteBranchAt,
  isAncestor,
  newestMerge,
  type OriginUse,
  resolveCommit,
} from './merge-gate.service.js';
import { getSession } from './session.repository.js';

// What `pup land` (decision 84) and `pup retire` (decision 141) share in closing
// out a merged session's pull request: the merge they start from, the re-check
// under the merge lock, and the teardown of what the gate left behind.

/**
 * The newest merge of a merged session, which must have opened a PR and pinned
 * a sha onto a target, and not have landed. `id` is the sanitized session id the
 * refusals print.
 */
export function pinnedPullRequest(
  db: Database,
  sessionId: string,
  id: string,
  untouched: string,
): { prUrl: string; sha: string; target: string } {
  const merge = newestMerge(db, sessionId);
  if (merge === 'landed') throw new Error(`Session ${id} has already landed.`);
  if (merge?.prUrl === undefined) {
    throw new Error(
      `Session ${id} opened no pull request: its merge was a local fast-forward, already on ` +
        `the target. ${untouched}`,
    );
  }
  const { prUrl, sha, target } = merge;
  if (sha === undefined || !COMMIT_SHA.test(sha) || target === undefined) {
    throw new Error(
      `Session ${id}'s merge event names no pinned sha and target, so there is nothing to ` +
        `check origin against. ${untouched}`,
    );
  }
  return { prUrl, sha, target };
}

/**
 * Under the merge lock: refuse a session that is no longer merged. `pup fix`
 * takes a session out of merged under this lock, maybe while GitHub was being
 * read before it; closing it out then would tear down its live round (decision 88).
 */
export function assertStillMerged(
  db: Database,
  sessionId: string,
  id: string,
  use: OriginUse,
): void {
  const now = getSession(db, sessionId)?.state;
  if (now !== 'merged') {
    throw new Error(
      (now === undefined
        ? `Session ${id} was removed from the store`
        : `Session ${id} became ${sanitizeReason(now)}`) +
        ` while ${use.command} waited for the merge lock. ${use.untouched}`,
    );
  }
}

/**
 * git's porcelain lines for `worktreePath`, after a prune, or undefined when
 * git does not register it. Asked of git, not the filesystem: a directory git
 * no longer registers, left by a teardown that failed part-way, cannot be
 * removed through git and would refuse every re-run.
 */
function worktreeEntry(repoPath: string, worktreePath: string): string[] | undefined {
  runGit(repoPath, ['worktree', 'prune']);
  return runGit(repoPath, ['worktree', 'list', '--porcelain'])
    .split('\n\n')
    .map((block) => block.split('\n'))
    .find((lines) => lines[0] === `worktree ${worktreePath}`);
}

/** Whether git registers `worktreePath`, after a prune. */
export function isRegisteredWorktree(repoPath: string, worktreePath: string): boolean {
  return worktreeEntry(repoPath, worktreePath) !== undefined;
}

/**
 * Whether git registers `worktreePath`, refusing one git holds locked: `worktree
 * remove --force` fails on a lock, and a caller asks before it stops the
 * session's window, so a refusal moves nothing (decision 141).
 */
export function assertUnlockedWorktree(
  repoPath: string,
  worktreePath: string,
  use: OriginUse,
): boolean {
  const entry = worktreeEntry(repoPath, worktreePath);
  if (entry?.some((line) => line === 'locked' || line.startsWith('locked '))) {
    throw new Error(
      `git holds the worktree at ${sanitizeReason(worktreePath)} locked; unlock it with ` +
        `\`git worktree unlock\` and re-run ${use.command}. ${use.untouched}`,
    );
  }
  return entry !== undefined;
}

/**
 * Delete `branch` while one of `heldBy` holds every commit of it, and return
 * the branch name when it is kept, holding commits none of them has. A branch
 * already gone, or a symref the gate refuses to follow, is nothing to keep.
 */
export function deleteBranchIfHeld(
  repoPath: string,
  branch: string,
  heldBy: string[],
): string | undefined {
  const branchRef = `refs/heads/${branch}`;
  let branchSha: string;
  try {
    branchSha = resolveCommit(repoPath, branchRef);
  } catch (error) {
    rethrowIfKilled(error);
    return undefined;
  }
  const held = heldBy.some((sha) => isAncestor(repoPath, branchSha, sha));
  return held && deleteBranchAt(repoPath, branchRef, branchSha) ? undefined : branch;
}
