import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import { killSession as killTmux } from '../claude/session-runtime.service.js';
import { rethrowIfKilled, runGit } from './git-diff.client.js';
import { assertGhAvailable, originRepoSlug, readPullRequestLanding } from './github.client.js';
import { COMMIT_SHA } from './merge-gate.constants.js';
import {
  assertMintedRow,
  assertPullRequestOf,
  deleteBranchAt,
  isAncestor,
  MERGE_LOCK_WAIT_MS,
  newestMerge,
  type OriginUse,
  pushTarget,
  resolveCommit,
  withMergeLock,
} from './merge-gate.service.js';
import { appendEvent, getSession, listEvents, type SessionRow } from './session.repository.js';

const UNTOUCHED = 'Nothing was retired.';
const RETIRE_USE: OriginUse = { command: '`pup retire`', untouched: UNTOUCHED };

interface RetireRequest {
  repoPath: string;
  sessionId: string;
  /** The merged PR that re-landed the work: its number, or its url on the session's repo. */
  supersededBy: string;
  /** Wait for a merge lock a live run holds, as `pup retire` does, rather than refuse (decision 88). */
  wait?: boolean;
}

/** What `pup retire` did, for the CLI to print (decision 141). */
export interface RetireOutcome {
  prUrl: string;
  supersededBy: string;
  removedWorktree: boolean;
  /** Set when the local branch held commits past the pinned sha, and was kept. */
  keptBranch?: string;
}

/**
 * `pup retire <session> --superseded-by <pr>` (decision 141): the close-out of
 * a merged session whose PR was closed unmerged because another PR re-landed
 * its work. Every refusal comes before anything moves: the session must be
 * merged with a PR that GitHub says is CLOSED, and the PR the operator names
 * must be MERGED into the same target. Then, under the merge lock, the
 * session's worktree and branch go and a `retired` event naming both PRs drops
 * the session from the inbox. The operator names the superseding PR; nothing
 * reads it off PR comments. A re-run after a failure under the lock is safe:
 * the teardown skips what is already gone, and the event is the lock's last
 * write.
 */
export async function retireSession(db: Database, req: RetireRequest): Promise<RetireOutcome> {
  const session = getSession(db, req.sessionId);
  const id = sanitizeReason(req.sessionId);
  if (!session) throw new Error(`No session ${id}. ${UNTOUCHED}`);
  if (session.state !== 'merged') {
    throw new Error(
      `Session ${id} is ${sanitizeReason(session.state)}, not merged; only a session whose PR ` +
        `was closed unmerged can be retired. ${UNTOUCHED}`,
    );
  }
  assertStanding(db, session.id, id);
  const merge = newestMerge(db, session.id);
  if (merge === 'landed') throw new Error(`Session ${id} has landed; there is nothing to retire.`);
  if (merge?.prUrl === undefined) {
    throw new Error(
      `Session ${id} opened no pull request: its merge was a local fast-forward, already on ` +
        `the target. ${UNTOUCHED}`,
    );
  }
  const { prUrl, sha, target } = merge;
  if (sha === undefined || !COMMIT_SHA.test(sha) || target === undefined) {
    throw new Error(
      `Session ${id}'s merge event names no pinned sha and target, so there is nothing to ` +
        `tell its branch's own commits by. ${UNTOUCHED}`,
    );
  }
  assertMintedRow(req.repoPath, session, UNTOUCHED);
  const repo = originRepoSlug(pushTarget(db, session, req.repoPath, RETIRE_USE));
  // Store text: a pull request of another repo would answer for this one.
  assertPullRequestOf(prUrl, repo, UNTOUCHED);
  const supersededBy = supersedingUrl(req.supersededBy, repo);
  assertGhAvailable(RETIRE_USE.command);
  const pr = readPullRequestLanding(req.repoPath, prUrl, repo);
  if (pr.state === 'MERGED') {
    throw new Error(
      `${prUrl} is MERGED on GitHub; land it with \`pup land ${id}\` rather than retire it. ` +
        UNTOUCHED,
    );
  }
  if (pr.state !== 'CLOSED') {
    throw new Error(
      `${prUrl} is ${sanitizeReason(pr.state ?? 'in an unreadable state')} on GitHub, not ` +
        `CLOSED; close it there first, or land it. ${UNTOUCHED}`,
    );
  }
  const superseding = readPullRequestLanding(req.repoPath, supersededBy, repo);
  if (superseding.state !== 'MERGED') {
    throw new Error(
      `${supersededBy} is ${sanitizeReason(superseding.state ?? 'in an unreadable state')} on ` +
        `GitHub, not MERGED; only a merged PR supersedes another. ${UNTOUCHED}`,
    );
  }
  // Merged into another branch, it re-landed nothing on the target the work was for.
  if (superseding.base !== target) {
    throw new Error(
      `${supersededBy} was merged into ${sanitizeReason(superseding.base ?? 'an unreadable branch')}, ` +
        `not ${target}, the target ${id}'s PR was for. ${UNTOUCHED}`,
    );
  }

  return withMergeLock(
    req.repoPath,
    () => {
      // `pup fix` takes the session out of merged under this lock, maybe while
      // GitHub was being read above; retiring then would tear down its live round.
      const now = getSession(db, session.id)?.state;
      if (now !== 'merged') {
        throw new Error(
          (now === undefined
            ? `Session ${id} was removed from the store`
            : `Session ${id} became ${sanitizeReason(now)}`) +
            ` while \`pup retire\` waited for the merge lock. ${UNTOUCHED}`,
        );
      }
      assertStanding(db, session.id, id);
      const tornDown = tearDown(req.repoPath, session, sha);
      appendEvent(db, session.id, 'retired', { prUrl, supersededBy });
      return { prUrl, supersededBy, ...tornDown };
    },
    req.wait ? MERGE_LOCK_WAIT_MS : 0,
  );
}

/** Refuse a session already closed out: the newest `landed` or `retired` event comes after its merge. */
function assertStanding(db: Database, sessionId: string, id: string): void {
  const newest = listEvents(db, sessionId)
    .reverse()
    .find((row) => ['merge', 'landed', 'retired'].includes(row.type));
  if (newest?.type === 'retired') throw new Error(`Session ${id} has already been retired.`);
}

/**
 * The superseding PR as a url on `repo`: a bare number, or `#` and one, is
 * read as a PR of the session's own repo; a url must be one of that repo's,
 * since gh would answer for a PR anywhere.
 */
function supersedingUrl(supersededBy: string, repo: string): string {
  const number = /^#?([1-9][0-9]*)$/.exec(supersededBy.trim())?.[1];
  if (number !== undefined) return `https://${repo}/pull/${number}`;
  assertPullRequestOf(supersededBy, repo, UNTOUCHED);
  return supersededBy;
}

/**
 * The session's worktree, and its branch while it holds no commit past the
 * pinned `sha`: the closed PR carried that sha, and a commit past it is work
 * nothing re-landed, kept for the operator. A worktree git cannot remove (a
 * session can lock its own) refuses the retire, with no event written, so a
 * re-run after the operator unlocks it finishes the job. The session's worker
 * window is stopped first, so no live agent has its tree pulled out from under
 * it.
 */
function tearDown(
  repoPath: string,
  session: SessionRow,
  sha: string,
): { removedWorktree: boolean; keptBranch?: string } {
  // By exact name only, never by the stored pane id the gate also kills by: a
  // retired session is old, a tmux server restarted since reissues pane ids
  // from %0, and `kill-session` on a reissued id would end whichever session
  // now holds that pane, the operator's own included. A window renamed from
  // inside is missed, the cost decision 46 names for a name-only kill. A
  // silent no-op when the window is already gone.
  killTmux(session.id);
  runGit(repoPath, ['worktree', 'prune']);
  // Asked of git, not the filesystem, as `pup land` asks it (decision 84).
  const registered = runGit(repoPath, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .includes(`worktree ${session.worktree_path}`);
  if (registered) {
    try {
      runGit(repoPath, ['worktree', 'remove', '--force', session.worktree_path], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      rethrowIfKilled(error);
      throw new Error(
        `git could not remove the worktree at ${sanitizeReason(session.worktree_path)} (a lock, ` +
          `most likely); unlock it and re-run \`pup retire\`. ${UNTOUCHED}`,
      );
    }
  }
  const branchRef = `refs/heads/${session.branch}`;
  let branchSha: string;
  try {
    branchSha = resolveCommit(repoPath, branchRef);
  } catch (error) {
    rethrowIfKilled(error);
    // already gone, or a symref the gate refuses to follow
    return { removedWorktree: registered };
  }
  if (isAncestor(repoPath, branchSha, sha) && deleteBranchAt(repoPath, branchRef, branchSha)) {
    return { removedWorktree: registered };
  }
  return { removedWorktree: registered, keptBranch: session.branch };
}
