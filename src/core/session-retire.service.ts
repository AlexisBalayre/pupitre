import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import { killSession as killTmux } from '../claude/session-runtime.service.js';
import { runGit } from './git-diff.client.js';
import { assertGhAvailable, originRepoSlug, readPullRequestLanding } from './github.client.js';
import {
  assertMintedRow,
  assertPullRequestOf,
  MERGE_LOCK_WAIT_MS,
  type OriginUse,
  pushTarget,
  withMergeLock,
} from './merge-gate.service.js';
import {
  appendEvent,
  type EventRow,
  getSession,
  listEvents,
  type SessionRow,
} from './session.repository.js';
import {
  assertStillMerged,
  assertUnlockedWorktree,
  deleteBranchIfHeld,
  pinnedPullRequest,
} from './session-teardown.utils.js';

const UNTOUCHED = 'Nothing was retired.';
const RETIRE_USE: OriginUse = { command: '`pup retire`', untouched: UNTOUCHED };
/** The events that start or close out what a merge stands for. */
const STANDING_EVENTS: readonly string[] = ['merge', 'fix_round', 'landed', 'retired'];

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
  const checked = newestStanding(db, session.id, id);
  const { prUrl, sha, target } = pinnedPullRequest(db, session.id, id, UNTOUCHED);
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
      assertStillMerged(db, session.id, id, RETIRE_USE);
      // A re-gate (a fix round's, which opens a new PR) or a land while this
      // waited leaves the state merged but the PR checked above no longer the
      // session's: retiring then would close out the wrong one.
      const now = newestStanding(db, session.id, id);
      if (now?.id !== checked?.id) {
        throw new Error(
          `Session ${id} recorded a ${now?.type} event while \`pup retire\` waited for the ` +
            `merge lock, so the PR checked is no longer the one its merge stands for. ${UNTOUCHED}`,
        );
      }
      const tornDown = tearDown(req.repoPath, session, sha);
      appendEvent(db, session.id, 'retired', { prUrl, supersededBy });
      return { prUrl, supersededBy, ...tornDown };
    },
    req.wait ? MERGE_LOCK_WAIT_MS : 0,
  );
}

/**
 * The newest of the session's merge, fix round, landed and retired events,
 * refusing a session already retired. Read before the lock and again under
 * it: any other row then means the merge checked no longer stands.
 */
function newestStanding(db: Database, sessionId: string, id: string): EventRow | undefined {
  const newest = listEvents(db, sessionId)
    .reverse()
    .find((row) => STANDING_EVENTS.includes(row.type));
  if (newest?.type === 'retired') throw new Error(`Session ${id} has already been retired.`);
  return newest;
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
 * nothing re-landed, kept for the operator. A worktree git holds locked (a
 * session can lock its own) refuses the retire before the window is stopped,
 * with no event written, so a re-run after the operator unlocks it finishes
 * the job. The session's worker window is stopped before the removal, so no
 * live agent has its tree pulled out from under it. `--force` discards the
 * worktree's uncommitted files, as `pup land` does (decision 84).
 */
function tearDown(
  repoPath: string,
  session: SessionRow,
  sha: string,
): { removedWorktree: boolean; keptBranch?: string } {
  const registered = assertUnlockedWorktree(repoPath, session.worktree_path, RETIRE_USE);
  // By exact name only, never by the stored pane id the gate also kills by: a
  // retired session is old, a tmux server restarted since reissues pane ids
  // from %0, and `kill-session` on a reissued id would end whichever session
  // now holds that pane, the operator's own included. A window renamed from
  // inside is missed, the cost decision 46 names for a name-only kill. A
  // silent no-op when the window is already gone.
  killTmux(session.id);
  if (registered) {
    runGit(repoPath, ['worktree', 'remove', '--force', session.worktree_path], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  const keptBranch = deleteBranchIfHeld(repoPath, session.branch, [sha]);
  return keptBranch === undefined
    ? { removedWorktree: registered }
    : { removedWorktree: registered, keptBranch };
}
