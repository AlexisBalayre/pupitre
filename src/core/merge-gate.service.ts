import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import { failureSummary, localContext, sanitizeReason } from '../adapters/capability.utils.js';
import type { CapabilityContext } from '../adapters/types/adapter.types.js';
import {
  killSession as killTmux,
  SteerNotDeliveredError,
} from '../claude/session-runtime.service.js';
import { patchCoverage } from './coverage.utils.js';
import { judgeDebt, measureDebt, quotePath } from './debt.service.js';
import { draftDecisionRecord } from './decision-record.service.js';
import {
  armedGitDrivers,
  assertNoArmedGitDrivers,
  currentBranch,
  gitDiffAddedLines,
  gitDiffBinaryRecount,
  gitDiffNumstat,
  gitDiffPaths,
  rethrowIfKilled,
  runGit,
} from './git-diff.client.js';
import {
  assertGhAvailable,
  assertPullRequestHead,
  createPullRequest,
  findOpenPullRequest,
  originRepoSlug,
  readPullRequestLanding,
  rewritePullRequest,
} from './github.client.js';
import { readOriginUrl } from './init.service.js';
import {
  hasOpenLedgerEntry,
  insertLedgerEntry,
  type LedgerEntryRow,
  listLedgerEntries,
} from './ledger.repository.js';
import {
  DEBT_DETAIL_SAMPLES,
  DIFF_SIZE_FLAG_LINES,
  GATE_COMMAND_TIMEOUT_MS,
  GATE_ENVIRONMENT_DIR,
  GATE_OUTPUT_TAIL_CHARS,
  LOCKFILE_NAMES,
  MAX_REJECTS_BEFORE_BLOCKED,
  MERGE_LOCK_DIRNAME,
  PR_TITLE_MAX_CHARS,
} from './merge-gate.constants.js';
import { MergeLockHeldError, SessionNotReviewableError } from './merge-gate.errors.js';
import { runGateChild, sandboxLabel } from './sandbox.utils.js';
import { auditScope } from './scope-audit.utils.js';
import {
  appendEvent,
  decodeEvent,
  getProject,
  getSession,
  getTask,
  incrementRejectCount,
  listEvents,
  type ProjectRow,
  readTaskSpec,
  type SessionRow,
  saveProjectBaseline,
  transitionSession,
} from './session.repository.js';
import { steerSession } from './session-lifecycle.service.js';
import type { PullRequestRef } from './types/github.types.js';
import type { DebtBaseline, ProjectBaseline } from './types/init.types.js';
import type {
  GateReport,
  GateStageResult,
  MergeOutcome,
  MergeRequest,
} from './types/merge-gate.types.js';
import type { TaskSpec } from './types/profile.types.js';

export function isAncestor(repoPath: string, maybeAncestor: string, ref: string): boolean {
  try {
    runGit(repoPath, ['merge-base', '--is-ancestor', maybeAncestor, ref]);
    return true;
  } catch (error) {
    rethrowIfKilled(error);
    return false;
  }
}

/** A CSI escape — where a test runner's colour and cursor moves are carried. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CSI_ESCAPE = /\u001b\[[0-9;:?]*[ -/]*[@-~]/g;
/** Everything else a terminal writes. Newline stays: a detail may list a line each. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/**
 * A stage detail on its way into the report. A gate command runs in a pty-less
 * child but writes what it would to a terminal — vitest's failures arrived as
 * 2000 chars of raw SGR — and the report is printed to the operator's terminal,
 * fenced into the PR body, and pasted back into the session's input box as the
 * re-steer. Escapes there repaint the report the operator decides from
 * (decision 29's rationale, applied to command output), and worse: a pasted
 * escape never shows in the input box as the characters that were sent, so
 * `pasteLanded` cannot match the paste and the whole re-steer is refused
 * (decision 45). A sibling of `sanitizeReason` rather than that function
 * itself — a detail keeps its newlines, because the scope audit puts a path on
 * each, and its full `GATE_OUTPUT_TAIL_CHARS` of output. An escape of any
 * other form loses its ESC to the control sweep and lands as inert text.
 * Applied to the captured output rather than over the finished report, so the
 * stored stages, the operator's own print and the PR body are plain too and
 * not just the steer. It is the only route an escape takes into a stage that
 * steers: git C-quotes a control byte in a pathname whatever `core.quotePath`
 * says, `quotePath` already sanitizes the scope audit's, and an adapter's own
 * text reaches flagged stages only, which are refused and never steered.
 */
function plainDetail(detail: string): string {
  return detail.replace(CSI_ESCAPE, '').replace(CONTROL_CHARS, ' ').trimEnd();
}

/** A failed command's whole output, plain; its message when it printed nothing. */
function commandFailureOutput(error: unknown): string {
  const failure = error as { stdout?: string; stderr?: string; message?: string };
  const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
  return plainDetail(output || (failure.message ?? 'command failed'));
}

function commandFailureDetail(error: unknown): string {
  // Plain before the tail is taken, never after: the cut would otherwise land
  // mid-escape and leave its parameters as text, and a coloured runner spends
  // much of the budget on bytes nobody reads.
  return commandFailureOutput(error).slice(-GATE_OUTPUT_TAIL_CHARS);
}

/**
 * The line each common runner opens a failed test with: vitest's `FAIL` and
 * `×`, jest's `✕` and `●`, pytest's `FAILED`, go's `--- FAIL:`. A line, not a
 * parse — the names are for the operator to read, never for anything to act on.
 */
const FAILED_TEST_LINE = /^\s*(?:FAIL|FAILED|×|✕|✗|●|--- FAIL:)\s+(.+?)\s*$/;
/** Enough names to tell one flake from a broken suite, few enough to read. */
const FAILED_TEST_NAMES_MAX = 10;

/** The failed tests a failed test stage's output names, deduplicated. */
function failingTestNames(error: unknown): string {
  const names = [
    ...new Set(
      commandFailureOutput(error)
        .split('\n')
        .flatMap((line) => FAILED_TEST_LINE.exec(line)?.[1] ?? []),
    ),
  ];
  if (names.length === 0) return 'none named in its output';
  const more = names.length - FAILED_TEST_NAMES_MAX;
  return names.slice(0, FAILED_TEST_NAMES_MAX).join('; ') + (more > 0 ? ` (+${more} more)` : '');
}

/**
 * Adds + deletes across the branch diff, excluding lockfiles and binary files.
 * A null numstat is a measurement, not a skip: a file git reports as binary
 * whose content is text is recounted from its patch and named in `forged`,
 * because git was told to call it binary by something no diff shows
 * (decision 53).
 */
export function countChangedLines(
  repoPath: string,
  target: string,
  branch: string,
): { lines: number; forged: string[] } {
  let lines = 0;
  const forged: string[] = [];
  for (const stat of gitDiffNumstat(repoPath, target, branch)) {
    if (LOCKFILE_NAMES.includes(stat.path)) continue;
    if (stat.added !== null && stat.deleted !== null) {
      lines += stat.added + stat.deleted;
      continue;
    }
    const recount = gitDiffBinaryRecount(repoPath, target, branch, stat.path);
    if (!recount) continue;
    lines += recount.added + recount.deleted;
    forged.push(stat.path);
  }
  return { lines, forged };
}

/**
 * Run `fn`, a synchronous body, holding the merge lock, with node kept alive
 * through a signal while it does. A terminal Ctrl-C reaches node and the child
 * git alike: with no listener node's default disposition dies mid-call and the
 * `finally` never removes the lock; with one, only the child dies, its failure
 * unwinds the stack and the lock goes. The listener's body never runs, since a
 * synchronous body never yields to the event loop that dispatches it, so a
 * signal sent to pup alone, which kills no child, is discarded: the locked
 * section runs to its end. Outside the lock node's default applies again.
 */
export function withMergeLock<TResult>(repoPath: string, fn: () => TResult): TResult {
  const lockPath = join(repoPath, '.git', MERGE_LOCK_DIRNAME);
  try {
    mkdirSync(lockPath);
  } catch {
    throw new MergeLockHeldError(lockPath);
  }
  const stayAlive = (): void => undefined;
  process.on('SIGINT', stayAlive);
  process.on('SIGTERM', stayAlive);
  try {
    return fn();
  } finally {
    // The lock goes first: a signal between the two would otherwise meet
    // node's default disposition with the lock still on disk.
    try {
      rmdirSync(lockPath);
    } finally {
      process.off('SIGINT', stayAlive);
      process.off('SIGTERM', stayAlive);
    }
  }
}

function formatGateReport(report: GateReport): string {
  const lines = report.stages.map(
    (s) => `- ${s.stage}: ${s.status.toUpperCase()}${s.detail ? ` — ${s.detail}` : ''}`,
  );
  const header = `Merge gate ${report.passed ? 'passed' : 'FAILED'} for session ${report.sessionId}.`;
  // The containment line sits with the stages, not in a footnote: this text is
  // the PR body and the re-steer prompt as well as the terminal report.
  lines.push(`- sandbox: ${report.sandbox}`);
  if (report.passed) return [header, ...lines].join('\n');
  return [
    header,
    ...lines,
    '',
    'Fix the failures above, commit in this worktree, then run `pup session done "<summary>"` again.',
  ].join('\n');
}

/**
 * `pup merge`: fresh-base check with mechanical auto-rebase (decision 8), then the
 * hard stages — build, tests, lint, a touched nested package's own test and
 * typecheck (decision 59), scope audit — and the soft debt stages:
 * diff-size plus the v1.1 debt deltas (dead code, duplication, complexity;
 * decision 21), every one of them run on a private detached checkout of the
 * pinned sha (decision 81). Pass: a plumbing fast-forward of that sha (decision
 * 80), full cleanup (decision 16), and the debt baseline ratchets to what the
 * capabilities measured. Hard fail: re-steer with the report, cap
 * at two rejections then park as blocked (decisions 7, 15). Any soft flag without
 * --accept-debt refuses the merge but leaves the session reviewable (decision 17);
 * with it, each flag writes a ledger entry. The whole run holds the per-repo
 * merge lock. A merged session whose open PR's head moved past the pin is gated
 * again on that head with `--pr` (decision 86).
 */
export function runMergeGate(db: Database, req: MergeRequest): MergeOutcome {
  const session = getSession(db, req.sessionId);
  if (!session) throw new Error(`No session ${req.sessionId}.`);
  const merged =
    session.state === 'merged' && req.openPr ? mergeToRegate(db, session.id) : undefined;
  if (session.state !== 'awaiting-review' && !merged) {
    throw new SessionNotReviewableError(req.sessionId, session.state);
  }
  // First of the refusals that spawn nothing: everything below runs children,
  // and a platform with no sandbox and no operator declaration runs none of
  // them (decision 78).
  const sandbox = sandboxLabel();
  // Refused, not run: with no adapter the three hard stages skip as "no command
  // available" and every debt stage as "adapter cannot measure", so the gate
  // would merge anything it was handed while reporting a full set of stages
  // (decision 6 — the gate is the backstop, and a silent one is worse than
  // none). `pup merge` refuses first; this is the seam holding every caller.
  if (req.adapters.length === 0) {
    throw new Error(
      `No adapter for ${req.repoPath}; the gate would measure nothing. ` +
        'Run `pup init` from a repo with a supported stack (TypeScript, Python, or a ' +
        '.pupitre/adapter.yml).',
    );
  }
  // Before the auto-rebase, which runs a smudge filter on every file it checks
  // out and a merge driver on every conflict, with the operator's environment
  // and ahead of the sandbox that confines the stages. Both paths, because the
  // rebase runs in the worktree and the fast-forward's checkout in the main
  // one, and a worktree-scoped config is only visible from its own worktree
  // (decision 50). The main checkout is asked again under the lock, since the
  // stages run while the session is alive (decision 80). A re-gate rebases
  // nothing and its worktree is gone with the first merge.
  assertNoArmedGitDrivers(req.repoPath);
  if (!merged) assertNoArmedGitDrivers(session.worktree_path);
  const target = currentBranch(req.repoPath);
  if (!target) {
    throw new Error(`Main worktree at ${req.repoPath} is not on a branch; cannot merge.`);
  }
  assertTargetName(req.repoPath, target);
  let pullRequest: PullRequestPlan | undefined;
  if (req.openPr) {
    assertGhAvailable(MERGE_PR_USE.command);
    // Resolved once, here, and carried to the push, so the PR's repo and the
    // pushed-to URL are one value and nothing the stages run can move it
    // (decisions 54, 56).
    const originUrl = pushTarget(db, session, req.repoPath);
    const ref = {
      repo: originRepoSlug(originUrl),
      head: session.branch,
      base: target,
    };
    // Everything GitHub can refuse is settled here, before ten minutes of gate
    // stages and before --accept-debt writes ledger entries for a merge that
    // would then abort (decision 27).
    pullRequest = merged
      ? planRegate(req.repoPath, session.id, merged, ref, originUrl)
      : { ...ref, originUrl, adoptedUrl: findOpenPullRequest(req.repoPath, ref) };
  }
  return withMergeLock(req.repoPath, () => {
    // Not under the project's state dir beside the conductor's checkout: the
    // sandbox denies every gate child reads and writes under `~/.pupitre`,
    // which holds the store (decision 36). `mkdtemp` is private and unguessable;
    // resolved, because the sandbox matches resolved paths.
    const checkoutRoot = mkdtempSync(join(realpathSync(tmpdir()), 'pup-gate-checkout-'));
    try {
      const checkoutDir = join(checkoutRoot, 'checkout');
      return pullRequest?.regate
        ? regateMerged(
            db,
            req,
            session,
            pullRequest,
            pullRequest.regate,
            target,
            sandbox,
            checkoutDir,
          )
        : gateAndMerge(db, req, session, target, sandbox, checkoutDir, pullRequest);
    } finally {
      // Still under the lock, on a pass, a failed stage and a throw alike.
      // Swallowed: a cleanup failure must not replace the gate's outcome or
      // its error, and the registration goes with the next gate's prune once
      // the directory is gone.
      try {
        dropGateCheckout(req.repoPath, checkoutRoot);
      } catch {
        // see above
      }
    }
  });
}

/**
 * Cut the gate's private detached checkout of the pinned sha, which every
 * stage and debt capability then reads instead of the session's worktree, whose
 * files the live session can edit while they run (decision 81). Detached like
 * the conductor's checkout (decision 51), but cut fresh under the lock and
 * dropped before it is released, since it must hold the one sha this gate lands.
 *
 * `--no-checkout` then a `read-tree` of our own, for the reasons `fastForward`
 * gives: `--work-tree`, because `core.worktree` in the shared config would aim
 * the writes elsewhere, and `--no-sparse-checkout`, because a planted
 * `core.sparseCheckout` would leave out committed files no stage would then
 * see. The checkout runs a smudge filter on every file it writes, so the drivers
 * are checked again right before it, as they are before the fast-forward.
 */
function cutGateCheckout(repoPath: string, dir: string, sha: string): string {
  assertNoArmedGitDrivers(repoPath);
  runGit(repoPath, ['worktree', 'add', '--detach', '--no-checkout', dir, sha]);
  runGit(dir, [
    '--work-tree',
    dir,
    'read-tree',
    '--no-recurse-submodules',
    '--no-sparse-checkout',
    '--reset',
    '-u',
    sha,
  ]);
  refuseEscapingLinks(dir, sha);
  return dir;
}

/** True when `path` (which must exist) resolves outside the checkout rooted at `inside`. */
function escapesCheckout(inside: string, path: string): boolean {
  const real = realpathSync(path);
  return real !== inside && !real.startsWith(`${inside}/`);
}

/**
 * Refuse a pinned tree whose committed symlinks reach outside the checkout:
 * a stage would read through them into the session's worktree, which the live
 * session edits while the stage runs. Every `120000` entry of the tree, not a
 * walk of one directory: a link can sit anywhere, and a chain through a
 * committed directory link would hide from a walk. A dangling link is judged
 * by where it points: one whose target stays inside the checkout (`.env ->
 * .env.local`, a build output) adds no reach and is kept; one pointing out is
 * refused like a resolving one (decision 81).
 */
function refuseEscapingLinks(checkout: string, sha: string): void {
  const inside = realpathSync(checkout);
  const entries = runGit(checkout, ['ls-tree', '-r', '-z', sha]).split('\0').filter(Boolean);
  for (const entry of entries) {
    // The path is everything after the first tab: mode, type and oid never hold
    // one, a path can.
    const tab = entry.indexOf('\t');
    const meta = entry.slice(0, tab);
    const path = entry.slice(tab + 1);
    if (!meta.startsWith('120000')) continue;
    const at = join(checkout, path);
    let out: boolean;
    try {
      out = escapesCheckout(inside, at);
    } catch {
      // Dangling: judged from where it would land. A `..` after a named segment
      // climbs from wherever that segment resolves when a stage runs (an
      // environment entry linked after this vet, a committed `b -> .`), which no
      // lexical reading knows, so only leading `..` are judged.
      const target = readlinkSync(at);
      const segments = target.split('/').filter((s) => s !== '' && s !== '.');
      const firstName = segments.findIndex((s) => s !== '..');
      const climbsPastName = firstName !== -1 && segments.slice(firstName).includes('..');
      const lands = resolve(realpathSync(dirname(at)), target);
      out = climbsPastName || (lands !== inside && !lands.startsWith(`${inside}/`));
    }
    if (out) {
      throw new Error(
        `${quotePath(path)} is a committed link that reaches outside the gate checkout; nothing ` +
          'was merged. If the target branch already carries it, the gate cannot run on this ' +
          'repo until it is replaced; otherwise treat the session that wrote it as compromised.',
      );
    }
  }
}

/**
 * Give `<checkout>/<rel>` the main checkout's `node_modules`, as links to each
 * entry of `<repoPath>/<rel>`'s — never the session worktree's own, which the
 * live session can rewrite (`.bin/vitest`) while the stages run; a standalone
 * package resolves from its own directory, so each touched one gets its own
 * (decision 81). A directory of links rather than one link: vite writes
 * `.vite-temp` beside the packages, and through a single link that write lands
 * where the sandbox denies it; `.vite*` and `.cache` are skipped so a stage
 * writes them in the checkout. A `node_modules` the pinned tree commits is
 * kept as any committed file is (its links were vetted with the tree's), so a
 * vendored `.bin` is the branch's own and the operator's to review. Python
 * gets nothing: see decision 81's ceiling.
 */
function linkEnvironment(repoPath: string, checkout: string, rel: string): void {
  const source = join(repoPath, rel, GATE_ENVIRONMENT_DIR);
  const local = join(checkout, rel, GATE_ENVIRONMENT_DIR);
  if (lstatSync(local, { throwIfNoEntry: false })) return;
  if (!existsSync(source)) return;
  // A package the branch deleted has no directory to link into; its stages
  // will say so in their own words.
  if (!existsSync(dirname(local))) return;
  // A committed parent could itself be a link out: checked before anything is
  // written under it.
  if (escapesCheckout(realpathSync(checkout), dirname(local))) {
    throw new Error(`${quotePath(rel)} resolves outside the gate checkout; nothing was merged.`);
  }
  mkdirSync(local, { recursive: true });
  for (const name of readdirSync(source)) {
    if (name === '.cache' || name.startsWith('.vite')) continue;
    symlinkSync(join(source, name), join(local, name));
  }
}

/**
 * Remove the gate's checkout and its registration. `rmSync` rather than
 * `worktree remove`, which refuses a checkout that was never cut; the prune
 * then drops the registration, and only registrations whose directory is gone.
 */
function dropGateCheckout(repoPath: string, root: string): void {
  rmSync(root, { recursive: true, force: true });
  runGit(repoPath, ['worktree', 'prune']);
}

/**
 * Refuse a target name git would not create as a branch. A session can point
 * the main checkout's HEAD at any `refs/heads/` name by writing the file, and a
 * leading `-` reads as an option wherever the name is argv, and a control or
 * bidi character would reach the operator's terminal. `check-ref-format
 * --branch` also expands `@{-N}`, so its answer must be the name it was asked
 * about. The `=` refusal is decision 79's, from when the merge keyed a `-c` on
 * the name; it stays because a refusal set only grows (decision 80).
 */
export function assertTargetName(repoPath: string, target: string): void {
  const refuse = (why: string): never => {
    throw new Error(
      `Target branch ${sanitizeReason(target)} ${why}; rename it from the trusted checkout ` +
        'before merging.',
    );
  };
  if (target.startsWith('-')) refuse("starts with '-', which git would read as an option");
  if (target.includes('=')) refuse("has an '=' in its name, which no git -c can address");
  // check-ref-format lets C1 controls and bidi overrides through, and the name
  // is printed in every refusal and report line below.
  if (/[\p{Cc}\p{Cf}]/u.test(target)) refuse('has a control or format character in its name');
  const checked = (() => {
    try {
      return runGit(repoPath, ['check-ref-format', '--branch', target], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return undefined;
    }
  })();
  if (checked !== target) {
    refuse('is not a name git accepts for a branch (check-ref-format --branch)');
  }
}

/**
 * The commit `ref` names, as a full sha. Callers pass a qualified ref, never a
 * bare name: a lightweight tag named like a branch wins a bare lookup. A
 * symbolic ref is refused: its sha is another branch's, so a gate that pinned
 * it would measure an empty diff and then move or delete that branch through it.
 */
export function resolveCommit(repoPath: string, ref: string): string {
  const piped = { stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  const symbolic = (() => {
    try {
      return runGit(repoPath, ['symbolic-ref', '-q', ref], piped).trim();
    } catch (error) {
      rethrowIfKilled(error);
      return undefined;
    }
  })();
  if (symbolic !== undefined) {
    throw new Error(
      `${sanitizeReason(ref)} is a symbolic ref to ${sanitizeReason(symbolic)}, not a branch of ` +
        'its own; nothing was merged. Treat a session that wrote it as compromised.',
    );
  }
  return runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], piped).trim();
}

/**
 * Refuse unless `target` still names `targetSha`, the only commit the
 * fast-forward's compare-and-swap will move it from. A deleted target reads as
 * moved to nowhere, not as a stack; a symref keeps its own refusal, which names
 * the compromise.
 */
function assertTargetAt(repoPath: string, target: string, targetSha: string): void {
  let now: string;
  try {
    now = resolveCommit(repoPath, `refs/heads/${target}`);
  } catch (error) {
    rethrowIfKilled(error);
    if (error instanceof Error && error.message.includes('symbolic ref')) throw error;
    now = 'nowhere';
  }
  if (now !== targetSha) {
    throw new Error(
      `${sanitizeReason(target)} moved from ${targetSha} to ${now} while the gate ran; nothing ` +
        'was checked out and the session is not merged.',
    );
  }
}

/**
 * How many commits `branchRef` gained after the gate pinned `sha`: none when it
 * still names the pin, and none when it is gone or turned into a symref, which
 * hold no commit of the session's own.
 */
function commitsPastPin(repoPath: string, branchRef: string, sha: string): number {
  let now: string;
  try {
    now = resolveCommit(repoPath, branchRef);
  } catch {
    return 0;
  }
  if (now === sha) return 0;
  return Number(runGit(repoPath, ['rev-list', '--count', `${sha}..${now}`]).trim());
}

/**
 * Delete `branchRef` only while it still names `sha`; false when it moved, or
 * git failed otherwise, and it is kept. Throws when an interrupt killed git, so
 * a caller never reads that as moved. `--no-deref`: a branch turned into a
 * symref after the pin must not delete the branch it points at.
 */
export function deleteBranchAt(repoPath: string, branchRef: string, sha: string): boolean {
  try {
    runGit(repoPath, ['update-ref', '--no-deref', '-d', branchRef, sha], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch (error) {
    rethrowIfKilled(error);
    return false;
  }
}

/** One shell word, for a command the operator is asked to paste. */
function shellWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Fast-forward `target` from `targetSha` to `sha` with plumbing (decision 80);
 * the caller has checked `sha` descends from `targetSha` right after the pin.
 * The porcelain merge reads `branch.<HEAD>.mergeOptions` for whatever HEAD
 * names when it runs, which a live session can flip between any check and the
 * spawn; nothing here reads per-branch config. `read-tree -m -u` moves the main
 * checkout's index and files from one tree to the other, refusing to overwrite
 * a local change, and `update-ref` with the old value is a compare-and-swap:
 * it fails if anything moved the target since `targetSha` was read, which is
 * also the race the HEAD re-read before this leaves open. `--no-deref`, so a
 * target turned into a symref after the pin is rewritten, not followed.
 */
export function fastForward(
  repoPath: string,
  target: string,
  targetSha: string,
  sha: string,
): void {
  const shown = sanitizeReason(target);
  // Before the checkout is touched, not only at the compare-and-swap after it
  // (decision 80).
  assertTargetAt(repoPath, target, targetSha);
  // `--work-tree` because `core.worktree` sits in the shared config and would
  // aim the checkout's writes wherever a session chose; `submodule.recurse` is
  // pinned off in `GIT_SAFE_CONFIG`, and the flag here says so again; and
  // `--no-sparse-checkout` because a planted `core.sparseCheckout` would have
  // the checkout delete trusted files the pattern leaves out.
  const checkout = (args: string[]): string =>
    runGit(repoPath, ['--work-tree', repoPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    // A stale stat (an editor's rewrite, a `touch`) would otherwise read as a
    // local change and refuse the checkout, as the porcelain merge never did.
    checkout(['update-index', '-q', '--ignore-submodules', '--refresh']);
    checkout([
      'read-tree',
      '--no-recurse-submodules',
      '--no-sparse-checkout',
      '-m',
      '-u',
      targetSha,
      sha,
    ]);
  } catch (error) {
    throw new Error(
      `Fast-forward of ${shown} to ${sha} refused by the checkout; the ref was not moved and ` +
        `the session is not merged.\n${commandFailureDetail(error)}`,
    );
  }
  try {
    checkout([
      'update-ref',
      '--no-deref',
      '-m',
      `pup merge: fast-forward to ${sha}`,
      `refs/heads/${target}`,
      sha,
      targetSha,
    ]);
  } catch (error) {
    // The checkout holds the new tree and the ref does not. The inverse two-way
    // read-tree puts it back here, under the lock, rather than printed for
    // later — but the forward checkout was a window the session controlled,
    // so the drivers are checked again first: a smudge filter armed meanwhile
    // would run on every file the restore rewrites (decision 50).
    const inverse = [
      'read-tree',
      '--no-recurse-submodules',
      '--no-sparse-checkout',
      '-m',
      '-u',
      sha,
      targetSha,
    ];
    // The driver read can itself fail on a config a session mangled; that must
    // not replace the report of what happened to the checkout.
    let armed: string[] = [];
    let unchecked: string | undefined;
    try {
      armed = armedGitDrivers(repoPath);
    } catch (failed) {
      unchecked = sanitizeReason(failureSummary(failed));
    }
    let restored = false;
    if (armed.length === 0 && unchecked === undefined) {
      try {
        checkout(inverse);
        restored = true;
      } catch {
        // reported below, with the line to run by hand
      }
    }
    const git =
      `git -C ${shellWord(repoPath)} --work-tree ${shellWord(repoPath)} ` +
      '-c core.hooksPath=/dev/null -c core.fsmonitor= -c submodule.recurse=false';
    // The pasted line runs later, while sessions are alive, and a smudge filter
    // has no -c disarm: the order to clear drivers first is the line's only
    // protection, so it is printed whether or not one was armed just now.
    const why =
      armed.length > 0
        ? ` because ${armed.join(', ')} is armed`
        : unchecked !== undefined
          ? ` because the driver check failed: ${unchecked}`
          : '';
    const checkoutState = restored
      ? `The main checkout was put back to ${targetSha}'s files.\n`
      : `The main checkout still holds ${sha}'s files and was not put back${why}. Clear any ` +
        'filter.* config and info/attributes first and treat a session that wrote them as ' +
        `compromised (decision 50), then run:\n  ${git} ${inverse.join(' ')}\n`;
    throw new Error(
      `Fast-forward of ${shown} to ${sha} failed, and the session is not merged: the ` +
        `compare-and-swap refuses if ${shown} moved from ${targetSha} under the lock, and ` +
        `the ref was left where it is.\n${checkoutState}${commandFailureDetail(error)}`,
    );
  }
}

const PUSH_TARGET_HELP =
  'The config the value lives in is shared with every worktree and a session can rewrite it, ' +
  'so treat a session that moved it as compromised; if origin really moved, re-record it with ' +
  '`pup init --origin-moved` from the trusted checkout.';

/** Who asks `pushTarget`, and what its refusal leaves undone, for the message. */
export interface OriginUse {
  command: string;
  untouched: string;
}

const MERGE_PR_USE: OriginUse = { command: '`pup merge --pr`', untouched: 'Nothing was pushed.' };

/**
 * Where the branch is pushed and which repo the PR is pinned to: the URL
 * recorded on the project row, and only while origin is still configured as
 * that same value.
 *
 * Decision 54 stopped the push reading `url.*` rewrites out of the shared
 * config, and left the ceiling this closes: `remote.origin.url` itself lives in
 * that same session-writable config, so a session that rewrites it aims both
 * the push and the `--repo` pin. The recorded copy is the trusted one — written
 * by `pup init` from the operator's checkout — so it is what pup pushes to, and
 * the live read is here to say when something moved it rather than to be
 * quietly worked around. Both refusals are decision 6's loud backstop: they
 * name both values and happen before the gate runs, so nothing is pushed.
 * `pup land` fetches from the same value for the same reason (decision 84).
 */
export function pushTarget(
  db: Database,
  session: SessionRow,
  repoPath: string,
  use: OriginUse = MERGE_PR_USE,
): string {
  const configured = readOriginUrl(repoPath);
  if (!configured) {
    throw new Error(`${use.command} needs an \`origin\` remote. ${use.untouched}`);
  }
  const task = getTask(db, session.task_id);
  if (!task) throw new Error(`Session ${session.id} has no task row; cannot resolve its project.`);
  const project = getProject(db, task.project_id);
  // The session reaches its project through its task row, which is a second
  // notion of "this project" beside the path the merge was asked for. They
  // agree in every store pup writes; if they ever did not, the push target
  // would be read from a row describing another checkout.
  if (project && project.repo_path !== repoPath) {
    throw new Error(
      `Session ${session.id} belongs to project ${task.project_id}, recorded at ` +
        `${project.repo_path}, not the ${repoPath} this command was asked for. ${use.untouched}`,
    );
  }
  const recorded = project?.origin_url ?? undefined;
  if (!recorded) {
    throw new Error(
      'No push target is recorded for this project, so there is nothing to check origin ' +
        `against: origin says ${sanitizeReason(configured)}, and nothing says that is where ` +
        'the operator pointed it. Run `pup init` from the trusted checkout to record it, ' +
        `then retry. ${use.untouched}`,
    );
  }
  if (recorded !== configured) {
    throw new Error(
      `Refusing ${use.command}: origin's URL is not the one recorded when this project ` +
        `was set up.\n  recorded:   ${sanitizeReason(recorded)}\n  configured: ` +
        `${sanitizeReason(configured)}\n${use.untouched} ${PUSH_TARGET_HELP}`,
    );
  }
  return recorded;
}

interface PullRequestPlan extends PullRequestRef {
  /** The push target recorded at setup; the push goes here literally (decision 56). */
  originUrl: string;
  /** Set when an open PR for this branch already exists and passed adoption checks. */
  adoptedUrl?: string;
  /**
   * Set on a re-gate (decision 86): the merged session's open PR, and the head
   * GitHub reports for it, which the local branch must hold when it is pinned.
   */
  regate?: { head: string; prUrl: string };
}

/** A sha as the gate pins it, which can then never read as an option. */
export const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const NOT_REGATED = 'Nothing was re-gated.';

/**
 * The newest merge event, or `'landed'` when a `landed` event came after it:
 * the merge that stands describes the session, like the inbox reads it.
 */
export function newestMerge(
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
 * Refuse a PR url that is not a pull request of `repo`. The url is store text:
 * one of another repo would have gh answer for any PR. GitHub prints the repo in
 * its canonical case whatever case the recorded origin uses, so the prefix is
 * compared without case, within ASCII so no letter can fold into a match.
 */
export function assertPullRequestOf(prUrl: string, repo: string, untouched: string): void {
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
        `origin was recorded as. ${untouched}`,
    );
  }
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
function mergeToRegate(db: Database, sessionId: string): MergeToRegate {
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
function planRegate(
  repoPath: string,
  sessionId: string,
  merge: MergeToRegate,
  ref: PullRequestRef,
  originUrl: string,
): PullRequestPlan {
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

function gateAndMerge(
  db: Database,
  req: MergeRequest,
  session: SessionRow,
  target: string,
  sandbox: string,
  checkoutDir: string,
  pullRequest?: PullRequestPlan,
): MergeOutcome {
  const worktree = session.worktree_path;
  const stages: GateStageResult[] = [];
  const failed = (): MergeOutcome =>
    rejectOrBlock(db, { sessionId: session.id, passed: false, sandbox, stages });

  const dirty = runGit(worktree, ['status', '--porcelain']).trim();
  if (dirty) {
    stages.push({
      stage: 'worktree-clean',
      status: 'fail',
      detail: `Uncommitted changes in the worktree:\n${dirty}`,
    });
    return failed();
  }
  stages.push({ stage: 'worktree-clean', status: 'pass' });

  // Both ends pinned under the lock, and every later git call names a sha
  // (decision 80): the target here, so the rebase, the diffs and the
  // compare-and-swap all mean one commit; the branch once the rebase settled
  // it, so what the diffs and the scope audit named is what lands, whatever the
  // live session commits or tags meanwhile. The stages read that sha's files
  // from the gate's own checkout (decision 81).
  const branchRef = `refs/heads/${session.branch}`;
  const targetSha = resolveCommit(req.repoPath, `refs/heads/${target}`);
  if (isAncestor(req.repoPath, targetSha, branchRef)) {
    stages.push({ stage: 'fresh-base', status: 'pass', detail: `already based on ${target}` });
  } else {
    try {
      runGit(worktree, ['rebase', targetSha]);
      stages.push({ stage: 'fresh-base', status: 'pass', detail: `auto-rebased onto ${target}` });
    } catch (error) {
      try {
        runGit(worktree, ['rebase', '--abort']);
      } catch {
        // nothing to abort — the rebase never started
      }
      stages.push({
        stage: 'fresh-base',
        status: 'fail',
        detail:
          `Auto-rebase onto ${sanitizeReason(target)} hit conflicts. Run ` +
          `\`git rebase ${shellWord(`refs/heads/${sanitizeReason(target)}`)}\`, ` +
          `resolve the conflicts, and finish the rebase.\n${commandFailureDetail(error)}`,
      });
      return failed();
    }
  }
  const sha = resolveCommit(req.repoPath, branchRef);
  // The rebase moves whatever the worktree has checked out, so a session that
  // detached it or switched branch leaves the pinned branch behind the target:
  // no fast-forward, and the diffs would measure against the wrong base.
  if (!isAncestor(req.repoPath, targetSha, sha)) {
    // Replaces the pass pushed above: one fresh-base line, not a pass then a fail.
    stages.pop();
    stages.push({
      stage: 'fresh-base',
      status: 'fail',
      detail:
        `${session.branch} at ${sha} is not based on ${sanitizeReason(target)} at ${targetSha} ` +
        `after the auto-rebase. Check out ${session.branch} in this worktree and rebase it onto ` +
        `refs/heads/${sanitizeReason(target)}.`,
    });
    return failed();
  }

  const measured = measureBranch(db, req, session, stages, checkoutDir, targetSha, sha);
  if (!measured) return failed();
  const { changedPaths, flaggedDebt, debtCandidates, spec, project, baseline } = measured;

  if (flaggedDebt.length > 0 && !req.acceptDebt) return refuseGate(db, session, sandbox, stages);
  // Before the ledger write, not only before the checkout: a target moved while
  // the stages ran is the one under-lock refusal that can be settled this early,
  // and debt filed for a merge that then aborts reads as merged from this
  // session (decision 82). `fastForward` reads it again right before the
  // checkout, with the compare-and-swap as the backstop.
  if (!pullRequest) assertTargetAt(req.repoPath, target, targetSha);
  const commitSubjects = commitSubjectsBetween(req.repoPath, targetSha, sha);
  // What `--accept-debt` filed, for the refusals that must stay after it.
  const ledgerKept = fileAcceptedDebt(db, req, measured.projectId, flaggedDebt);

  const report: GateReport = { sessionId: session.id, passed: true, sandbox, stages };
  let prUrl: string | undefined;
  let prWasAdopted = false;
  if (pullRequest) {
    const newPr = {
      ...pullRequest,
      ...pullRequestText(spec, session.id, report, commitSubjects, sha),
    };
    try {
      pushBranch(req.repoPath, pullRequest.originUrl, session.branch, sha);
      if (pullRequest.adoptedUrl) {
        rewritePullRequest(req.repoPath, pullRequest.adoptedUrl, newPr);
        prWasAdopted = true;
        prUrl = pullRequest.adoptedUrl;
      } else {
        prUrl = createPullRequest(req.repoPath, newPr);
      }
      // The body vouches for `sha`; a session holding the operator's gh login
      // can push the branch between our push and the PR call (decision 82).
      assertPullRequestHead(req.repoPath, prUrl, pullRequest.repo, sha);
    } catch (error) {
      throw withLedgerKept(error, ledgerKept);
    }
  } else {
    try {
      // Re-read under the lock: `target` was read before it, and the checkout
      // below moves whatever index HEAD names (decision 79). The drivers too: a
      // session alive during the stages can re-arm `info/attributes`, and the
      // checkout runs a smudge filter on every file it writes (decision 80).
      // Both stay last, after the ledger write, because they guard the checkout.
      const checkedOut = currentBranch(req.repoPath);
      if (checkedOut !== target) {
        throw new Error(
          `Main worktree moved from ${sanitizeReason(target)} to ` +
            `${checkedOut ? sanitizeReason(checkedOut) : 'no branch'} while the gate ran; ` +
            'nothing was merged.',
        );
      }
      assertNoArmedGitDrivers(req.repoPath);
      fastForward(req.repoPath, target, targetSha, sha);
    } catch (error) {
      throw withLedgerKept(error, ledgerKept);
    }
  }
  transitionSession(db, session.id, 'merged', { report });
  // Torn down and recorded before the ratchet and the decision draft: both can
  // throw, and the draft runs `claude -p` for up to two minutes, while the
  // target already holds the sha and `pup status` already reads merged.
  let isDeleted = false;
  try {
    // By pane as well as name: a rename from inside the session would leave
    // the name pointing at nothing while the window ran on (decision 46).
    killTmux(session.id, session.tmux_target);
    runGit(req.repoPath, ['worktree', 'remove', '--force', worktree]);
    // Deleted only while it still names the gated commit, in both modes: a
    // commit the session added after the pin was never measured, so it is left
    // on the branch for the operator rather than merged or thrown away.
    try {
      isDeleted = deleteBranchAt(req.repoPath, branchRef, sha);
    } catch {
      // Interrupted after the merge landed: keep the branch, which the
      // `finally` still checks for commits past the pin, rather than skip the
      // ratchet and the draft.
    }
  } finally {
    // Counted only once the session is killed and its worktree gone, so no
    // commit can land after the count; recorded even if the teardown threw,
    // since the target already holds the pinned sha.
    recordMerge(db, req.repoPath, session, { sha, target, files: changedPaths, prUrl }, isDeleted);
  }
  if (
    // In PR mode the target branch has not moved, so the bar must not either:
    // `pup land` ratchets it once the PR has (decisions 26, 84).
    !req.openPr &&
    project &&
    baseline &&
    Object.keys(measured.ratchet).length > 0
  ) {
    // Ratchet (docs/04): the merged state becomes the new bar. Accepted-debt merges
    // move it too — the accepted amount lives in the ledger, and re-flagging it would
    // punish later sessions for debt they didn't add.
    const next: ProjectBaseline = { ...baseline, debt: { ...baseline.debt, ...measured.ratchet } };
    saveProjectBaseline(
      db,
      measured.projectId,
      JSON.parse(project.adapters) as string[],
      JSON.stringify(next),
    );
  }
  const decisionRecordId = draftDecisionRecord(db, {
    sessionId: session.id,
    spec,
    files: changedPaths,
    commitSubjects,
  });
  return {
    status: 'merged',
    report,
    rejectCount: session.reject_count,
    debtCandidates,
    decisionRecordId,
    ...(prUrl !== undefined ? { prUrl, prWasAdopted } : {}),
  };
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
function regateMerged(
  db: Database,
  req: MergeRequest,
  session: SessionRow,
  pullRequest: PullRequestPlan,
  regate: { head: string; prUrl: string },
  target: string,
  sandbox: string,
  checkoutDir: string,
): MergeOutcome {
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
  const targetSha = resolveCommit(req.repoPath, `refs/heads/${target}`);
  // Pinned first, and once: no rebase will move the branch.
  const sha = pinRegatedHead(req.repoPath, session.branch, regate.head, regate.prUrl);
  if (!isAncestor(req.repoPath, targetSha, sha)) {
    stages.push({
      stage: 'fresh-base',
      status: 'fail',
      detail:
        `${session.branch} at ${sha} is not based on ${sanitizeReason(target)} at ` +
        `${targetSha}. Rebase it onto ${sanitizeReason(target)}, push it to the PR, then re-gate.`,
    });
    return refused();
  }
  stages.push({ stage: 'fresh-base', status: 'pass', detail: `already based on ${target}` });

  const measured = measureBranch(db, req, session, stages, checkoutDir, targetSha, sha);
  if (!measured || (measured.flaggedDebt.length > 0 && !req.acceptDebt)) return refused();
  const commitSubjects = commitSubjectsBetween(req.repoPath, targetSha, sha);
  // The stages measure the whole branch again, so the flags the first gate
  // filed come back with figures the fix round moved: a kind this session
  // already holds open is not filed twice.
  const held = new Set(
    measured.openEntries.flatMap((entry) => debtKind(entry.description, session.id) ?? []),
  );
  const ledgerKept = fileAcceptedDebt(db, req, measured.projectId, measured.flaggedDebt, (flag) =>
    held.has(debtKind(flag.description, session.id) as string),
  );

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

/** What the stages measured, for the caller that lands it. */
interface BranchMeasurement {
  changedPaths: string[];
  flaggedDebt: FlaggedDebt[];
  debtCandidates: { id: number; description: string }[];
  /** The project's open ledger entries, read before this run filed any. */
  openEntries: LedgerEntryRow[];
  projectId: string;
  spec: TaskSpec;
  project: ProjectRow | undefined;
  baseline: ProjectBaseline | undefined;
  ratchet: DebtBaseline;
}

type FlaggedDebt = { description: string; files: string[] };

/**
 * Whether a failed stage run is the runner's own failing-tests exit, status 1
 * for vitest, jest, pytest and `go test` alike: the one failure a re-run can
 * tell from a flake. Anything else fails at once. A Ctrl-C reaches the gate's
 * child with pup itself (`withMergeLock` keeps pup alive through it), and a
 * re-run that passed would turn the operator's abort into a merge: so a child a
 * signal killed, a runner that caught the interrupt (130, or pytest's 2), and a
 * wrapper reporting a killed child (129, 143) are not re-run. Nor is a stage
 * that ran out `GATE_COMMAND_TIMEOUT_MS`, which node marks with a `code` even
 * when the runner traps the SIGTERM and exits 1, and whose re-run would hold
 * the merge lock twice as long on a hung suite.
 */
function isRerunnable(error: unknown): boolean {
  const { status, signal, code } = error as {
    status?: number | null;
    signal?: string | null;
    code?: string;
  };
  return status === 1 && !signal && code === undefined;
}

/**
 * The stages every gate run measures on the pinned sha, from the gate's
 * checkout (decision 81): build, test and lint, a touched nested package's own
 * scripts, the scope audit, the diff size and the debt deltas. Undefined once a
 * hard stage has recorded its failure in `stages`; the caller decides what a
 * failure does to the session.
 */
function measureBranch(
  db: Database,
  req: MergeRequest,
  session: SessionRow,
  stages: GateStageResult[],
  checkoutDir: string,
  targetSha: string,
  sha: string,
): BranchMeasurement | undefined {
  /** One run of a stage's command: the error it threw, `undefined` on a pass. */
  const runCommand = (command: { command: string; args: string[] }, cwd: string): unknown => {
    try {
      // The session wrote what this runs (its own scripts, its own config), so
      // it runs confined: an env allowlist (decision 28) inside a sandbox whose
      // writes are default-deny (decision 36). The stage writes in the gate's
      // checkout; `repoPath` is passed to scope the toolchain cache, and stays
      // read-only, which is what keeps decision 29's trusted checkout trusted
      // while the session's own code is running.
      runGateChild(command.command, command.args, {
        cwd,
        repoPath: req.repoPath,
        gateEnv: req.gateEnv,
        timeout: GATE_COMMAND_TIMEOUT_MS,
      });
      return undefined;
    } catch (error) {
      return error ?? new Error('command failed');
    }
  };

  /**
   * Runs one hard stage; false once it has recorded the failure. A failed test
   * stage runs once more, still under the lock, before it counts: a suite that
   * passes on the re-run passes, named flaky with what failed the first time,
   * so a timing-sensitive test the host's load tipped over is no rejection
   * (decision 94). Build and lint are deterministic and never re-run, and
   * neither is a test run that ended other than by the runner's own failing
   * exit (`isRerunnable`).
   */
  const commandStage = (
    stage: string,
    command: { stage: string; command: string; args: string[] },
    cwd: string,
  ): boolean => {
    const first = runCommand(command, cwd);
    if (first === undefined) {
      stages.push({ stage, status: 'pass' });
      return true;
    }
    if (command.stage !== 'test' || !isRerunnable(first)) {
      stages.push({ stage, status: 'fail', detail: commandFailureDetail(first) });
      return false;
    }
    const rerun = runCommand(command, cwd);
    if (rerun === undefined) {
      stages.push({
        stage,
        status: 'pass',
        detail: `flaky — failed, then passed on its one re-run; failing the first time: ${failingTestNames(first)}`,
      });
      return true;
    }
    stages.push({
      stage,
      status: 'fail',
      detail:
        `failed twice — failing the first time: ${failingTestNames(first)}; ` +
        `on the re-run: ${failingTestNames(rerun)}\n${commandFailureDetail(rerun)}`,
    });
    return false;
  };

  // One repo has one build, one test and one lint, and the runner that answers
  // for them is the one whose stack detected first (decision 22, which decision
  // 72 amends for debt only — that is measured over every adapter below). The
  // same adapter answers for nested packages, which are the root manifest's.
  // Never `undefined`: `runMergeGate` refuses an empty list before the lock.
  const [primary] = req.adapters;
  // Every stage and debt capability measures the pinned sha's files, never the
  // worktree's, which the live session can change while they run (decision 81);
  // which tools are declared is still read from the main checkout the merge
  // lock holds at the target branch, or a session silences a debt stage by
  // editing its own manifest (decision 29).
  const capabilityContext: CapabilityContext = {
    measurePath: checkoutDir,
    configPath: req.repoPath,
    ...(req.gateEnv?.length ? { gateEnv: req.gateEnv } : {}),
  };
  const checkout = cutGateCheckout(req.repoPath, checkoutDir, sha);
  const changedPaths = gitDiffPaths(req.repoPath, targetSha, sha);
  const nestedPackages = primary?.touchedNestedPackages?.(capabilityContext, changedPaths) ?? [];
  // Every environment before any stage: a stage runs session code with the
  // checkout writable, so a link made after it could follow a swapped-in
  // parent out of the checkout (decision 81).
  for (const rel of ['.', ...nestedPackages.map((pkg) => pkg.dir)]) {
    linkEnvironment(req.repoPath, checkout, rel);
  }
  // Resolved from the trusted main checkout, not the session's worktree: a
  // session that deletes a script fails that stage instead of skipping it.
  const commands = primary?.gateCommands(req.repoPath) ?? [];
  for (const stage of ['build', 'test', 'lint'] as const) {
    const command = commands.find((c) => c.stage === stage);
    if (!command) {
      stages.push({ stage, status: 'skipped', detail: 'not measured — no command available' });
      continue;
    }
    if (!commandStage(stage, command, checkout)) return undefined;
  }

  const flaggedDebt: { description: string; files: string[] }[] = [];
  // A merged session being re-gated has no window to steer (decision 86).
  const acceptHint =
    session.state === 'merged'
      ? 'Re-run with --accept-debt "<reason>" --review-by "<condition>".'
      : 'Re-run with --accept-debt "<reason>" --review-by "<condition>", or steer the session to address it.';
  const flagDetail = (summary: string): string =>
    req.acceptDebt
      ? `${summary} — accepted as debt: ${req.acceptDebt.reason}`
      : `${summary}. ${acceptHint}`;

  // Decision 58 leaves a nested package out of every root measurement because
  // its own runner covers it; nothing else invokes that runner, so the gate
  // does, as hard stages in the package's own directory. A script the trusted
  // manifest lacks is a flag: changed code no stage measures is never a free
  // pass (decisions 30, 59).
  for (const pkg of nestedPackages) {
    const dir = quotePath(pkg.dir);
    for (const command of pkg.commands) {
      if (!commandStage(`${command.stage} (${dir})`, command, join(checkout, pkg.dir))) {
        return undefined;
      }
    }
    for (const stage of pkg.missing) {
      flaggedDebt.push({
        description: `Nested package ${dir} changed with no ${stage} script, merged from session ${session.id}`,
        files: [...pkg.changedFiles].sort(),
      });
      stages.push({
        stage: `${stage} (${dir})`,
        status: 'flagged',
        detail: flagDetail(
          `not measured — ${dir}/package.json declares no ${stage} script, and no root stage measures a nested package`,
        ),
      });
    }
  }
  // Said on every debt stage the exclusion shapes, so a pass there reads as
  // "measured without these", not as "nothing to measure" (decision 29).
  const droppedDirs = nestedPackages.filter((pkg) => pkg.droppedSources.length > 0);
  const droppedCount = droppedDirs.reduce((sum, pkg) => sum + pkg.droppedSources.length, 0);
  const nestedNote =
    droppedCount === 0
      ? ''
      : `; ${droppedCount} changed file(s) in a nested package not measured here (${droppedDirs
          .slice(0, DEBT_DETAIL_SAMPLES)
          .map((pkg) => quotePath(pkg.dir))
          .join(', ')}${droppedDirs.length > DEBT_DETAIL_SAMPLES ? ', …' : ''})`;

  const specRow = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(session.task_id) as {
    project_id: string;
  };
  const spec = readTaskSpec(db, session.task_id);
  const violations = auditScope(changedPaths, spec.scopeIn, spec.scopeOut);
  if (violations.length > 0) {
    stages.push({
      stage: 'scope-audit',
      status: 'fail',
      detail: `Out-of-scope changes:\n${violations
        .map((v) => `  ${quotePath(v.path)} (${v.reason})`)
        .join('\n')}`,
    });
    return undefined;
  }
  stages.push({
    stage: 'scope-audit',
    status: 'pass',
    detail: `${changedPaths.length} files in scope`,
  });

  // Snapshot before any --accept-debt entry from THIS merge is written, so a
  // merge never flags its own fresh debt as closeable, nor, on a re-gate or a
  // retry, the debt an earlier run of it filed.
  const openEntries = listLedgerEntries(db, specRow.project_id);
  const debtCandidates = openEntries
    .filter((entry) => debtKind(entry.description, session.id) === undefined)
    .filter((entry) => {
      const files = JSON.parse(entry.files) as string[];
      return files.some((f) => changedPaths.includes(f));
    })
    .map((entry) => ({ id: entry.id, description: entry.description }));

  const project = getProject(db, specRow.project_id);
  const baseline = project?.baseline
    ? (JSON.parse(project.baseline) as ProjectBaseline)
    : undefined;

  const changed = countChangedLines(req.repoPath, targetSha, sha);
  const sizeFindings: string[] = [];
  if (changed.lines > DIFF_SIZE_FLAG_LINES) {
    flaggedDebt.push({
      description: `Oversize diff (${changed.lines} lines) merged from session ${session.id}`,
      files: changedPaths,
    });
    sizeFindings.push(`exceeds the ${DIFF_SIZE_FLAG_LINES}-line flag`);
  }
  // Flagged at any size: the count is honest again once recounted, but a text
  // file git was told to call binary is a write nobody reviewed (decision 53).
  if (changed.forged.length > 0) {
    const forged = [...changed.forged].sort();
    const quoted = forged.slice(0, DEBT_DETAIL_SAMPLES).map(quotePath).join(', ');
    const ellipsis = forged.length > DEBT_DETAIL_SAMPLES ? ', …' : '';
    flaggedDebt.push({
      description: `Text files git reports as binary (${forged.length}) merged from session ${session.id}`,
      files: forged,
    });
    sizeFindings.push(
      `counts ${forged.length} text file(s) git reports as binary, recounted from the patch: ` +
        `${quoted}${ellipsis}`,
    );
  }
  if (sizeFindings.length > 0) {
    stages.push({
      stage: 'diff-size',
      status: 'flagged',
      detail: flagDetail(`${changed.lines} changed lines ${sizeFindings.join('; ')}`),
    });
  } else {
    stages.push({ stage: 'diff-size', status: 'pass', detail: `${changed.lines} changed lines` });
  }

  const measurement = measureDebt(req.adapters, capabilityContext);
  const complexityAdapters = req.adapters.filter((a) => a.complexity);
  const judged = judgeDebt(
    {
      ...measurement,
      ...(complexityAdapters.length > 0
        ? {
            complexity: {
              // "Before" reads the main checkout, which the merge lock holds at
              // the target branch — no historical checkout needed.
              before: complexityAdapters.flatMap(
                (a) => a.complexity?.(localContext(req.repoPath, req.gateEnv), changedPaths) ?? [],
              ),
              after: complexityAdapters.flatMap(
                (a) => a.complexity?.(capabilityContext, changedPaths) ?? [],
              ),
            },
          }
        : {}),
      coverableFiles:
        measurement.coverageAdapter?.coverableFiles?.(capabilityContext, changedPaths) ?? [],
      ...(measurement.coverage
        ? {
            patch: patchCoverage(
              measurement.coverage,
              gitDiffAddedLines(req.repoPath, targetSha, sha),
            ),
          }
        : {}),
      nestedNote,
    },
    baseline?.debt,
    changedPaths,
    session.id,
  );
  // The accept hint is this caller's to add: `judgeDebt` cannot know whether
  // the merge carries --accept-debt, and the nested-package stages above go
  // through the same wrapper.
  for (const stage of judged.stages) {
    stages.push(
      stage.status === 'flagged' ? { ...stage, detail: flagDetail(stage.detail ?? '') } : stage,
    );
  }
  flaggedDebt.push(...judged.flags);
  return {
    changedPaths,
    flaggedDebt,
    debtCandidates,
    openEntries,
    projectId: specRow.project_id,
    spec,
    project,
    baseline,
    ratchet: judged.ratchet,
  };
}

/** A soft flag without `--accept-debt`, or a re-gate's failure: recorded, nothing merged. */
function refuseGate(
  db: Database,
  session: SessionRow,
  sandbox: string,
  stages: GateStageResult[],
): MergeOutcome {
  const report: GateReport = { sessionId: session.id, passed: false, sandbox, stages };
  appendEvent(db, session.id, 'gate_result', { outcome: 'refused', report });
  return { status: 'refused', report, rejectCount: session.reject_count };
}

/**
 * The gated commits' subjects, oldest first. Read before the ledger write: a
 * session-written `log.date` can fail this, and a failure after the write would
 * leave entries filed with no kept note.
 */
function commitSubjectsBetween(repoPath: string, targetSha: string, sha: string): string[] {
  return runGit(repoPath, ['log', '--reverse', '--format=%s', `${targetSha}..${sha}`])
    .trim()
    .split('\n')
    .filter(Boolean);
}

/**
 * File one ledger entry per flag under `--accept-debt`, none for a flag `held`
 * says the session already carries; the count is every flag the accepted debt
 * covers, for the refusals that must stay after the write.
 */
function fileAcceptedDebt(
  db: Database,
  req: MergeRequest,
  projectId: string,
  flaggedDebt: FlaggedDebt[],
  held: (flag: FlaggedDebt) => boolean = () => false,
): number {
  if (!req.acceptDebt) return 0;
  for (const flag of flaggedDebt) {
    const entry = {
      projectId,
      description: flag.description,
      files: flag.files,
      reason: req.acceptDebt.reason,
      // The approver arrives from a flag a relay fills in (decision 75), so
      // it is scrubbed before the store keeps it, not only where it prints.
      acceptedBy: sanitizeReason(req.acceptDebt.acceptedBy),
      reviewBy: req.acceptDebt.reviewBy,
    };
    // A retry after a partial failure (gh died after the push) re-runs the
    // gate with the same flags — the same debt must not be counted twice.
    // Safe because every description above embeds the session id, so this can
    // only ever match this session's own earlier attempt.
    if (!held(flag) && !hasOpenLedgerEntry(db, entry)) insertLedgerEntry(db, entry);
  }
  return flaggedDebt.length;
}

/**
 * The `merge` event, with the commits the branch gained after the pin counted
 * and named unless the branch was deleted at it.
 */
function recordMerge(
  db: Database,
  repoPath: string,
  session: SessionRow,
  merge: { sha: string; target: string; files: string[]; prUrl: string | undefined },
  isDeleted: boolean,
): void {
  const { sha, prUrl } = merge;
  const leftBehind = isDeleted ? 0 : commitsPastPin(repoPath, `refs/heads/${session.branch}`, sha);
  if (leftBehind > 0) {
    console.error(
      `${sanitizeReason(session.branch)} moved after the gate pinned ${sha}: ${leftBehind} ` +
        `later commit${leftBehind === 1 ? ' was' : 's were'} left behind on it, not merged.`,
    );
  }
  appendEvent(db, session.id, 'merge', {
    branch: session.branch,
    sha,
    target: merge.target,
    files: merge.files,
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(leftBehind > 0 ? { leftBehind } : {}),
  });
}

/** The title and body pupitre writes on a PR it opens or adopts. */
function pullRequestText(
  spec: TaskSpec,
  sessionId: string,
  report: GateReport,
  commitSubjects: string[],
  sha: string,
): { title: string; body: string } {
  return {
    title: prTitle(spec.goal) || `pup session ${sessionId}`,
    body: prBody(spec, report, commitSubjects, sha),
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

/**
 * Where each flag description the gate files carries its measured figures,
 * matched on the description with its ` session <id>` suffix cut: the
 * parenthesised group before "merged from" (`Oversize diff (812 lines)`), the
 * duplication's "rose from N to M", and the unmeasured-coverage file count.
 */
const DEBT_FIGURES = [
  /\([^()]*\)(?= merged from$)/,
  /(?<=^Duplicated lines rose from )\d+ to \d+(?= in$)/,
  /(?<=^Coverage unmeasured over )\d+(?= changed source file\(s\) in$)/,
];

/**
 * A ledger description with its figures dropped, so a re-gate tells the kind
 * of a flag from the numbers a fix round moved; undefined unless `sessionId`
 * filed it, which every flag description says at its end. Only the digits
 * `DEBT_FIGURES` places go: a digit in a path or name (`packages/app2`) is part
 * of the kind (decision 86).
 */
function debtKind(description: string, sessionId: string): string | undefined {
  const suffix = ` session ${sessionId}`;
  if (!description.endsWith(suffix)) return undefined;
  return DEBT_FIGURES.reduce(
    (kind, figures) => kind.replace(figures, (span) => span.replace(/\d+/g, '#')),
    description.slice(0, -suffix.length),
  );
}

/**
 * Push the session branch to origin's pinned URL. A retry after a failed `--pr`
 * run has usually been rebased onto a moved target, so a plain push would be
 * rejected non-fast-forward — and so would every retry after it, dead-ending
 * the branch. The branch is pup's own (`pup/<slug>`, created and deleted by
 * pup) and the gate just validated these commits, so the rewrite is intended.
 * The lease still refuses if origin moved past what pup itself last pushed, and
 * it only applies once a remote-tracking ref exists — on the first push there
 * is nothing to lease against.
 *
 * Naming the URL is not enough on its own: git rewrites a literal URL through
 * `url.<base>.insteadOf` and `pushInsteadOf` exactly as it rewrites a remote's,
 * and a `-c` rewrite of our own loses the tie to a session's that matches the
 * whole URL. So the push runs from an empty scratch git dir borrowing the
 * repo's objects: the shared config is never read, while the operator's global
 * and system config still apply (decision 54). Pushing to a URL updates no
 * remote-tracking ref, so the lease names its value and the ref is moved here.
 */
function pushBranch(repoPath: string, originUrl: string, branch: string, tip: string): void {
  const tracking = `refs/remotes/origin/${branch}`;
  const leased = (() => {
    try {
      // A missing remote-tracking ref is the expected first-push case, not an
      // error: git's stderr is captured here (not inherited) so its "fatal:
      // Needed a single revision" doesn't reach the operator console.
      return runGit(repoPath, ['rev-parse', '--verify', tracking], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return undefined;
    }
  })();
  withScratchGitDir(repoPath, 'pup-push-', (git) => {
    // Unlike the other git calls here this gets a timeout: a stalled push would
    // otherwise hang while holding the merge lock. Hooks are off for the same
    // reason they are everywhere else in the gate (decision 28).
    git(
      [
        'push',
        ...(leased ? [`--force-with-lease=refs/heads/${branch}:${leased}`] : []),
        originUrl,
        `${tip}:refs/heads/${branch}`,
      ],
      { timeout: GATE_COMMAND_TIMEOUT_MS },
    );
  });
  // `--no-deref`, like the gate's other ref writes: a tracking ref a session
  // turned into a symref must not move the branch it points at.
  runGit(repoPath, ['update-ref', '--no-deref', tracking, tip]);
}

/**
 * Run `fn` against an empty bare scratch git dir that borrows `repoPath`'s
 * object store, removed afterwards: git there never reads the shared config a
 * session can write, while the operator's global and system config still apply
 * (decision 54). `fn`'s runner is `--git-dir` the scratch dir, with
 * `GIT_OBJECT_DIRECTORY` set, so what it writes lands in the repo's objects.
 * Auto maintenance is off: a fetch run here would otherwise gc the repo's
 * object store by reachability from the scratch dir's two refs alone.
 */
export function withScratchGitDir<TResult>(
  repoPath: string,
  prefix: string,
  fn: (git: (args: string[], opts?: Parameters<typeof runGit>[2]) => string) => TResult,
): TResult {
  const objects = runGit(repoPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'objects',
  ]).trim();
  const scratch = mkdtempSync(join(tmpdir(), prefix));
  try {
    runGit(scratch, ['init', '--quiet', '--bare', '--template=']);
    return fn((args, opts = {}) =>
      runGit(
        scratch,
        [
          '-c',
          'gc.auto=0',
          '-c',
          'maintenance.auto=false',
          // A commit graph written from this dir's reachability is a stale
          // cache in the repo's objects/info; the ext protocol is decided
          // here and not by the operator's global config.
          '-c',
          'fetch.writeCommitGraph=false',
          '-c',
          'protocol.ext.allow=never',
          '--git-dir',
          scratch,
          ...args,
        ],
        {
          ...opts,
          env: { ...opts.env, GIT_OBJECT_DIRECTORY: objects },
        },
      ),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function prTitle(goal: string): string {
  const line = (goal.split('\n')[0] as string).trim();
  return line.length <= PR_TITLE_MAX_CHARS ? line : `${line.slice(0, PR_TITLE_MAX_CHARS - 1)}…`;
}

function prBody(spec: TaskSpec, report: GateReport, commitSubjects: string[], sha: string): string {
  // Commit subjects and gate details quote session-authored text. Fenced so
  // GitHub renders it inert — no `Closes #n` auto-closing, no @mention pings,
  // no invisible HTML comments aimed at review bots.
  return [
    '## Goal',
    '',
    spec.goal,
    '',
    '## Acceptance',
    '',
    ...spec.acceptance.map((item) => `- ${item}`),
    '',
    '## Commits',
    '',
    '````',
    ...commitSubjects,
    '````',
    '',
    '## Gate report',
    '',
    // What the report answers for: GitHub can move the head after the gate
    // read it back (decision 82).
    `Gated commit: ${sha}`,
    '',
    '````',
    formatGateReport(report),
    '````',
  ].join('\n');
}

/**
 * A refusal after `--accept-debt` filed its ledger entries, saying they stay.
 * They are not rolled back: a retry re-runs the gate with the same flags and
 * files none twice, and the entries name this session (decision 82). The
 * message is extended in place so the refusal keeps its type.
 */
function withLedgerKept(error: unknown, kept: number): unknown {
  if (kept > 0 && error instanceof Error) {
    const [subject, pronoun] =
      kept === 1
        ? ['The accepted-debt ledger entry was', 'it']
        : [`All ${kept} accepted-debt ledger entries were`, 'them'];
    error.message += `\n${subject} kept for the retry, which will not file ${pronoun} twice; this session is not merged.`;
  }
  return error;
}

function rejectOrBlock(db: Database, report: GateReport): MergeOutcome {
  const rejectCount = incrementRejectCount(db, report.sessionId);
  transitionSession(db, report.sessionId, 'rejected', { report });
  if (rejectCount > MAX_REJECTS_BEFORE_BLOCKED) {
    transitionSession(db, report.sessionId, 'blocked', {
      reason: `reject cap of ${MAX_REJECTS_BEFORE_BLOCKED} reached`,
      rejectCount,
    });
    return { status: 'blocked', report, rejectCount };
  }
  try {
    steerSession(db, report.sessionId, formatGateReport(report));
  } catch (error) {
    // Two different sessions to walk up to, so two different reasons. A
    // refused paste (decision 45) leaves a live pane with an empty box and an
    // agent still working from its last turn; everything else — a gone
    // window, no pane recorded — leaves nothing to type into at all. The
    // error's own message names the session, the length and which of the two
    // refusals it was, which is what the human needs before deciding.
    transitionSession(db, report.sessionId, 'blocked', {
      reason:
        error instanceof SteerNotDeliveredError
          ? error.message
          : 're-steer failed — session unreachable',
      rejectCount,
    });
    return { status: 'blocked', report, rejectCount };
  }
  appendEvent(db, report.sessionId, 'steer', { kind: 'gate-rejection' });
  transitionSession(db, report.sessionId, 'running', { kind: 'gate-rejection-resteer' });
  return { status: 'rejected', report, rejectCount };
}
