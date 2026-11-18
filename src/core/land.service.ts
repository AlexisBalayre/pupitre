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
  worktreeGitEnv,
} from './git-diff.client.js';
import { assertGhAvailable, originRepoSlug, readPullRequestLanding } from './github.client.js';
import { remeasureMerge } from './land-remeasure.service.js';
import { COMMIT_SHA, GATE_COMMAND_TIMEOUT_MS } from './merge-gate.constants.js';
import {
  assertMergeLockHeld,
  assertMintedRow,
  assertPullRequestOf,
  assertTargetName,
  fastForward,
  inProgressGitState,
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
import { NO_PROGRESS, type StageProgress } from './progress.utils.js';
import { appendEvent, getSession, isPrClosedOnRecord, listSessions } from './session.repository.js';
import { steerSession } from './session-lifecycle.service.js';
import {
  assertStillMerged,
  deleteBranchIfHeld,
  isRegisteredWorktree,
  pinnedPullRequest,
} from './session-teardown.service.js';
import type { Landable, LandOutcome, LandRequest, PinnedPullRequest } from './types/land.types.js';

export const LAND_UNTOUCHED = 'Nothing was landed.';
const LAND_USE: OriginUse = { command: '`pup land`', untouched: LAND_UNTOUCHED };

/**
 * `pup land <session>` (decision 84): the GitHub half of a `--pr` merge. Every
 * refusal comes before anything moves: the session must be merged with a PR
 * that GitHub says is MERGED, and the target fetched from the recorded origin
 * must hold the sha the gate pinned, or a squash or rebase merge of exactly its
 * content (decision 131). A PR merged at a head past the pin lands only on the
 * operator's `acceptHead`, a descendant of the pin read from origin, and the
 * check is then against that head (decision 164). Then, under the merge lock, the local
 * target is fast-forwarded with the gate's plumbing, the session's worktree
 * and branch go, a `landed` event drops the PR from the inbox, and the audit
 * re-stamps the baseline the PR mode left alone (decision 26). A re-run after a
 * failure under the lock is safe: each step skips what is already done. The
 * event is written under the lock, so a second land that waited on the first
 * refuses under it (decision 88). The steer of overlapping sessions and then
 * the audit run under the lock too, and an audit that fails after both is
 * `pup audit`'s to re-run. A lock lost under the land throws
 * `MergeLockLostError` carrying the outcome, steer and all.
 */
export async function landSession(
  db: Database,
  req: LandRequest,
  progress: StageProgress = NO_PROGRESS,
): Promise<LandOutcome> {
  progress.stage('read PR');
  const landable = checkLanding(db, req);
  return withMergeLock(
    req.repoPath,
    async (): Promise<LandOutcome> => {
      const outcome = await landUnderLock(db, req, landable, progress);
      if (req.audit === false) return outcome;
      // Under the lock too: the steer wakes the sessions whose gates come next,
      // and a gate reads the baseline and ratchets it under this lock, so none
      // measures against the baseline before the land or writes over this
      // refresh (decision 88). The conductor may run this, so no human stands
      // between an observed regression and the bar: a regressed measurement is
      // reported and left for `pup audit`, which the operator runs (decision 84).
      progress.stage('audit');
      const audit = await auditProject(db, req.repoPath, req.adapters, req.gateEnv, 'keep');
      return { ...outcome, audit };
    },
    req.wait ? MERGE_LOCK_WAIT_MS : 0,
    progress,
  );
}

export function assertAuditable(req: { repoPath: string; adapters: Adapter[] }): void {
  if (req.adapters.length === 0) {
    throw new Error(
      `No adapter for ${req.repoPath}; the audit after the land would measure nothing. ` +
        'Nothing was landed.',
    );
  }
}

/**
 * Every refusal `pup land` makes before the merge lock: the session and its
 * pinned PR, then what GitHub says of it (decisions 84, 86, 146, 164, 185).
 */
export function checkLanding(db: Database, req: LandRequest): Landable {
  const { session, id, prUrl, sha, target, originUrl, repo } = landablePullRequest(db, req);
  if (req.audit !== false) assertAuditable(req);
  if (req.remeasure && req.adapters.length === 0) {
    throw new Error(
      `No adapter for ${req.repoPath}; the remeasure would measure nothing. Nothing was landed.`,
    );
  }
  if (req.remeasure && req.acceptHead !== undefined) {
    throw new Error(
      '--remeasure and --accept-head each vouch for a moved head; pass one. Nothing was landed.',
    );
  }
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
  // Recorded on the operator's word alone: any session can close a peer's PR
  // with the shared gh login, and the record frees its ADR numbers (decision 146).
  if (pr.state === 'CLOSED') {
    throw new Error(
      `${prUrl} is CLOSED on GitHub, not MERGED. Check on GitHub who closed it: any session ` +
        'can close a PR with the shared gh login. If the work is abandoned, run ' +
        `\`pup land ${id} --abandon-closed\` to free the ADR numbers it holds; if another PR ` +
        `re-landed it, \`pup retire ${id} --superseded-by <pr>\`. Nothing was landed.`,
    );
  }
  // A reopen leaves the head at the pin, but the record freed the PR's ADR
  // numbers to other gates: only a re-gate checks them again (decision 146).
  if (pr.state === 'OPEN' && isPrClosedOnRecord(db, session.id)) {
    throw new Error(
      `${prUrl} was recorded closed unmerged and is OPEN on GitHub again; its ADR numbers were ` +
        `free to other gates since. Re-gate it with \`pup merge ${id} --pr\` before merging it ` +
        'there, then re-run `pup land`. Nothing was landed.',
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
  // 82). GitHub's own "Update branch" moves the head too. A re-gate before the
  // merge vouches for a moved head (decision 86); after the merge only the
  // operator's `--accept-head` naming that very head does, and only for
  // commits past the pin, checked under the lock (decision 164), or the
  // gate's stages run again on the merge commit with `--remeasure` (decision 185).
  if (pr.head === undefined || !COMMIT_SHA.test(pr.head)) {
    throw new Error(`GitHub reports ${prUrl} merged with an unreadable head. Nothing was landed.`);
  }
  const head = pr.head;
  if (req.acceptHead !== undefined && req.acceptHead !== head) {
    throw new Error(
      `--accept-head names ${sanitizeReason(req.acceptHead)}, but ${prUrl} merged with its ` +
        `head at ${head}; the operator's word holds for that commit only. Nothing was landed.`,
    );
  }
  if (req.remeasure && head === sha) {
    throw new Error(
      `${prUrl} merged with its head at ${sha}, the commit the gate pinned: there is nothing ` +
        `to remeasure. Run \`pup land ${id}\`. Nothing was landed.`,
    );
  }
  const pullRef = `refs/pull/${prUrl.slice(prUrl.lastIndexOf('/') + 1)}/head`;
  if (head !== sha && req.acceptHead === undefined && !req.remeasure) {
    // The operator's read is all that vouches for these commits, so it is
    // pointed at GitHub, not at git in the repo, whose replace refs, attributes,
    // pager, fsmonitor and remotes a session can write (decision 164).
    const compare = `${prUrl.slice(0, prUrl.lastIndexOf('/pull/'))}/compare/${sha}...${head}`;
    throw new Error(
      `${prUrl} merged with its head at ${head}, not ${sha}, the commit the gate pinned; it ` +
        'lands commits the gate never measured. A PR whose head moved is re-gated with ' +
        `\`pup merge ${id} --pr\` before it is merged. Once merged, read the commits past the ` +
        `pin on GitHub (${compare}) and, if you vouch for them, run ` +
        `\`pup land ${id} --accept-head ${head}\`. Nothing was landed.`,
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
  return {
    session,
    id,
    prUrl,
    sha,
    target,
    originUrl,
    head,
    mergeCommit: pr.mergeCommit,
    pullRef,
  };
}

/**
 * One land under the merge lock its caller holds: the checks made under it,
 * the fast-forward, the teardown, the `landed` event and the steer. The audit
 * is the caller's, once per hold of the lock.
 */
export async function landUnderLock(
  db: Database,
  req: LandRequest,
  landable: Landable,
  progress: StageProgress,
): Promise<LandOutcome> {
  const { session, id, prUrl, sha, target, originUrl, head, mergeCommit, pullRef } = landable;
  // `pup fix` takes the session out of merged under this lock, maybe while
  // GitHub was being read above; landing then would tear down its live round.
  assertStillMerged(db, session.id, id, LAND_USE);
  if (newestMerge(db, session.id) === 'landed') {
    throw new Error(`Session ${id} has already landed.`);
  }
  // Before anything moves and before the teardown's git in the worktree: a
  // session left in, or planting, a rebase or merge is not torn down under
  // it (decision 204). A worktree already gone has no admin dir to hold any.
  const inProgress = inProgressGitState(
    worktreeGitEnv(req.repoPath, session.worktree_path).GIT_DIR,
  );
  if (inProgress) {
    throw new Error(
      `${sanitizeReason(inProgress)} is in session ${id}'s worktree git dir: a rebase, merge, ` +
        'cherry-pick or revert is in progress there, or the session planted its state. Inspect ' +
        'it, finish or abort it in that worktree or delete it, then re-run `pup land`. ' +
        LAND_UNTOUCHED,
    );
  }
  progress.stage('fetch');
  const localSha = resolveCommit(req.repoPath, `refs/heads/${target}`);
  const fetched = fetchTarget(
    req.repoPath,
    originUrl,
    target,
    localSha,
    head === sha ? undefined : pullRef,
  );
  const originTip = fetched.tip;
  // The event will say this commit landed the pinned content on the target.
  if (!isAncestor(req.repoPath, mergeCommit, originTip)) {
    throw new Error(
      `origin's ${target} at ${originTip} does not contain ${mergeCommit}, the commit GitHub ` +
        `says merged ${prUrl}; the PR landed elsewhere. Nothing was landed.`,
    );
  }
  // The moved head is read from origin, not the local branch a session can
  // move. An accepted one must carry the pin whole: a head that rewrote the
  // gated commits is no longer "the gate's content plus what the operator
  // read". A remeasured one need not, the stages measuring all it landed.
  if (head !== sha) {
    if (fetched.pullHead !== head) {
      throw new Error(
        `origin's ${pullRef} is at ${fetched.pullHead}, not ${head}, the head GitHub says ` +
          `${prUrl} merged at. Nothing was landed.`,
      );
    }
    if (!req.remeasure && !descendsFrom(req.repoPath, head, sha)) {
      throw new Error(
        `${head}, the head ${prUrl} merged at, does not descend from ${sha}, the commit the ` +
          'gate pinned: its commits rewrote what the gate measured, so --accept-head cannot ' +
          'vouch for them. Nothing was landed.',
      );
    }
  }
  // A merge, squash or rebase is taken when what it landed is exactly the
  // gate's content, or the moved head's: ancestry alone would take a merge
  // commit carrying changes of its own (decision 131).
  const landedOn = mergedOnto(req.repoPath, head, mergeCommit);
  if (landedOn === undefined) {
    const merged =
      head === sha
        ? `${sha}, the commit the gate pinned`
        : req.remeasure
          ? `${head}, the head it merged at`
          : `${head}, the head you accepted`;
    throw new Error(
      `${mergeCommit}, the commit GitHub says merged ${prUrl}, does not have the tree git ` +
        `gives merging ${merged}, onto the commit the merge went onto; the merge landed ` +
        'content the gate never measured. Nothing was landed.',
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
  // Before anything moves, so a refused remeasure leaves the repo as it was.
  const remeasured = req.remeasure
    ? await remeasureMerge(
        db,
        req,
        session,
        {
          sha,
          head,
          landedOn,
          mergeCommit,
          target,
          prUrl,
          id,
          localSha,
          originTip,
          originTipNow: () => fetchTarget(req.repoPath, originUrl, target, localSha, undefined).tip,
        },
        progress,
      )
    : undefined;
  progress.stage('fast-forward');
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
  assertMergeLockHeld(req.repoPath, `the update of origin's ${target} tracking ref`);
  runGit(req.repoPath, ['update-ref', '--no-deref', `refs/remotes/origin/${target}`, originTip]);
  const targetSha = fastForwarded ? originTip : localSha;
  progress.stage('tear down');
  const tornDown = tearDown(req.repoPath, session, targetSha, head);
  const landed = { sha: mergeCommit, target, prUrl };
  appendEvent(
    db,
    session.id,
    'landed',
    head === sha
      ? landed
      : remeasured === undefined
        ? { ...landed, acceptedHead: head, pinned: sha }
        : {
            ...landed,
            remeasuredHead: head,
            pinned: sha,
            remeasure: remeasured,
            ...(req.approvedBy === undefined ? {} : { approvedBy: req.approvedBy }),
          },
  );
  // Right after the event, still under the lock, and before the audit,
  // which can throw: once the event is written a re-run refuses, and
  // nothing else steers (decision 88).
  progress.stage('steer');
  const unsteered = steerOverlappingSessions(
    db,
    req.repoPath,
    session.id,
    landedOn,
    mergeCommit,
    target,
    targetSha,
  );
  // Said now, before the audit: a re-run refuses the landed session, and an
  // audit that throws, or a kill or a timeout during it, would leave the
  // outcome unreturned and these sessions named nowhere (decision 99).
  const branch = sanitizeReason(target);
  for (const { sessionId, reason } of unsteered) {
    progress.note(
      `Could not tell ${sanitizeReason(sessionId)} that ${branch} moved: ` +
        `${sanitizeReason(reason)}. Steer it to take ${branch} in.`,
    );
  }
  const outcome: LandOutcome = {
    prUrl,
    mergeCommit,
    target,
    targetSha,
    fastForwarded,
    ...tornDown,
    ...(unsteered.length > 0 ? { unsteered } : {}),
    ...(remeasured === undefined ? {} : { remeasure: remeasured }),
  };
  return outcome;
}

/**
 * The checks `pup land` and `pup land --abandon-closed` share before asking
 * GitHub: a merged session whose newest merge opened a PR of the repo origin
 * was recorded as, pinned onto a target the gate's way.
 */
function landablePullRequest(
  db: Database,
  req: { repoPath: string; sessionId: string },
): PinnedPullRequest {
  const session = getSession(db, req.sessionId);
  const id = sanitizeReason(req.sessionId);
  if (!session) throw new Error(`No session ${id}. Nothing was landed.`);
  if (session.state !== 'merged') {
    throw new Error(
      `Session ${id} is ${session.state}, not merged; only a session the gate merged with ` +
        '`--pr` can land. Nothing was landed.',
    );
  }
  const { prUrl, sha, target } = pinnedPullRequest(db, session.id, id, LAND_USE.untouched);
  // Store text about to be handed to git and printed: refused the gate's way.
  assertTargetName(req.repoPath, target);
  assertMintedRow(req.repoPath, session, 'Nothing was landed.');
  const originUrl = pushTarget(db, session, req.repoPath, LAND_USE);
  const repo = originRepoSlug(originUrl);
  // Store text: a pull request of another repo would land on its word.
  assertPullRequestOf(prUrl, repo, 'Nothing was landed.');
  return { session, id, prUrl, sha, target, originUrl, repo };
}

/**
 * `pup land <session> --abandon-closed` (decision 146's 2026-11-13
 * amendment): the operator's word that the session's PR, closed unmerged on
 * GitHub, is abandoned. The `pr_closed` event it records ends the PR's claim
 * on the ADR numbers its pinned commit adds. Operator-only at the CLI, since
 * any session can close a peer's PR with the shared gh login. Under the merge
 * lock, which a re-gate takes too, GitHub is asked whether the PR is CLOSED,
 * and the session must still be merged with its newest merge naming that PR
 * and sha: otherwise the record would free the numbers of a PR reopened or
 * opened since. `recorded` is false when the close was already on record.
 */
export async function abandonClosedSession(
  db: Database,
  req: { repoPath: string; sessionId: string; wait?: boolean },
): Promise<{ prUrl: string; recorded: boolean }> {
  const { session, id, prUrl, sha, repo } = landablePullRequest(db, req);
  assertGhAvailable(LAND_USE.command);
  return withMergeLock(
    req.repoPath,
    () => {
      assertStillMerged(db, session.id, id, LAND_USE);
      const merge = newestMerge(db, session.id);
      if (merge === 'landed' || merge?.prUrl !== prUrl || merge.sha !== sha) {
        throw new Error(
          `Session ${id} recorded another merge or a land while \`pup land\` waited for the ` +
            `merge lock, so ${prUrl} is no longer the PR it stands for. Nothing was recorded.`,
        );
      }
      const state = readPullRequestLanding(req.repoPath, prUrl, repo).state;
      if (state !== 'CLOSED') {
        throw new Error(
          `${prUrl} is ${sanitizeReason(state ?? 'in an unreadable state')} on GitHub, not ` +
            'CLOSED; only a PR closed unmerged can be abandoned. Nothing was recorded.',
        );
      }
      if (isPrClosedOnRecord(db, session.id)) return { prUrl, recorded: false };
      appendEvent(db, session.id, 'pr_closed', { prUrl, sha });
      return { prUrl, recorded: true };
    },
    req.wait ? MERGE_LOCK_WAIT_MS : 0,
  );
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
 * and so is one whose branch git cannot read. Both are returned with the
 * reason, for `pup land` to print, and recorded nowhere: a `steer` event would
 * read as the answer to the session's open question (decision 99). A PR whose
 * files git cannot list steers no one, rather than report a land that happened
 * as failed. Only an interrupt stops it. A session in any other state is not woken for it: the gate's fresh-base stage
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
): NonNullable<LandOutcome['unsteered']> {
  let landedFiles: Set<string>;
  try {
    landedFiles = new Set(gitDiffPaths(repoPath, landedOn, mergeCommit));
  } catch (error) {
    rethrowIfKilled(error);
    return [];
  }
  const unsteered: NonNullable<LandOutcome['unsteered']> = [];
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
      unsteered.push({
        sessionId: peer.id,
        reason: `git could not read its branch: ${failureSummary(error)}`,
      });
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
      unsteered.push({ sessionId: peer.id, reason: failureSummary(error) });
    }
  }
  return unsteered;
}

/**
 * origin's `target` tip, fetched from the recorded URL by the scratch git dir
 * `pushBranch` pushes from, for its reason (decision 54): the shared config a
 * session can write is never read. Objects land in the repo's own store, and
 * the local tip is lent as a ref so only what it lacks crosses. No ref of the
 * repo moves here; the caller records the tracking ref once the tip passes.
 * With `pullRef`, the PR's head ref GitHub keeps, fetched in the same call,
 * so an accepted head is read from origin (decision 164).
 */
export function fetchTarget(
  repoPath: string,
  originUrl: string,
  target: string,
  localSha: string,
  pullRef: string | undefined,
): { tip: string; pullHead?: string } {
  const piped = { stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  const fetched = pullRef === undefined ? target : `${target} and ${pullRef}`;
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
          ...(pullRef === undefined ? [] : [`+${pullRef}:refs/heads/pull`]),
        ],
        {
          ...piped,
          timeout: GATE_COMMAND_TIMEOUT_MS,
        },
      );
      const tipOf = (ref: string) =>
        git(['rev-parse', '--verify', `${ref}^{commit}`], piped).trim();
      const tip = tipOf('refs/heads/origin');
      return pullRef === undefined ? { tip } : { tip, pullHead: tipOf('refs/heads/pull') };
    });
  } catch (error) {
    rethrowIfKilled(error);
    throw new Error(
      `Fetching ${fetched} from ${sanitizeReason(originUrl)} failed. Nothing was landed.\n` +
        failureSummary(error),
    );
  }
}

/**
 * Whether `head` descends from `pin`, asked from the scratch git dir with the
 * repo's commit graph off, for `mergedOnto`'s reason: that cache is in the
 * object store a session can write, and a forged one could answer yes
 * (decision 164). Exit 1 is no; any other failure is git failing outright.
 */
function descendsFrom(repoPath: string, head: string, pin: string): boolean {
  const piped = { stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  try {
    return withScratchGitDir(repoPath, 'pup-land-', (git) => {
      try {
        git(['-c', 'core.commitGraph=false', 'merge-base', '--is-ancestor', pin, head], {
          ...piped,
          timeout: GATE_COMMAND_TIMEOUT_MS,
        });
        return true;
      } catch (error) {
        if ((error as { status?: unknown }).status !== 1) throw error;
        return false;
      }
    });
  } catch (error) {
    rethrowIfKilled(error);
    throw new Error(
      `Reading whether ${head} descends from ${pin} failed. Nothing was landed.\n` +
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
 * of `head`, the pinned sha or the accepted head (decision 164), whose content
 * a squash or rebase merge landed. A branch
 * with commits past both is kept for the operator, as the gate keeps one that
 * moved past the pin.
 */
function tearDown(
  repoPath: string,
  session: { worktree_path: string; branch: string },
  targetSha: string,
  head: string,
): { removedWorktree: boolean; keptBranch?: string; keptWorktree?: string } {
  let removedWorktree = false;
  if (isRegisteredWorktree(repoPath, session.worktree_path)) {
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
  const keptBranch = deleteBranchIfHeld(repoPath, session.branch, [targetSha, head]);
  return keptBranch === undefined ? { removedWorktree } : { removedWorktree, keptBranch };
}
