import type { Database } from 'better-sqlite3';
import { failureSummary, sanitizeReason } from '../adapters/capability.utils.js';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { windowLabel } from '../claude/session-runtime.service.js';
import { auditProject } from './audit.service.js';
import {
  assertNoArmedGitDrivers,
  currentBranch,
  gitDiffPaths,
  rethrowIfKilled,
  runGit,
} from './git-diff.client.js';
import { assertGhAvailable, originRepoSlug, readPullRequestLanding } from './github.client.js';
import { COMMIT_SHA, GATE_COMMAND_TIMEOUT_MS } from './merge-gate.constants.js';
import {
  assertMintedRow,
  assertPullRequestOf,
  assertTargetName,
  deleteBranchAt,
  fastForward,
  isAncestor,
  MERGE_LOCK_WAIT_MS,
  newestMerge,
  type OriginUse,
  pushTarget,
  resolveCommit,
  withMergeLock,
  withScratchGitDir,
} from './merge-gate.service.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { mainLandedMessage } from './profile-compiler.service.js';
import { appendEvent, getSession, listSessions } from './session.repository.js';
import { steerSession } from './session-lifecycle.service.js';
import type { LandOutcome } from './types/land.types.js';

const LAND_USE: OriginUse = { command: '`pup land`', untouched: 'Nothing was landed.' };

interface LandRequest {
  repoPath: string;
  sessionId: string;
  adapters: Adapter[];
  gateEnv?: string[];
  /** Wait for a merge lock a live run holds, as `pup land` does, rather than refuse (decision 88). */
  wait?: boolean;
}

/**
 * `pup land <session>` (decision 84): the GitHub half of a `--pr` merge. Every
 * refusal comes before anything moves: the session must be merged with a PR
 * that GitHub says is MERGED, and the target fetched from the recorded origin
 * must hold the sha the gate pinned, or a squash or rebase merge of exactly its
 * content (decision 131). Then, under the merge lock, the local
 * target is fast-forwarded with the gate's plumbing, the session's worktree
 * and branch go, a `landed` event drops the PR from the inbox, and the audit
 * re-stamps the baseline the PR mode left alone (decision 26). A re-run after a
 * failure under the lock is safe: each step skips what is already done. The
 * event is the lock's last write, so a second land that waited on the first
 * refuses under the lock (decision 88). The steer of overlapping sessions runs
 * before the audit, and an audit that fails after both is `pup audit`'s to
 * re-run.
 */
export async function landSession(db: Database, req: LandRequest): Promise<LandOutcome> {
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
  assertMintedRow(req.repoPath, session, 'Nothing was landed.');
  const originUrl = pushTarget(db, session, req.repoPath, LAND_USE);
  const repo = originRepoSlug(originUrl);
  // Store text: a pull request of another repo would land on its word.
  assertPullRequestOf(prUrl, repo, 'Nothing was landed.');
  assertGhAvailable(LAND_USE.command);
  const pr = readPullRequestLanding(req.repoPath, prUrl, repo);
  // The PR took commits past the pin, a CI fix round's: GitHub's merge would
  // land what the gate never measured, so the head is gated first (decision 86).
  if (pr.state === 'OPEN' && pr.head !== undefined && pr.head !== sha) {
    throw new Error(
      `${prUrl} is OPEN on GitHub with its head at ${sanitizeReason(pr.head)}, not ${sha}, ` +
        `the commit the gate pinned. Re-gate it with \`pup merge ${id} --pr\`, merge it there, ` +
        'then re-run `pup land`. Nothing was landed.',
    );
  }
  if (pr.state !== 'MERGED') {
    throw new Error(
      `${prUrl} is ${sanitizeReason(pr.state ?? 'in an unreadable state')} on GitHub, not ` +
        'MERGED; merge it there first. Nothing was landed.',
    );
  }
  // A merge, squash or rebase of a head that moved past the pin lands commits
  // the gate never measured; the PR vouched for the pinned sha only (decision
  // 82). GitHub's own "Update branch" moves the head too, and refuses.
  // Only a re-gate before the merge vouches for a moved head (decision 86).
  if (pr.head !== sha) {
    throw new Error(
      `${prUrl} merged with its head at ${pr.head ?? 'an unreadable commit'}, not ${sha}, the ` +
        'commit the gate pinned; it lands commits the gate never measured. A PR whose head ' +
        `moved is re-gated with \`pup merge ${id} --pr\` before it is merged. Nothing was landed.`,
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

  const landed = await withMergeLock(
    req.repoPath,
    () => {
      // `pup fix` takes the session out of merged under this lock, maybe while
      // GitHub was being read above; landing then would tear down its live round.
      const now = getSession(db, session.id)?.state;
      if (now !== 'merged') {
        throw new Error(
          (now === undefined
            ? `Session ${id} was removed from the store`
            : `Session ${id} became ${now}`) +
            ' while `pup land` waited for the merge lock. Nothing was landed.',
        );
      }
      if (newestMerge(db, session.id) === 'landed') {
        throw new Error(`Session ${id} has already landed.`);
      }
      const localSha = resolveCommit(req.repoPath, `refs/heads/${target}`);
      const originTip = fetchTarget(req.repoPath, originUrl, target, localSha);
      // The event will say this commit landed the pinned content on the target.
      if (!isAncestor(req.repoPath, mergeCommit, originTip)) {
        throw new Error(
          `origin's ${target} at ${originTip} does not contain ${mergeCommit}, the commit GitHub ` +
            `says merged ${prUrl}; the PR landed elsewhere. Nothing was landed.`,
        );
      }
      // A merge, squash or rebase is taken when what it landed is exactly the
      // gate's content: ancestry alone would take a merge commit carrying
      // changes of its own (decision 131).
      const landedOn = mergedOnto(req.repoPath, sha, mergeCommit);
      if (landedOn === undefined) {
        throw new Error(
          `${mergeCommit}, the commit GitHub says merged ${prUrl}, does not have the tree git ` +
            `gives merging ${sha}, the commit the gate pinned, onto the commit the merge went ` +
            'onto; the merge landed content the gate never measured. Nothing was landed.',
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
      runGit(req.repoPath, [
        'update-ref',
        '--no-deref',
        `refs/remotes/origin/${target}`,
        originTip,
      ]);
      const targetSha = fastForwarded ? originTip : localSha;
      const tornDown = tearDown(req.repoPath, session, targetSha, sha);
      appendEvent(db, session.id, 'landed', { sha: mergeCommit, target, prUrl });
      return { targetSha, fastForwarded, landedOn, ...tornDown };
    },
    req.wait ? MERGE_LOCK_WAIT_MS : 0,
  );
  const { landedOn, ...outcome } = landed;

  // Before the audit, which can throw: once the event is written a re-run
  // refuses, and nothing else steers (decision 88).
  steerOverlappingSessions(
    db,
    req.repoPath,
    session.id,
    landedOn,
    mergeCommit,
    target,
    outcome.targetSha,
  );
  // The conductor may run this, so no human stands between an observed
  // regression and the bar: a regressed measurement is reported and left for
  // `pup audit`, which the operator runs (decision 84).
  const audit = await auditProject(db, req.repoPath, req.adapters, req.gateEnv, 'keep');
  return { prUrl, mergeCommit, target, ...outcome, audit };
}

/**
 * Steer each running session whose branch changed a file the landed PR changed,
 * once, to take the target in now (decision 99): a conflict met one land at a
 * time is one change wide, and the gate's rebase stays the final check. The
 * PR's files are its merge commit against the target it landed on: its first
 * parent, or the commit a squash or rebase merge went onto (decision 131); a
 * session's are its branch's own changes since it forked from
 * the target. After the `landed` event and best effort: the land is done
 * whatever a steer does. A session whose steer fails for any reason, a refused
 * paste, a stop, tmux or the store, is skipped and the rest are still steered,
 * and so is one whose branch git cannot read. A PR whose files git cannot list
 * steers no one, rather than report a land that happened as failed. Only an
 * interrupt stops it. A skipped session is not reported yet (decision 99). A
 * session in any other state is not woken for it: the gate's fresh-base stage
 * takes the target in for it when it is next gated (decision 104). The
 * decisions log counts here as any file: two entries appended at its end
 * always conflict, and one this notice resolves now costs the gate no
 * rejection.
 */
function steerOverlappingSessions(
  db: Database,
  repoPath: string,
  landedId: string,
  landedOn: string,
  mergeCommit: string,
  target: string,
  targetSha: string,
): void {
  let landedFiles: Set<string>;
  try {
    landedFiles = new Set(gitDiffPaths(repoPath, landedOn, mergeCommit));
  } catch (error) {
    rethrowIfKilled(error);
    return;
  }
  const name = windowLabel({ sessionId: landedId });
  for (const peer of listSessions(db, ['running'])) {
    // Store text about to name a ref: only the branch a launch mints is read.
    if (!SESSION_ID_PATTERN.test(peer.id) || peer.branch !== `pup/${peer.id}`) continue;
    let files: string[];
    try {
      files = gitDiffPaths(repoPath, targetSha, `refs/heads/${peer.branch}`).filter((path) =>
        landedFiles.has(path),
      );
    } catch (error) {
      rethrowIfKilled(error);
      continue;
    }
    if (files.length === 0) continue;
    try {
      // A branch the gate already pushed as a PR is GitHub's too: it takes the
      // target as a merge commit, since a rebase would replace history there.
      const merge = newestMerge(db, peer.id);
      const openPullRequest = typeof merge === 'object' && merge.prUrl !== undefined;
      steerSession(db, peer.id, mainLandedMessage({ name, target, files, openPullRequest }), {
        kind: 'main-landed',
        by: landedId,
      });
    } catch (error) {
      rethrowIfKilled(error);
    }
  }
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
 * The commit a merge, squash or rebase of `sha` went onto, when what it landed
 * is exactly the tree git gives merging the pinned content there (decision
 * 130): anything the merge added, dropped or altered past what the gate
 * measured makes them differ. A merge commit or a squash went onto
 * `mergeCommit`'s first parent, and its tree is checked against merging `sha`
 * there. A rebase merge replayed the pinned branch's own commits, the ones
 * `sha` has that `mergeCommit` lacks, onto the first parent that many commits
 * down, and each replayed commit's tree is checked against merging its pinned
 * commit there: checking the last alone would take commits of someone else's
 * that the last one undoes. That base is tried first, since the last replayed
 * commit's parent matches as a squash, and the steer would then miss every file
 * but the last commit's. A conflicted merge is no match. Run from the scratch
 * git dir, for the fetch's reason (decision 54): a merge reads drivers from
 * config. The repo's commit graph, a cache in the object store a session can
 * write, is not read.
 */
function mergedOnto(repoPath: string, sha: string, mergeCommit: string): string | undefined {
  const piped = { stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  try {
    return withScratchGitDir(repoPath, 'pup-land-', (scratchGit) => {
      const git = (args: string[]) =>
        scratchGit(['-c', 'core.commitGraph=false', ...args], {
          ...piped,
          timeout: GATE_COMMAND_TIMEOUT_MS,
        }).trim();
      const own = git(['rev-list', '--reverse', sha, `^${mergeCommit}`]).split('\n');
      // One pinned commit is a squash's case. Never depth 0: `mergeCommit`
      // itself, whose merge with an ancestor is its own tree.
      const shapes = own.length > 1 ? [own, [sha]] : [[sha]];
      for (const heads of shapes) {
        try {
          const base = git([
            'rev-parse',
            '--verify',
            '--quiet',
            `${mergeCommit}~${heads.length}^{commit}`,
          ]);
          const replays = heads.every((head, at) => {
            const replayed = `${mergeCommit}~${heads.length - 1 - at}^{tree}`;
            return (
              git(['merge-tree', '--write-tree', '--no-messages', base, head]) ===
              git(['rev-parse', '--verify', replayed])
            );
          });
          if (replays) return base;
        } catch (error) {
          // 1 is no commit that far down, or a conflict. Any other status (a
          // signal, no `--write-tree` before git 2.38, a missing object) is git
          // failing outright, refused as such below, as the gate does (decision 105).
          if ((error as { status?: unknown }).status !== 1) throw error;
        }
      }
      return undefined;
    });
  } catch (error) {
    rethrowIfKilled(error);
    throw new Error(
      `Reading what ${mergeCommit} landed failed. Nothing was landed.\n${failureSummary(error)}`,
    );
  }
}

/**
 * What the gate's own teardown may have left (it is best effort): the
 * session's worktree, and its branch while main holds every commit of it, or
 * of the pinned `sha` whose content a squash or rebase merge landed. A branch
 * with commits past both is kept for the operator, as the gate keeps one that
 * moved past the pin.
 */
function tearDown(
  repoPath: string,
  session: { worktree_path: string; branch: string },
  targetSha: string,
  sha: string,
): { removedWorktree: boolean; keptBranch?: string; keptWorktree?: string } {
  runGit(repoPath, ['worktree', 'prune']);
  // Asked of git, not the filesystem: a directory git no longer registers,
  // left by a teardown that failed part-way, cannot be removed through git and
  // would refuse every re-run.
  const registered = runGit(repoPath, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .includes(`worktree ${session.worktree_path}`);
  let removedWorktree = false;
  if (registered) {
    // A session can lock its own worktree, which one `--force` refuses. The
    // land goes on, but the branch stays with it: `update-ref -d` would delete
    // the branch a surviving worktree has checked out.
    try {
      runGit(repoPath, ['worktree', 'remove', '--force', session.worktree_path]);
      removedWorktree = true;
    } catch (error) {
      rethrowIfKilled(error);
      return { removedWorktree, keptWorktree: session.worktree_path };
    }
  }
  const branchRef = `refs/heads/${session.branch}`;
  let branchSha: string;
  try {
    branchSha = resolveCommit(repoPath, branchRef);
  } catch (error) {
    rethrowIfKilled(error);
    // already gone, or a symref the gate refuses to follow
    return { removedWorktree };
  }
  if (
    (isAncestor(repoPath, branchSha, targetSha) || isAncestor(repoPath, branchSha, sha)) &&
    deleteBranchAt(repoPath, branchRef, branchSha)
  ) {
    return { removedWorktree };
  }
  return { removedWorktree, keptBranch: session.branch };
}
