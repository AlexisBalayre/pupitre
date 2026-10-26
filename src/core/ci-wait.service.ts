import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import { rethrowIfKilled } from './git-diff.client.js';
import {
  assertGhAvailable,
  isCutOffByNode,
  originRepoSlug,
  type PullRequestReview,
  readPullRequestReview,
} from './github.client.js';
import {
  assertMintedRow,
  assertPullRequestOf,
  newestMerge,
  type OriginUse,
  pushTarget,
} from './merge-gate.service.js';
import { projectId } from './paths.utils.js';
import { getSession, getTask, listSessions, type SessionRow } from './session.repository.js';

const CI_WAIT_USE: OriginUse = { command: '`pup ci wait`', untouched: 'Nothing was waited for.' };
/** Between two reads of the PR: a review takes minutes, and each read is one GraphQL call. */
const POLL_MS = 30_000;
/** One read's budget; a slow answer is one more wait, not the end of it. */
const READ_TIMEOUT_MS = 20_000;
/** The poster's clean verdict on a head it reviewed in full (`post-review.script.ts`). */
const CLEAN_REVIEW_STATUS = 'no blocking issues';
/** What the preflight's PENDING status says on a push it skipped as comment-only. */
const COMMENT_ONLY_STATUS = 'Not reviewed: only comments and prose changed';
/**
 * Symbols a GitHub string could pass off as the digest's own `→`, so a forged
 * status could not name a next step of its own: every arrow and emoji, the
 * inbox's own class (`dashboard.service.ts`). ASCII stays.
 */
const SYMBOLS = /(?![\0-\x7F])[\p{Sm}\p{So}]/gu;

/** A string GitHub or gh returned, as the line prints it: one scrubbed line, no symbols. */
function shown(text: string): string {
  return sanitizeReason(text).replace(SYMBOLS, '-');
}

/** The wait's sense of time, which a test replaces. */
export interface CiWaitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: CiWaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface CiWaitRequest {
  repoPath: string;
  /** A session id, or the url or number of the PR a session of this project opened. */
  target: string;
  timeoutMs: number;
  pollMs?: number;
  /** One read's budget, which a test shortens. */
  readTimeoutMs?: number;
  clock?: CiWaitClock;
}

interface CiWaitOutcome {
  /** False when the timeout ran out before the review of the current head finished. */
  finished: boolean;
  /** The one line the caller prints: the digest, or why the wait ended without one. */
  line: string;
}

/**
 * `pup ci wait <session|pr>` (decision 90): block, in the caller's foreground,
 * until the CI review of the PR's current head has finished, then answer one
 * digest line: the head, the review's outcome, its open and important
 * findings, and the next step. The head is read afresh on every poll, so a
 * review of an older head, or a status on one, is never the answer for a head
 * pushed since. Finished means the bot's newest review is on the head under
 * its final `SUCCESS` status, its `FAILURE` on the head, the preflight's
 * comment-only skip on it, or a PR no longer open. Nothing prints while it
 * waits; a gh read that fails is one more wait, and the timeout's line names
 * the last thing seen.
 */
export async function waitForCiReview(db: Database, req: CiWaitRequest): Promise<CiWaitOutcome> {
  const { session, prUrl, repo } = pullRequestToWaitOn(db, req.repoPath, req.target);
  assertGhAvailable(CI_WAIT_USE.command);
  const clock = req.clock ?? REAL_CLOCK;
  // Minted, so the commands the line names are built around an id the store
  // cannot have shaped.
  const id = session.id;
  const deadline = clock.now() + req.timeoutMs;
  let lastSeen = 'GitHub was not read';
  for (;;) {
    try {
      const review = readPullRequestReview(
        req.repoPath,
        prUrl,
        repo,
        req.readTimeoutMs ?? READ_TIMEOUT_MS,
      );
      const digest = reviewDigest(id, prUrl, review);
      if ('line' in digest) return { finished: true, line: digest.line };
      lastSeen = digest.waiting;
    } catch (error) {
      // A read node cut off, past its budget or its buffer, is one more wait,
      // not an interrupt.
      if (!isCutOffByNode(error)) rethrowIfKilled(error);
      lastSeen = `the last read failed: ${shown(error instanceof Error ? error.message : String(error))}`;
    }
    const left = deadline - clock.now();
    if (left <= 0) {
      return {
        finished: false,
        line:
          `No finished CI review of ${prUrl} after ${Math.round(req.timeoutMs / 60_000)} min ` +
          `(${lastSeen}). Re-run \`pup ci wait ${id}\`.`,
      };
    }
    await clock.sleep(Math.min(req.pollMs ?? POLL_MS, left));
  }
}

/**
 * The session and PR to wait on. A session must have a newest merge with a PR
 * and no landing after it; a PR is the one a session of this project's newest
 * merge opened, so the digest can name the session's next command. The url is
 * store text, held to origin's recorded repo as `pup fix` holds it.
 */
function pullRequestToWaitOn(
  db: Database,
  repoPath: string,
  target: string,
): { session: SessionRow; prUrl: string; repo: string } {
  const session = getSession(db, target) ?? sessionThatOpened(db, repoPath, target);
  const named = shown(target);
  if (session === undefined) {
    throw new Error(
      `No session ${named}, and no session of this project opened a PR ${named}. ` +
        CI_WAIT_USE.untouched,
    );
  }
  assertMintedRow(repoPath, session, CI_WAIT_USE.untouched);
  const id = session.id;
  const merge = newestMerge(db, session.id);
  if (merge === 'landed') {
    throw new Error(`Session ${id} has already landed. ${CI_WAIT_USE.untouched}`);
  }
  if (merge?.prUrl === undefined) {
    throw new Error(
      `Session ${id} has no PR to wait on: run \`pup merge ${id} --pr\` first. ` +
        CI_WAIT_USE.untouched,
    );
  }
  const repo = originRepoSlug(pushTarget(db, session, repoPath, CI_WAIT_USE));
  assertPullRequestOf(merge.prUrl, repo, CI_WAIT_USE.untouched);
  return { session, prUrl: merge.prUrl, repo };
}

/** The session of this project whose newest merge opened the PR `pr` names, by url or number. */
function sessionThatOpened(db: Database, repoPath: string, pr: string): SessionRow | undefined {
  const number = /^#?(\d+)$/.exec(pr)?.[1];
  if (number === undefined && !/\/pull\/\d+$/.test(pr)) return undefined;
  const project = projectId(repoPath);
  return listSessions(db).find((session) => {
    if (getTask(db, session.task_id)?.project_id !== project) return false;
    const merge = newestMerge(db, session.id);
    if (merge === 'landed' || merge?.prUrl === undefined) return false;
    return number === undefined ? merge.prUrl === pr : merge.prUrl.endsWith(`/pull/${number}`);
  });
}

/**
 * The digest line once the review of the PR's current head has finished, or
 * what the wait is on until then. Every string GitHub returned is scrubbed
 * where it prints. Each thread the poster anchors is an important finding;
 * minors stay in the review body, and never ask for a round.
 */
function reviewDigest(
  id: string,
  prUrl: string,
  review: PullRequestReview,
): { line: string } | { waiting: string } {
  const head = shown(review.head ?? 'an unreadable head');
  const line = (outcome: string, threads: number, important: number, next: string) => ({
    line:
      `${prUrl} at ${head}: review ${outcome}; ${threads} open thread(s), ${important} ` +
      `important → ${next}`,
  });
  if (review.state === 'MERGED') return line('moot, the PR merged', 0, 0, `pup land ${id}`);
  if (review.state !== 'OPEN') {
    return line(`moot, the PR is ${shown(review.state ?? 'unreadable')}`, 0, 0, 'none');
  }
  const status = review.headStatus;
  const said = status === undefined ? 'no status' : shown(status.description);
  const threads = review.openThreads.length;
  const isOnHead = review.head !== undefined && review.reviewedHead === review.head;
  if (status?.state === 'PENDING' && status.description.startsWith(COMMENT_ONLY_STATUS)) {
    // The newest review is on an earlier head, the code this push left as it was.
    return line(
      `skipped, a comment-only push (${said})`,
      threads,
      threads,
      threads > 0
        ? "comment `@claude review` on the PR to have the head reviewed (the operator's call)"
        : "ready for the operator's merge click",
    );
  }
  if (status?.state === 'FAILURE') {
    return line(
      `reached no verdict (${said})`,
      threads,
      0,
      "comment `@claude review` on the PR to re-run it (the operator's call)",
    );
  }
  if (status?.state === 'SUCCESS' && isOnHead) {
    const important = Number(/(\d+) important finding/.exec(status.description)?.[1] ?? 0);
    const next =
      threads > 0
        ? `pup fix ${id}`
        : status.description === CLEAN_REVIEW_STATUS
          ? "ready for the operator's merge click"
          : 'read the PR: its findings are in the review body, or the review was partial ' +
            "(the operator's call)";
    return line(said, threads, important, next);
  }
  return {
    waiting: isOnHead ? `reviewed ${head}, ${said}` : `no review of ${head} yet, ${said}`,
  };
}
