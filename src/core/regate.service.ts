import type { Database } from 'better-sqlite3';
import { sanitizeReason } from '../adapters/capability.utils.js';
import { rethrowIfKilled } from './git-diff.client.js';
import {
  assertPullRequestHead,
  findOpenPullRequest,
  readPullRequestLanding,
  rewritePullRequest,
} from './github.client.js';
import { COMMIT_SHA } from './merge-gate.constants.js';
import {
  assertPullRequestOf,
  commitSubjectsBetween,
  fileAcceptedDebt,
  isAncestor,
  measureBranch,
  newestMerge,
  type PullRequestPlan,
  pullRequestText,
  recordMerge,
  refuseGate,
  resolveCommit,
  timedSince,
  withLedgerKept,
} from './merge-gate.service.js';
import { appendEvent, type SessionRow } from './session.repository.js';
import type { PullRequestRef } from './types/github.types.js';
import type {
  GateReport,
  GateStageResult,
  MergeOutcome,
  MergeRequest,
} from './types/merge-gate.types.js';

const NOT_REGATED = 'Nothing was re-gated.';

/**
 * A re-gate's plan (decision 86): the merged session's open PR, and the head
 * GitHub reports for it, which the local branch must hold when it is pinned.
 */
export interface RegatePlan extends PullRequestPlan {
  regate: { head: string; prUrl: string };
}

interface MergeToRegate {
  prUrl: string;
  sha: string;
  target: string;
}

/**
 * The merge a re-gate starts from (decision 86): the newest `merge` event of a
 * merged session, which must have opened a PR, pinned a sha and not landed.
 * Read before anything spawns, so a merged session with nothing to re-gate is
 * refused as cheaply as one in any other state.
 */
export function mergeToRegate(db: Database, sessionId: string): MergeToRegate {
  const id = sanitizeReason(sessionId);
  const merge = newestMerge(db, sessionId);
  if (merge === 'landed') {
    throw new Error(`Session ${id} has already landed; there is no PR to re-gate. ${NOT_REGATED}`);
  }
  if (merge?.prUrl === undefined) {
    throw new Error(
      `Session ${id} is merged with no pull request: its merge was a local fast-forward, ` +
        `already on the target, so there is no PR to re-gate. ${NOT_REGATED}`,
    );
  }
  const { prUrl, sha, target } = merge;
  if (sha === undefined || !COMMIT_SHA.test(sha) || target === undefined) {
    throw new Error(
      `Session ${id}'s merge event names no pinned sha and target, so there is no pin to tell ` +
        `a moved head from. ${NOT_REGATED}`,
    );
  }
  return { prUrl, sha, target };
}

/**
 * Settle a re-gate with GitHub before the lock, as `findOpenPullRequest`
 * settles a first `--pr` gate (decisions 27, 86): the PR the merge recorded
 * must still be OPEN onto the same target, with a head other than the pinned
 * sha, and be the open PR adoption finds for the branch, past the same checks.
 * A head that is not a descendant of the pin is allowed: a fix round can
 * rebase. The stages then measure that head, never anything the merge recorded.
 */
export function planRegate(
  repoPath: string,
  sessionId: string,
  merge: MergeToRegate,
  ref: PullRequestRef,
  originUrl: string,
): RegatePlan {
  const { prUrl, sha: pinned } = merge;
  assertPullRequestOf(prUrl, ref.repo, NOT_REGATED);
  if (merge.target !== ref.base) {
    throw new Error(
      `${prUrl} was gated onto ${sanitizeReason(merge.target)}, but the main checkout is on ` +
        `${sanitizeReason(ref.base)}; check out ${sanitizeReason(merge.target)} there and re-run. ` +
        NOT_REGATED,
    );
  }
  const pr = readPullRequestLanding(repoPath, prUrl, ref.repo);
  if (pr.state !== 'OPEN') {
    const why =
      pr.state === 'MERGED'
        ? `it merged already; \`pup land ${sanitizeReason(sessionId)}\` lands it if its head ` +
          'was the pinned sha'
        : pr.state === 'CLOSED'
          ? 'a closed PR has nothing to re-gate'
          : 'only an open PR is re-gated';
    throw new Error(
      `${prUrl} is ${sanitizeReason(pr.state ?? 'in an unreadable state')} on GitHub, not ` +
        `OPEN: ${why}. ${NOT_REGATED}`,
    );
  }
  if (pr.head === undefined || !COMMIT_SHA.test(pr.head)) {
    throw new Error(`GitHub reports ${prUrl} with an unreadable head. ${NOT_REGATED}`);
  }
  if (pr.head === pinned) {
    throw new Error(
      `${prUrl} still has its head at ${pinned}, the commit the gate pinned: there is nothing ` +
        `new to gate. Merge it on GitHub, then run \`pup land ${sanitizeReason(sessionId)}\`. ` +
        NOT_REGATED,
    );
  }
  const adoptedUrl = findOpenPullRequest(repoPath, ref);
  if (adoptedUrl !== prUrl) {
    throw new Error(
      `The open pull request for ${sanitizeReason(ref.head)} is ${adoptedUrl ?? 'none'}, not ${prUrl}, the one ` +
        `the merge recorded. ${NOT_REGATED}`,
    );
  }
  return { ...ref, originUrl, adoptedUrl, regate: { head: pr.head, prUrl } };
}

/**
 * A re-gate of a merged session whose open PR's head moved past the pin
 * (decision 86), with what `planRegate` settled. The stages are
 * `gateAndMerge`'s, on the local branch pinned at the head GitHub reports; the
 * rest is what a merged session leaves to do. `worktree-clean` is skipped, the
 * session's worktree having gone with the first merge, and `fresh-base` fails
 * rather than rebasing: there is no worktree to rebase in, and a rebased head
 * would no longer be the one the PR shows. A merged session has no window to
 * re-steer and no state to fall back to, so a failure is refused and the merge
 * event that stands stays the newest. On a pass nothing is pushed, the pin
 * being the head GitHub already shows, and a lease on a tracking ref the fix
 * round's push left behind would refuse it; the PR is rewritten and read back
 * at the pin, and the session stays merged. Nothing the first merge did
 * repeats: no teardown (the branch is left for `pup land`), no ratchet, no
 * decision draft, and no ledger entry of a kind the session already holds open.
 */
export async function regateMerged(
  db: Database,
  req: MergeRequest,
  session: SessionRow,
  pullRequest: RegatePlan,
  target: string,
  sandbox: string,
  checkoutDir: string,
): Promise<MergeOutcome> {
  const { regate } = pullRequest;
  const stages: GateStageResult[] = [
    {
      stage: 'worktree-clean',
      status: 'skipped',
      detail: 'not measured — a re-gate reads the pushed branch, not the session worktree',
    },
  ];
  const refused = (): MergeOutcome => ({
    ...refuseGate(db, session, sandbox, stages),
    regated: true,
  });
  const started = Date.now();
  const targetSha = resolveCommit(req.repoPath, `refs/heads/${target}`);
  // Pinned first, and once: no rebase will move the branch.
  const sha = pinRegatedHead(req.repoPath, session.branch, regate.head, regate.prUrl);
  if (!isAncestor(req.repoPath, targetSha, sha)) {
    stages.push(
      timedSince(started, {
        stage: 'fresh-base',
        status: 'fail',
        detail:
          `${session.branch} at ${sha} is not based on ${sanitizeReason(target)} at ` +
          `${targetSha}. Rebase it onto ${sanitizeReason(target)}, push it to the PR, then re-gate.`,
      }),
    );
    return refused();
  }
  stages.push(
    timedSince(started, {
      stage: 'fresh-base',
      status: 'pass',
      detail: `already based on ${target}`,
    }),
  );

  const measured = await measureBranch(db, req, session, stages, checkoutDir, targetSha, sha);
  if (!measured || (measured.flaggedDebt.length > 0 && !req.acceptDebt)) return refused();
  const commitSubjects = commitSubjectsBetween(req.repoPath, targetSha, sha);
  const ledgerKept = fileAcceptedDebt(db, req, session.id, measured);

  const report: GateReport = { sessionId: session.id, passed: true, sandbox, stages };
  try {
    rewritePullRequest(req.repoPath, regate.prUrl, {
      ...pullRequest,
      ...pullRequestText(measured.spec, session.id, report, commitSubjects, sha),
    });
    assertPullRequestHead(req.repoPath, regate.prUrl, pullRequest.repo, sha);
  } catch (error) {
    throw withLedgerKept(error, ledgerKept);
  }
  // Logged as a transition onto the state the session keeps, so every reader
  // of the newest gate run finds it.
  appendEvent(db, session.id, 'gate_result', { from: 'merged', to: 'merged', report });
  const files = measured.changedPaths;
  recordMerge(db, req.repoPath, session, { sha, target, files, prUrl: regate.prUrl }, false);
  return {
    status: 'merged',
    report,
    rejectCount: session.reject_count,
    debtCandidates: measured.debtCandidates,
    prUrl: regate.prUrl,
    prWasAdopted: true,
    regated: true,
  };
}

/**
 * A re-gate's pin: the local branch's tip, which must be the head GitHub
 * reports for the PR, so the commit the stages measure is the one the PR shows
 * (decision 86). Read once, under the lock; a symref keeps its own refusal.
 */
function pinRegatedHead(repoPath: string, branch: string, head: string, prUrl: string): string {
  let tip: string | undefined;
  try {
    tip = resolveCommit(repoPath, `refs/heads/${branch}`);
  } catch (error) {
    rethrowIfKilled(error);
    if (error instanceof Error && error.message.includes('symbolic ref')) throw error;
  }
  if (tip !== head) {
    throw new Error(
      `${sanitizeReason(branch)} is ${tip === undefined ? 'missing' : `at ${tip}`} in this ` +
        `repo, but ${prUrl} has its head at ${head}; bring the local branch to the PR's head, ` +
        `then re-run. ${NOT_REGATED}`,
    );
  }
  return tip;
}
