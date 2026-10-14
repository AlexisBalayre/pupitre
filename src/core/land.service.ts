import type { Database } from 'better-sqlite3';
import { failureSummary, sanitizeReason } from '../adapters/capability.utils.js';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { auditProject } from './audit.service.js';
import { assertNoArmedGitDrivers, currentBranch, runGit } from './git-diff.client.js';
import { assertGhAvailable, originRepoSlug, readPullRequestLanding } from './github.client.js';
import { GATE_COMMAND_TIMEOUT_MS } from './merge-gate.constants.js';
import {
  assertTargetName,
  deleteBranchAt,
  fastForward,
  isAncestor,
  type OriginUse,
  pushTarget,
  resolveCommit,
  withMergeLock,
  withScratchGitDir,
} from './merge-gate.service.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { appendEvent, decodeEvent, getSession, listEvents } from './session.repository.js';
import type { LandOutcome } from './types/land.types.js';

/** A sha as the gate pins it, which can then never read as an option. */
const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const LAND_USE: OriginUse = { command: '`pup land`', untouched: 'Nothing was landed.' };

interface LandRequest {
  repoPath: string;
  sessionId: string;
  adapters: Adapter[];
  gateEnv?: string[];
}

/**
 * `pup land <session>` (decision 84): the GitHub half of a `--pr` merge. Every
 * refusal comes before anything moves: the session must be merged with a PR
 * that GitHub says is MERGED, and the target fetched from the recorded origin
 * must hold the sha the gate pinned. Then, under the merge lock, the local
 * target is fast-forwarded with the gate's plumbing, the session's worktree
 * and branch go, the audit re-stamps the baseline the PR mode left alone
 * (decision 26), and a `landed` event drops the PR from the inbox. A re-run
 * after a failure part-way is safe: each step skips what is already done.
 */
export function landSession(db: Database, req: LandRequest): LandOutcome {
  const session = getSession(db, req.sessionId);
  const id = sanitizeReason(req.sessionId);
  if (!session) throw new Error(`No session ${id}. Nothing was landed.`);
  if (session.state !== 'merged') {
    throw new Error(
      `Session ${id} is ${session.state}, not merged; only a session the gate merged with ` +
        '`--pr` can land. Nothing was landed.',
    );
  }
  const merge = newestMerge(db, session.id);
  if (merge === 'landed') throw new Error(`Session ${id} has already landed.`);
  if (merge?.prUrl === undefined) {
    throw new Error(
      `Session ${id} opened no pull request: its merge was a local fast-forward, already on ` +
        'the target. Nothing was landed.',
    );
  }
  const { prUrl, sha, target } = merge;
  if (sha === undefined || !COMMIT_SHA.test(sha) || target === undefined) {
    throw new Error(
      `Session ${id}'s merge event names no pinned sha and target, so there is nothing to ` +
        'check origin against. Nothing was landed.',
    );
  }
  // Store text about to be handed to git and printed: refused the gate's way.
  assertTargetName(req.repoPath, target);
  if (req.adapters.length === 0) {
    throw new Error(
      `No adapter for ${req.repoPath}; the audit after the land would measure nothing. ` +
        'Nothing was landed.',
    );
  }
  // The row is store text too: the worktree and branch it names are what get
  // removed, so they must be the ones the launch minted for this session and
  // no other's, compared as text so no `..` in an id can reach a sibling.
  if (
    !SESSION_ID_PATTERN.test(session.id) ||
    session.worktree_path !== `${req.repoPath}/.worktrees/${session.id}` ||
    session.branch !== `pup/${session.id}`
  ) {
    throw new Error(
      `Session ${id}'s row names a worktree or branch that is not its own; inspect the store. ` +
        'Nothing was landed.',
    );
  }
  const originUrl = pushTarget(db, session, req.repoPath, LAND_USE);
  const repo = originRepoSlug(originUrl);
  // The url is store text: one that is not a pull request of origin's repo
  // could ask GitHub about any merged PR and land on its word. GitHub prints
  // the repo in its canonical case whatever case the recorded origin uses, so
  // the prefix is compared without case, within ASCII so no letter can fold
  // into a match.
  const prefix = `https://${repo}/pull/`;
  const head = prUrl.slice(0, prefix.length);
  if (
    !/^[!-~]+$/.test(head) ||
    !/^[!-~]+$/.test(prefix) ||
    head.toLowerCase() !== prefix.toLowerCase() ||
    !/^\d+$/.test(prUrl.slice(prefix.length))
  ) {
    throw new Error(
      `${sanitizeReason(prUrl)} is not a pull request of ${sanitizeReason(repo)}, the repo ` +
        'origin was recorded as. Nothing was landed.',
    );
  }
  assertGhAvailable('`pup land`');
  const pr = readPullRequestLanding(req.repoPath, prUrl, repo);
  if (pr.state !== 'MERGED') {
    throw new Error(
      `${prUrl} is ${sanitizeReason(pr.state ?? 'in an unreadable state')} on GitHub, not ` +
        'MERGED; merge it there first. Nothing was landed.',
    );
  }
  // A merge commit over a head that moved past the pin lands commits the gate
  // never measured, as a squash does; the PR vouched for the pinned sha only
  // (decision 82). GitHub's own "Update branch" moves the head too, and refuses.
  if (pr.head !== sha) {
    throw new Error(
      `${prUrl} merged with its head at ${pr.head ?? 'an unreadable commit'}, not ${sha}, the ` +
        'commit the gate pinned; it lands commits the gate never measured. Nothing was landed.',
    );
  }
  // Merged into another base, the content never came through the gated one.
  if (pr.base !== target) {
    throw new Error(
      `${prUrl} was merged into ${pr.base ?? 'an unreadable branch'}, not ${target}, the ` +
        'target the gate pinned. Nothing was landed.',
    );
  }
  if (pr.mergeCommit === undefined || !COMMIT_SHA.test(pr.mergeCommit)) {
    throw new Error(`GitHub reports ${prUrl} merged with no merge commit. Nothing was landed.`);
  }
  const mergeCommit = pr.mergeCommit;

  const landed = withMergeLock(req.repoPath, () => {
    const localSha = resolveCommit(req.repoPath, `refs/heads/${target}`);
    const originTip = fetchTarget(req.repoPath, originUrl, target, localSha);
    // A squash or rebase merge lands other commits than the ones the gate
    // measured; the PR vouched for the pinned sha only (decision 82).
    if (!isAncestor(req.repoPath, sha, originTip)) {
      throw new Error(
        `origin's ${target} at ${originTip} does not contain ${sha}, the commit the gate ` +
          'pinned; a squash or rebase merge lands commits the gate never measured. Nothing ' +
          'was landed.',
      );
    }
    // The event will say this commit landed the pinned sha on the target: true
    // by construction only, so both containments are checked.
    if (!isAncestor(req.repoPath, mergeCommit, originTip)) {
      throw new Error(
        `origin's ${target} at ${originTip} does not contain ${mergeCommit}, the commit GitHub ` +
          `says merged ${prUrl}; the PR landed elsewhere. Nothing was landed.`,
      );
    }
    if (!isAncestor(req.repoPath, sha, mergeCommit)) {
      throw new Error(
        `${mergeCommit}, the commit GitHub says merged ${prUrl}, does not contain ${sha}, the ` +
          'commit the gate pinned; the pinned commit reached the target some other way. ' +
          'Nothing was landed.',
      );
    }
    // What the gate checks under its lock before the same checkout (decisions
    // 79, 80), and the audit measures whatever that checkout holds, so it is
    // checked on both paths.
    const checkedOut = currentBranch(req.repoPath);
    if (checkedOut !== target) {
      throw new Error(
        `The main checkout is on ${checkedOut ? sanitizeReason(checkedOut) : 'no branch'}, ` +
          `not ${target}; check out ${target} there and re-run \`pup land\`.`,
      );
    }
    let fastForwarded = false;
    if (!isAncestor(req.repoPath, originTip, localSha)) {
      if (!isAncestor(req.repoPath, localSha, originTip)) {
        throw new Error(
          `Local ${target} at ${localSha} has commits origin's ${target} at ${originTip} ` +
            'lacks, so it cannot fast-forward. Reconcile them from the trusted checkout, then ' +
            're-run `pup land`.',
        );
      }
      assertNoArmedGitDrivers(req.repoPath);
      fastForward(req.repoPath, target, localSha, originTip);
      fastForwarded = true;
    }
    // Last under the lock: every refusal above leaves the repo's refs as they were.
    runGit(req.repoPath, ['update-ref', '--no-deref', `refs/remotes/origin/${target}`, originTip]);
    const targetSha = fastForwarded ? originTip : localSha;
    return { targetSha, fastForwarded, ...tearDown(req.repoPath, session, targetSha) };
  });

  // The conductor may run this, so no human stands between an observed
  // regression and the bar: a regressed measurement is reported and left for
  // `pup audit`, which the operator runs (decision 84).
  const audit = auditProject(db, req.repoPath, req.adapters, req.gateEnv, 'keep');
  appendEvent(db, session.id, 'landed', { sha: mergeCommit, target, prUrl });
  return { prUrl, mergeCommit, target, ...landed, audit };
}

/**
 * The newest merge event, or `'landed'` when a `landed` event came after it:
 * the merge that stands describes the session, like the inbox reads it.
 */
function newestMerge(
  db: Database,
  sessionId: string,
): { prUrl?: string; sha?: string; target?: string } | 'landed' | undefined {
  for (const row of listEvents(db, sessionId).reverse()) {
    if (row.type === 'landed') return 'landed';
    const event = decodeEvent(row);
    if (event.type === 'merge') return event;
  }
  return undefined;
}

/**
 * origin's `target` tip, fetched from the recorded URL by the scratch git dir
 * `pushBranch` pushes from, for its reason (decision 54): the shared config a
 * session can write is never read. Objects land in the repo's own store, and
 * the local tip is lent as a ref so only what it lacks crosses. No ref of the
 * repo moves here; the caller records the tracking ref once the tip passes.
 */
function fetchTarget(
  repoPath: string,
  originUrl: string,
  target: string,
  localSha: string,
): string {
  const piped = { stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  try {
    return withScratchGitDir(repoPath, 'pup-land-', (git) => {
      git(['update-ref', 'refs/heads/local', localSha], piped);
      git(
        [
          'fetch',
          '--quiet',
          '--no-tags',
          '--end-of-options',
          originUrl,
          `+refs/heads/${target}:refs/heads/origin`,
        ],
        {
          ...piped,
          timeout: GATE_COMMAND_TIMEOUT_MS,
        },
      );
      return git(['rev-parse', '--verify', 'refs/heads/origin^{commit}'], piped).trim();
    });
  } catch (error) {
    throw new Error(
      `Fetching ${target} from ${sanitizeReason(originUrl)} failed. Nothing was landed.\n` +
        failureSummary(error),
    );
  }
}

/**
 * What the gate's own teardown may have left (it is best effort): the
 * session's worktree, and its branch while main holds every commit of it, as
 * `pnpm worktree:clean` removes a worktree whose PR merged. A branch with
 * commits main lacks is kept for the operator, as the gate keeps one that moved
 * past the pin.
 */
function tearDown(
  repoPath: string,
  session: { worktree_path: string; branch: string },
  targetSha: string,
): { removedWorktree: boolean; keptBranch?: string } {
  runGit(repoPath, ['worktree', 'prune']);
  // Asked of git, not the filesystem: a directory git no longer registers,
  // left by a teardown that failed part-way, cannot be removed through git and
  // would refuse every re-run.
  const registered = runGit(repoPath, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .includes(`worktree ${session.worktree_path}`);
  let removedWorktree = false;
  if (registered) {
    // A session can lock its own worktree, which one `--force` refuses: the
    // land goes on and the operator removes it by hand, as for a kept branch.
    try {
      runGit(repoPath, ['worktree', 'remove', '--force', session.worktree_path]);
      removedWorktree = true;
    } catch {
      removedWorktree = false;
    }
  }
  const branchRef = `refs/heads/${session.branch}`;
  let branchSha: string;
  try {
    branchSha = resolveCommit(repoPath, branchRef);
  } catch {
    // already gone, or a symref the gate refuses to follow
    return { removedWorktree };
  }
  if (
    isAncestor(repoPath, branchSha, targetSha) &&
    deleteBranchAt(repoPath, branchRef, branchSha)
  ) {
    return { removedWorktree };
  }
  return { removedWorktree, keptBranch: session.branch };
}
