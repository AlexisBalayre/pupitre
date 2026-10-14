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
  runGit,
} from './git-diff.client.js';
import {
  assertGhAvailable,
  assertPullRequestHead,
  createPullRequest,
  findOpenPullRequest,
  originRepoSlug,
  rewritePullRequest,
} from './github.client.js';
import { readOriginUrl } from './init.service.js';
import { hasOpenLedgerEntry, insertLedgerEntry, listLedgerEntries } from './ledger.repository.js';
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
  getProject,
  getSession,
  getTask,
  incrementRejectCount,
  readTaskSpec,
  type SessionRow,
  saveProjectBaseline,
  transitionSession,
} from './session.repository.js';
import { steerSession } from './session-lifecycle.service.js';
import type { PullRequestRef } from './types/github.types.js';
import type { ProjectBaseline } from './types/init.types.js';
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
  } catch {
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

function commandFailureDetail(error: unknown): string {
  const failure = error as { stdout?: string; stderr?: string; message?: string };
  const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
  // Plain before the tail is taken, never after: the cut would otherwise land
  // mid-escape and leave its parameters as text, and a coloured runner spends
  // much of the budget on bytes nobody reads.
  return plainDetail(output || (failure.message ?? 'command failed')).slice(
    -GATE_OUTPUT_TAIL_CHARS,
  );
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

export function withMergeLock<TResult>(repoPath: string, fn: () => TResult): TResult {
  const lockPath = join(repoPath, '.git', MERGE_LOCK_DIRNAME);
  try {
    mkdirSync(lockPath);
  } catch {
    throw new MergeLockHeldError(lockPath);
  }
  try {
    return fn();
  } finally {
    rmdirSync(lockPath);
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
 * merge lock.
 */
export function runMergeGate(db: Database, req: MergeRequest): MergeOutcome {
  const session = getSession(db, req.sessionId);
  if (!session) throw new Error(`No session ${req.sessionId}.`);
  if (session.state !== 'awaiting-review') {
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
  // stages run while the session is alive (decision 80).
  assertNoArmedGitDrivers(req.repoPath);
  assertNoArmedGitDrivers(session.worktree_path);
  const target = currentBranch(req.repoPath);
  if (!target) {
    throw new Error(`Main worktree at ${req.repoPath} is not on a branch; cannot merge.`);
  }
  assertTargetName(req.repoPath, target);
  let pullRequest: PullRequestPlan | undefined;
  if (req.openPr) {
    assertGhAvailable();
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
    pullRequest = { ...ref, originUrl, adoptedUrl: findOpenPullRequest(req.repoPath, ref) };
  }
  return withMergeLock(req.repoPath, () => {
    // Not under the project's state dir beside the conductor's checkout: the
    // sandbox denies every gate child reads and writes under `~/.pupitre`,
    // which holds the store (decision 36). `mkdtemp` is private and unguessable;
    // resolved, because the sandbox matches resolved paths.
    const checkoutRoot = mkdtempSync(join(realpathSync(tmpdir()), 'pup-gate-checkout-'));
    try {
      return gateAndMerge(
        db,
        req,
        session,
        target,
        sandbox,
        join(checkoutRoot, 'checkout'),
        pullRequest,
      );
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
    } catch {
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
 * Delete `branchRef` only while it still names `sha`; false when it moved, and
 * it is kept. `--no-deref`: a branch turned into a symref after the pin must
 * not delete the branch it points at.
 */
export function deleteBranchAt(repoPath: string, branchRef: string, sha: string): boolean {
  try {
    runGit(repoPath, ['update-ref', '--no-deref', '-d', branchRef, sha], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
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
interface OriginUse {
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

  /** Runs one hard stage; false once it has recorded the failure. */
  const commandStage = (
    stage: string,
    command: { command: string; args: string[] },
    cwd: string,
  ): boolean => {
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
      stages.push({ stage, status: 'pass' });
      return true;
    } catch (error) {
      stages.push({ stage, status: 'fail', detail: commandFailureDetail(error) });
      return false;
    }
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
    if (!commandStage(stage, command, checkout)) return failed();
  }

  const flaggedDebt: { description: string; files: string[] }[] = [];
  const acceptHint =
    'Re-run with --accept-debt "<reason>" --review-by "<condition>", or steer the session to address it.';
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
        return failed();
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
    return failed();
  }
  stages.push({
    stage: 'scope-audit',
    status: 'pass',
    detail: `${changedPaths.length} files in scope`,
  });

  // Snapshot before any --accept-debt entry from THIS merge is written, so a
  // merge never flags its own fresh debt as closeable.
  const debtCandidates = listLedgerEntries(db, specRow.project_id)
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

  if (flaggedDebt.length > 0 && !req.acceptDebt) {
    const report: GateReport = { sessionId: session.id, passed: false, sandbox, stages };
    appendEvent(db, session.id, 'gate_result', { outcome: 'refused', report });
    return { status: 'refused', report, rejectCount: session.reject_count };
  }
  // Before the ledger write, not only before the checkout: a target moved while
  // the stages ran is the one under-lock refusal that can be settled this early,
  // and debt filed for a merge that then aborts reads as merged from this
  // session (decision 82). `fastForward` reads it again right before the
  // checkout, with the compare-and-swap as the backstop.
  if (!pullRequest) assertTargetAt(req.repoPath, target, targetSha);
  // Before the ledger write too: a session-written `log.date` can fail this,
  // and a failure after the write would leave entries filed with no kept note.
  const commitSubjects = runGit(req.repoPath, [
    'log',
    '--reverse',
    '--format=%s',
    `${targetSha}..${sha}`,
  ])
    .trim()
    .split('\n')
    .filter(Boolean);
  // What `--accept-debt` filed, for the refusals that must stay after it.
  let ledgerKept = 0;
  if (req.acceptDebt) {
    for (const flag of flaggedDebt) {
      const entry = {
        projectId: specRow.project_id,
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
      if (!hasOpenLedgerEntry(db, entry)) insertLedgerEntry(db, entry);
      ledgerKept += 1;
    }
  }

  const report: GateReport = { sessionId: session.id, passed: true, sandbox, stages };
  let prUrl: string | undefined;
  let prWasAdopted = false;
  if (pullRequest) {
    const newPr = {
      ...pullRequest,
      title: prTitle(spec.goal) || `pup session ${session.id}`,
      body: prBody(spec, report, commitSubjects, sha),
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
    isDeleted = deleteBranchAt(req.repoPath, branchRef, sha);
  } finally {
    // Counted only once the session is killed and its worktree gone, so no
    // commit can land after the count; recorded even if the teardown threw,
    // since the target already holds the pinned sha.
    const leftBehind = isDeleted ? 0 : commitsPastPin(req.repoPath, branchRef, sha);
    if (leftBehind > 0) {
      console.error(
        `${sanitizeReason(session.branch)} moved after the gate pinned ${sha}: ${leftBehind} ` +
          `later commit${leftBehind === 1 ? ' was' : 's were'} left behind on it, not merged.`,
      );
    }
    appendEvent(db, session.id, 'merge', {
      branch: session.branch,
      sha,
      target,
      files: changedPaths,
      ...(prUrl !== undefined ? { prUrl } : {}),
      ...(leftBehind > 0 ? { leftBehind } : {}),
    });
  }
  if (
    // In PR mode the target branch has not moved, so the bar must not either:
    // `pup land` ratchets it once the PR has (decisions 26, 84).
    !req.openPr &&
    project &&
    baseline &&
    Object.keys(judged.ratchet).length > 0
  ) {
    // Ratchet (docs/04): the merged state becomes the new bar. Accepted-debt merges
    // move it too — the accepted amount lives in the ledger, and re-flagging it would
    // punish later sessions for debt they didn't add.
    const next: ProjectBaseline = { ...baseline, debt: { ...baseline.debt, ...judged.ratchet } };
    saveProjectBaseline(
      db,
      specRow.project_id,
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
      runGit(scratch, ['--git-dir', scratch, ...args], {
        ...opts,
        env: { ...opts.env, GIT_OBJECT_DIRECTORY: objects },
      }),
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
