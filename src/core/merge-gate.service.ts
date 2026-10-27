import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  failureSummary,
  formatDuration,
  localContext,
  readPlainFile,
  sanitizeReason,
} from '../adapters/capability.utils.js';
import type {
  CapabilityContext,
  CapabilityUnavailable,
  CoverageReport,
  FileComplexity,
  GateStage,
  NestedPackage,
} from '../adapters/types/adapter.types.js';
import {
  killSession as killTmux,
  SteerNotDeliveredError,
} from '../claude/session-runtime.service.js';
import { patchCoverage } from './coverage.utils.js';
import { judgeDebt, measureCoverage, measureStaticDebt, quotePath } from './debt.service.js';
import { draftDecisionRecord } from './decision-record.service.js';
import { answerFixRoundThreads } from './fix-round.service.js';
import {
  ArmedGitDriverError,
  armedGitDrivers,
  assertNoArmedGitDrivers,
  checkoutPinned,
  currentBranch,
  gitDiffAddedLines,
  gitDiffBinaryRecount,
  gitDiffNumstat,
  gitDiffPaths,
  rethrowIfKilled,
  runGit,
  verifiedWorktreeGitEnv,
  type WorktreeGitEnv,
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
import {
  hasOpenLedgerEntry,
  insertLedgerEntry,
  type LedgerEntryRow,
  listLedgerEntries,
} from './ledger.repository.js';
import {
  DEBT_DETAIL_SAMPLES,
  DIFF_SIZE_DOCS_DIR,
  DIFF_SIZE_DOCS_EXTENSIONS,
  DIFF_SIZE_FLAG_LINES,
  DIFF_SIZE_TEST_SUFFIX,
  GATE_COMMAND_TIMEOUT_MS,
  GATE_ENVIRONMENT_DIR,
  GATE_OUTPUT_TAIL_CHARS,
  LOCKFILE_NAMES,
  MAX_REJECTS_BEFORE_BLOCKED,
  MERGE_LOCK_DIRNAME,
  PR_TITLE_MAX_CHARS,
} from './merge-gate.constants.js';
import { MergeLockHeldError, SessionNotReviewableError } from './merge-gate.errors.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { mergeToRegate, planRegate, type RegatePlan, regateMerged } from './regate.service.js';
import {
  endSandboxRun,
  GateInterruptedError,
  removeGateDir,
  runGateChild,
  sandboxLabel,
} from './sandbox.utils.js';
import { auditScope } from './scope-audit.utils.js';
import {
  appendEvent,
  currentFixRound,
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
import {
  describeSlotWait,
  GATE_SLOT_WAIT_MS,
  SlotWaitInterruptedError,
  withTestSlot,
} from './test-slot.service.js';
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
export function plainDetail(detail: string): string {
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

/** A changed path's new mode, and the path it was renamed from if git paired one. */
interface RawDiffEntry {
  mode: string;
  renamedFrom?: string;
}

/**
 * The branch diff's `--raw` entries by new path. `-M` is passed rather than
 * left to `diff.renames`, which sits in the shared config a session can write,
 * so a rename onto a test name is paired whatever that config says.
 */
function rawDiffEntries(
  repoPath: string,
  target: string,
  branch: string,
): Map<string, RawDiffEntry> {
  const fields = runGit(repoPath, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '-z',
    '--raw',
    '-M',
    `${target}...${branch}`,
  ]).split('\0');
  const entries = new Map<string, RawDiffEntry>();
  for (let i = 0; i < fields.length; i++) {
    const header = fields[i];
    if (!header?.startsWith(':')) continue;
    // ":<old mode> <new mode> <old sha> <new sha> <status>", then one path, or
    // the old and the new path for a rename or copy.
    const [, mode = '', , , status = ''] = header.slice(1).split(' ');
    if (/^[RC]/.test(status)) {
      const from = fields[i + 1] ?? '';
      const to = fields[i + 2] ?? '';
      entries.set(to, status.startsWith('R') ? { mode, renamedFrom: from } : { mode });
      i += 2;
    } else {
      entries.set(fields[i + 1] ?? '', { mode });
      i += 1;
    }
  }
  return entries;
}

/**
 * Which part of the diff-size split a changed path counts toward (decision
 * 107). A symlink is source wherever it sits, as it can point anywhere; a test
 * is only the trusted suffix, and never a file renamed onto it from a name
 * that was not one, which would carry production code in under the test count.
 */
function diffSizeKind(path: string, entry: RawDiffEntry | undefined): 'source' | 'test' | 'docs' {
  if (entry?.mode === '120000') return 'source';
  if (
    path.startsWith(DIFF_SIZE_DOCS_DIR) &&
    DIFF_SIZE_DOCS_EXTENSIONS.some((extension) => path.endsWith(extension))
  ) {
    return 'docs';
  }
  const isTest = (candidate: string): boolean => candidate.endsWith(DIFF_SIZE_TEST_SUFFIX);
  if (isTest(path) && (entry?.renamedFrom === undefined || isTest(entry.renamedFrom))) {
    return 'test';
  }
  return 'source';
}

/**
 * Adds + deletes across the branch diff, excluding lockfiles and binary files,
 * split into source, test files and prose under `docs/` (decision 107). A null numstat is
 * a measurement, not a skip: a file git reports as binary whose content is
 * text is recounted from its patch and named in `forged`, because git was told
 * to call it binary by something no diff shows (decision 53).
 */
export function countChangedLines(
  repoPath: string,
  target: string,
  branch: string,
): { source: number; test: number; docs: number; forged: string[] } {
  const counts = { source: 0, test: 0, docs: 0 };
  const forged: string[] = [];
  const raw = rawDiffEntries(repoPath, target, branch);
  for (const stat of gitDiffNumstat(repoPath, target, branch)) {
    if (LOCKFILE_NAMES.includes(stat.path)) continue;
    const kind = diffSizeKind(stat.path, raw.get(stat.path));
    if (stat.added !== null && stat.deleted !== null) {
      counts[kind] += stat.added + stat.deleted;
      continue;
    }
    const recount = gitDiffBinaryRecount(repoPath, target, branch, stat.path);
    if (!recount) continue;
    counts[kind] += recount.added + recount.deleted;
    forged.push(stat.path);
  }
  return { ...counts, forged };
}

/** Inside the merge lock's directory: the holder's pid, which a later run reads (decision 88). */
const MERGE_LOCK_PID_FILE = 'pid';

const MERGE_LOCK_POLL_MS = 1000;

/**
 * How long a lock with no pid is looked at again before it is refused. A taker
 * writes its pid in the same tick as its `mkdir`, so a lock still without one
 * after this never gets one (decision 88).
 */
const MERGE_LOCK_PID_GRACE_MS = 1000;

const MERGE_LOCK_PID_POLL_MS = 100;

/** A reclaim is a few syscalls: a reclaim lock older than this was stranded mid-way. */
const RECLAIM_STALE_MS = 10_000;

/** What node outlives while it holds the merge lock: the interrupts `runGateChild` forwards. */
const LOCK_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const LOAD_POLL_MS = 5000;

/**
 * The longest `pup merge` and `pup land` wait for a merge lock a live process
 * holds before refusing (decision 88): what a gate with one suite can hold it
 * for, its build, its test run and that run's one re-run each bounded by a
 * stage's timeout, plus its slot wait and its load wait. Each nested package's
 * suite adds a stage of its own, so a gate over a repo with them can outlast
 * this, and the waiter then refuses rather than wait on.
 */
export const MERGE_LOCK_WAIT_MS = 3 * GATE_COMMAND_TIMEOUT_MS + 2 * GATE_SLOT_WAIT_MS;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether `pid` is a live process. EPERM is one another user runs, alive all
 * the same: a lock it holds is not stale, and reclaiming it would let two
 * merges run at once.
 */
function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The pid a held merge lock records; undefined when there is none to read: a
 * lock an earlier pup took, one made by hand, a lock path that is not a real
 * directory, or a pid file that is not a regular file holding a positive whole
 * number. A fifo is never opened to block on, nor a link followed.
 */
function mergeLockHolder(lockPath: string): number | undefined {
  if (!lstatSync(lockPath, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  let text: string;
  try {
    text = readPlainFile(join(lockPath, MERGE_LOCK_PID_FILE), { followLinks: false });
  } catch {
    return undefined;
  }
  if (!/^[1-9]\d*\n?$/.test(text)) return undefined;
  const pid = Number(text);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

/** Which directory a lock is, so a later step can tell it from one swapped in for it. */
interface LockIdentity {
  dev: number;
  ino: number;
}

/** `path`'s identity when it is a real directory, never a link to one; undefined otherwise. */
function directoryIdentity(path: string): LockIdentity | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isDirectory() ? { dev: stat.dev, ino: stat.ino } : undefined;
}

/**
 * Remove a lock directory and the pid in it, and nothing else: it sits in the
 * `.git` a session can write, so anything else found there is left and named
 * rather than removed with it, and so is a directory that is no longer
 * `identity`, a link or another directory a session swapped in, whose pid
 * could be another lock's (decision 88).
 */
function removeLockDir(dir: string, identity: LockIdentity): void {
  const now = directoryIdentity(dir);
  if (now?.dev !== identity.dev || now.ino !== identity.ino) {
    console.error(
      `${dir} is no longer the lock directory pup made, so it was left as it is. Treat a ` +
        'session that replaced it as compromised.',
    );
    return;
  }
  try {
    rmSync(join(dir, MERGE_LOCK_PID_FILE), { force: true });
    rmdirSync(dir);
  } catch (error) {
    console.error(
      `Could not remove ${dir}: ${failureSummary(error)}. No run reads it; remove it from the ` +
        'trusted checkout.',
    );
  }
}

/**
 * Move the lock directory aside under a fresh name, then remove it there, so
 * no reader ever finds the lock without its pid. A removal that fails leaves
 * only the aside directory, which no reader looks at.
 */
function dropMergeLock(
  lockPath: string,
  why: 'released' | 'reclaimed',
  identity: LockIdentity,
): void {
  const aside = `${lockPath}.${why}-${randomBytes(8).toString('hex')}`;
  renameSync(lockPath, aside);
  removeLockDir(aside, identity);
}

/** Make `dir`; false when it already exists or cannot be made. */
function makeDir(dir: string): boolean {
  try {
    mkdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a lock whose holder `dead` died without releasing it: a SIGKILL, a
 * crash, a power cut. Under a second lock of its own, so two runs that both
 * read the dead pid cannot both reclaim, the second removing the lock the
 * first took in between; under it the pid is read again. A reclaim lock older
 * than `RECLAIM_STALE_MS`, or dated in the future, was stranded by a run
 * killed mid-reclaim or planted, and is replaced. Answers false when another run is reclaiming, and the caller
 * treats the lock as held; a lock that cannot be moved aside throws.
 */
function reclaimMergeLock(lockPath: string, dead: number): boolean {
  const reclaiming = `${lockPath}.reclaim`;
  if (!makeDir(reclaiming)) {
    const stat = lstatSync(reclaiming, { throwIfNoEntry: false });
    const age = stat ? Date.now() - stat.mtimeMs : 0;
    if (!stat?.isDirectory() || (age >= 0 && age < RECLAIM_STALE_MS)) return false;
    try {
      rmdirSync(reclaiming);
    } catch {
      return false;
    }
    if (!makeDir(reclaiming)) return false;
  }
  try {
    const identity = directoryIdentity(lockPath);
    if (identity && mergeLockHolder(lockPath) === dead) {
      dropMergeLock(lockPath, 'reclaimed', identity);
    }
    return true;
  } finally {
    try {
      rmdirSync(reclaiming);
    } catch {
      // Left for the next reclaim, which replaces it once it is stale.
    }
  }
}

/**
 * Try the merge lock once: a directory, which only one `mkdir` can make,
 * holding the taker's pid. Answers the directory's identity once it is taken,
 * the pid holding it, or null for a lock with no pid to read; a lock whose pid
 * is dead is reclaimed and tried again, and a dead pid is answered only while
 * another run is reclaiming it (decision 88).
 */
function tryMergeLock(lockPath: string): LockIdentity | number | null {
  for (;;) {
    let failed: string | undefined;
    try {
      mkdirSync(lockPath);
    } catch (error) {
      failed = (error as NodeJS.ErrnoException).code ?? 'unknown';
    }
    if (failed === undefined) {
      // Made by this `mkdir`, but the path is in a `.git` a session can write:
      // every later step checks it is still this directory.
      const identity = directoryIdentity(lockPath);
      if (!identity) return null;
      try {
        writeFileSync(join(lockPath, MERGE_LOCK_PID_FILE), `${process.pid}\n`, { flag: 'wx' });
      } catch (error) {
        // Taken but not recorded: undone, since a lock with no pid refuses every later run.
        removeLockDir(lockPath, identity);
        throw error;
      }
      const now = directoryIdentity(lockPath);
      if (now?.dev === identity.dev && now.ino === identity.ino) return identity;
      console.error(
        `${lockPath} was replaced while pup took it, so its pid may have been written through ` +
          'what replaced it; nothing was taken. Treat a session that replaced it as compromised.',
      );
      return null;
    }
    if (failed !== 'EEXIST') throw new MergeLockHeldError(lockPath);
    const holder = mergeLockHolder(lockPath);
    if (holder === undefined) {
      // Released between the mkdir and the read.
      if (!lstatSync(lockPath, { throwIfNoEntry: false })) continue;
      return null;
    }
    if (isLiveProcess(holder) || !reclaimMergeLock(lockPath, holder)) return holder;
  }
}

/**
 * The refusal for a lock with a pid, which must not tell the operator to
 * remove it: held by a live run, or by a dead one another run is reclaiming.
 */
function heldBy(lockPath: string, holder: number): MergeLockHeldError {
  const error = new MergeLockHeldError(lockPath);
  error.message = isLiveProcess(holder)
    ? `Another merge is in progress: pid ${holder} holds the lock at ${lockPath}. Do not ` +
      'remove it; retry once that run ends.'
    : `pid ${holder}, which held the lock at ${lockPath}, is gone, and another run is ` +
      `reclaiming it (${lockPath}.reclaim). Do not remove either; retry in a moment.`;
  return error;
}

/**
 * Run `fn` holding the merge lock, with node kept alive through a signal while
 * it does. A terminal Ctrl-C reaches node and a child git alike, and closing
 * the terminal sends both a SIGHUP: with no listener node's default
 * disposition dies mid-call and the `finally` never removes the lock; with
 * one, only the child dies, its failure unwinds the stack and the lock goes. A
 * gate stage's child is in a process group of its own, out of the terminal's
 * reach: `runGateChild` forwards the signal to it and rejects once it has
 * exited, which unwinds the same way (decision 95). A signal that arrives while
 * neither runs, during pup's own synchronous work, is discarded by this
 * listener, and the locked section runs on. Outside the lock node's default
 * applies again. A lock a SIGKILL or a crash strands is reclaimed by the next
 * run, and one a live run holds is waited for up to `maxWaitMs`, printing one
 * line when the wait starts, and by default not at all (decision 88). `fn` is
 * told whether the take waited: anything read before the wait may have changed
 * under the run that held the lock meanwhile.
 */
export async function withMergeLock<TResult>(
  repoPath: string,
  fn: (waited: boolean) => TResult | Promise<TResult>,
  maxWaitMs = 0,
): Promise<TResult> {
  const lockPath = join(repoPath, '.git', MERGE_LOCK_DIRNAME);
  const deadline = Date.now() + maxWaitMs;
  let waited = false;
  let announced = false;
  /** When the lock was first found with no pid to read. */
  let pidless: number | undefined;
  // Waited for with node's default disposition, so a Ctrl-C ends the wait;
  // the listeners go on in the same tick as the take, leaving no turn of the
  // event loop between them.
  let identity: LockIdentity | undefined;
  for (;;) {
    const holder = tryMergeLock(lockPath);
    if (holder !== null && typeof holder === 'object') {
      identity = holder;
      break;
    }
    const now = Date.now();
    const left = deadline - now;
    if (holder === null) {
      pidless ??= now;
      if (left <= 0 || now - pidless >= MERGE_LOCK_PID_GRACE_MS) {
        throw new MergeLockHeldError(lockPath);
      }
      waited = true;
      await sleep(Math.min(MERGE_LOCK_PID_POLL_MS, left));
      continue;
    }
    pidless = undefined;
    if (left <= 0) throw heldBy(lockPath, holder);
    if (!announced) {
      announced = true;
      console.error(
        `Waiting for the merge lock, held by pid ${holder}, for up to ${formatDuration(left)}.`,
      );
    }
    waited = true;
    await sleep(Math.min(MERGE_LOCK_POLL_MS, left));
  }
  const stayAlive = (): void => undefined;
  for (const signal of LOCK_SIGNALS) process.on(signal, stayAlive);
  try {
    return await fn(waited);
  } finally {
    // The lock goes first: a signal between the two would otherwise meet
    // node's default disposition with the lock still on disk.
    try {
      dropMergeLock(lockPath, 'released', identity);
    } finally {
      for (const signal of LOCK_SIGNALS) process.off(signal, stayAlive);
    }
  }
}

/** `result` with the wall time since `started`, which the report prints (decision 95). */
export function timedSince(started: number, result: GateStageResult): GateStageResult {
  return { ...result, durationMs: Date.now() - started };
}

function formatGateReport(report: GateReport): string {
  const lines = report.stages.map(
    (s) =>
      `- ${s.stage}: ${s.status.toUpperCase()}` +
      `${s.durationMs !== undefined ? ` (${formatDuration(s.durationMs)})` : ''}` +
      `${s.detail ? ` — ${s.detail}` : ''}`,
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
 * `pup merge`: fresh-base check with mechanical auto-rebase (decision 8), or a
 * merge of the target for a branch an open PR holds (decision 105), then the
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
export async function runMergeGate(db: Database, req: MergeRequest): Promise<MergeOutcome> {
  const planned = planMerge(db, req);
  // The operator's and the conductor's runs wait for a live holder (decision 88).
  return withMergeLock(
    req.repoPath,
    async (waited) => {
      // A run that held the lock before this one, a live one waited for or a
      // dead one reclaimed or one released during the gh calls, may have
      // merged, rejected or re-gated this session, or opened its fix round, and
      // a driver may have been armed during a wait: planned again under the
      // lock, as a run started now would be (decision 88).
      const { session, sandbox, target, pullRequest, regate } =
        waited || sessionMark(db, req.sessionId) !== planned.mark ? planMerge(db, req) : planned;
      // Not under the project's state dir beside the conductor's checkout: the
      // sandbox denies every gate child reads and writes under `~/.pupitre`,
      // which holds the store (decision 36). `mkdtemp` is private and unguessable;
      // resolved, because the sandbox matches resolved paths.
      const checkoutRoot = mkdtempSync(join(realpathSync(tmpdir()), 'pup-gate-checkout-'));
      try {
        // Named after its root, so the admin dir `worktree add` names after it is
        // this gate's alone: as `checkout` it took `checkout1` whenever the
        // conductor's checkout held `checkout`, a name the pins cannot predict.
        const checkoutDir = join(checkoutRoot, basename(checkoutRoot));
        return await (regate
          ? regateMerged(db, req, session, regate, target, sandbox, checkoutDir)
          : gateAndMerge(db, req, session, target, sandbox, checkoutDir, pullRequest));
      } finally {
        // Still under the lock, on a pass, a failed stage and a throw alike, and
        // before this process goes on to anything else (decision 100).
        endSandboxRun();
        // Swallowed: a cleanup failure must not replace the gate's outcome or
        // its error, and the registration goes with the next gate's prune once
        // the directory is gone.
        try {
          dropGateCheckout(req.repoPath, checkoutRoot);
        } catch {
          // see above
        }
      }
    },
    req.wait ? MERGE_LOCK_WAIT_MS : 0,
  );
}

/** What `planMerge` settled before the lock, for the run under it. */
interface MergePlan {
  session: SessionRow;
  /** `sessionMark` before the plan read anything. */
  mark: string;
  sandbox: string;
  target: string;
  pullRequest?: PullRequestPlan;
  regate?: RegatePlan;
}

/**
 * Every refusal `runMergeGate` makes before it takes the lock, and what they
 * settle: the session's state, the sandbox, the drivers, the target, and with
 * `--pr` everything GitHub can refuse.
 */
function planMerge(db: Database, req: MergeRequest): MergePlan {
  // First, so a change another run makes while the plan reads git and GitHub
  // differs from it under the lock.
  const mark = sessionMark(db, req.sessionId);
  const session = getSession(db, req.sessionId);
  if (!session) throw new Error(`No session ${req.sessionId}.`);
  const merged =
    session.state === 'merged' && req.openPr ? mergeToRegate(db, session.id) : undefined;
  if (session.state !== 'awaiting-review' && !merged) {
    throw new SessionNotReviewableError(req.sessionId, session.state);
  }
  // A plain merge would fast-forward the round's commits locally and record a
  // merge with no PR, while the PR the round answers stays behind (decision 90).
  if (!req.openPr && currentFixRound(db, session.id) !== undefined) {
    throw new Error(
      `Session ${session.id} is in a CI fix round; its commits go back to its open PR. ` +
        `Run \`pup merge ${session.id} --pr\`.`,
    );
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
  // Before the auto-rebase or merge, which runs a smudge filter on every file it
  // checks out and a merge driver on every conflict, with the operator's environment
  // and ahead of the sandbox that confines the stages. Both paths, because the
  // rebase runs in the worktree and the fast-forward's checkout in the main
  // one, and a worktree-scoped config is only visible from its own worktree
  // (decision 50). The main checkout is asked again under the lock, since the
  // stages run while the session is alive (decision 80), and both are asked
  // again right before an open PR's merge runs git (decision 105). A re-gate
  // rebases nothing and its worktree is gone with the first merge. The worktree
  // is read pinned to the dirs pup trusts, as the rebase will run (decision 101).
  assertNoArmedGitDrivers(req.repoPath);
  if (!merged) {
    assertNoArmedGitDrivers(
      session.worktree_path,
      verifiedWorktreeGitEnv(req.repoPath, session.worktree_path),
    );
  }
  const target = currentBranch(req.repoPath);
  if (!target) {
    throw new Error(`Main worktree at ${req.repoPath} is not on a branch; cannot merge.`);
  }
  assertTargetName(req.repoPath, target);
  let pullRequest: PullRequestPlan | undefined;
  let regate: RegatePlan | undefined;
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
    if (merged) regate = planRegate(req.repoPath, session.id, merged, ref, originUrl);
    else pullRequest = { ...ref, originUrl, adoptedUrl: findOpenPullRequest(req.repoPath, ref) };
  }
  return { session, mark, sandbox, target, pullRequest, regate };
}

/**
 * What another run's gate, fix round or land changes about a session: its
 * state, its rejections and its newest event (decision 88).
 */
function sessionMark(db: Database, sessionId: string): string {
  const session = getSession(db, sessionId);
  return JSON.stringify([
    session?.state,
    session?.reject_count,
    listEvents(db, sessionId).at(-1)?.id,
  ]);
}

/**
 * Cut the gate's private detached checkout of the pinned sha, which every
 * stage and debt capability then reads instead of the session's worktree, whose
 * files the live session can edit while they run (decision 81). Detached like
 * the conductor's checkout (decision 51), but cut fresh under the lock and
 * dropped before it is released, since it must hold the one sha this gate lands.
 *
 * `--no-checkout` then a `read-tree` of our own, for the reasons `fastForward`
 * gives: `--no-sparse-checkout`, because a planted `core.sparseCheckout` would
 * leave out committed files no stage would then see. The checkout runs a
 * smudge filter on every file it writes, so the drivers are checked again
 * right before it, as they are before the fast-forward.
 *
 * Its git after the add runs pinned to the dirs pup trusts, checked first
 * (decision 101): the admin dir sits under `<common>/worktrees/` beside the
 * sessions' own, and a session can rewrite its `commondir` from inside the
 * sandbox in the moment between the add and the read, or plant
 * `config.worktree` there. `GIT_WORK_TREE` also does what `--work-tree` did,
 * outranking a `core.worktree` in the shared config that would aim the writes
 * elsewhere.
 */
function cutGateCheckout(repoPath: string, dir: string, sha: string): void {
  assertNoArmedGitDrivers(repoPath);
  runGit(repoPath, ['worktree', 'add', '--detach', '--no-checkout', dir, sha]);
  refuseEscapingLinks(dir, sha, checkoutPinned(repoPath, dir, sha));
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
function refuseEscapingLinks(checkout: string, sha: string, git: WorktreeGitEnv): void {
  const inside = realpathSync(checkout);
  const entries = runGit(checkout, ['ls-tree', '-r', '-z', sha], { env: { ...git } })
    .split('\0')
    .filter(Boolean);
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
 * Remove the gate's checkout and its registration. A plain removal rather than
 * `worktree remove`, which refuses a checkout that was never cut; the prune
 * then drops the registration, and only registrations whose directory is gone.
 * A directory that cannot go is reported, not thrown (decision 95).
 */
function dropGateCheckout(repoPath: string, root: string): void {
  removeGateDir(root);
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
 * `resolveCommit`, undefined when `ref` names no commit. A symbolic ref keeps
 * its own refusal, which names the compromise, and a killed git its signal.
 */
export function resolveCommitIfPresent(repoPath: string, ref: string): string | undefined {
  try {
    return resolveCommit(repoPath, ref);
  } catch (error) {
    rethrowIfKilled(error);
    if (error instanceof Error && error.message.includes('symbolic ref')) throw error;
    return undefined;
  }
}

/**
 * Refuse unless `target` still names `targetSha`, the only commit the
 * fast-forward's compare-and-swap will move it from. A deleted target reads as
 * moved to nowhere, not as a stack.
 */
function assertTargetAt(repoPath: string, target: string, targetSha: string): void {
  const now = resolveCommitIfPresent(repoPath, `refs/heads/${target}`) ?? 'nowhere';
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

export interface PullRequestPlan extends PullRequestRef {
  /** The push target recorded at setup; the push goes here literally (decision 56). */
  originUrl: string;
  /** Set when an open PR for this branch already exists and passed adoption checks. */
  adoptedUrl?: string;
}

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
 * Refuse a row whose worktree or branch is not the one the launch minted for
 * the session. The row is store text, and what it names is handed to git: the
 * id's shape first, so no `..` in it can reach a sibling (decision 84).
 */
export function assertMintedRow(repoPath: string, session: SessionRow, untouched: string): void {
  if (
    !SESSION_ID_PATTERN.test(session.id) ||
    session.worktree_path !== join(repoPath, '.worktrees', session.id) ||
    session.branch !== `pup/${session.id}`
  ) {
    throw new Error(
      `Session ${sanitizeReason(session.id)}'s row names a worktree or branch that is not its ` +
        `own; inspect the store. ${untouched}`,
    );
  }
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

/**
 * Merge `targetSha` into the branch an open PR holds, in plumbing only
 * (decision 105): `merge-tree` writes the merged tree, `commit-tree` the merge
 * commit, and a compare-and-swap moves the branch from the tip the merge read.
 * The porcelain `git merge` reads `branch.<name>.mergeOptions` from the shared
 * config a session can write, after the `-c` pins and before argv, so a planted
 * `-S` would run a `gpg.program` of the session's and `-F` would read any file
 * into the message; nothing here reads per-branch config, as the fast-forward
 * reads none (decision 80). The worktree's index and files follow with the
 * pinned two-way `read-tree` the fast-forward uses, only while its HEAD is the
 * branch: a worktree the session switched elsewhere is left as it is, and one
 * where the `read-tree` fails has the branch put back. The drivers are checked
 * again right before `merge-tree`, which runs a merge driver on a conflicted
 * file, and before the `read-tree`, which runs a smudge filter on every file it
 * writes, as they are before the fast-forward: the last check ran before the gh
 * calls and the lock (decision 50). Returns the failure for the worker, or
 * undefined once the branch holds the merge.
 */
function mergeTargetInto(
  repoPath: string,
  worktree: string,
  worktreeEnv: WorktreeGitEnv,
  branch: string,
  target: string,
  targetSha: string,
): string | undefined {
  const branchRef = `refs/heads/${branch}`;
  const shown = sanitizeReason(target);
  const piped = { stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  const branchSha = resolveCommit(repoPath, branchRef);
  assertNoArmedGitDrivers(repoPath);
  let tree: string;
  try {
    tree = (
      runGit(repoPath, ['merge-tree', '--write-tree', branchSha, targetSha], piped).split(
        '\n',
      )[0] as string
    ).trim();
  } catch (error) {
    // 1 is a conflict. Any other status (a signal, no `--write-tree` before git
    // 2.38, a missing object) is git failing to merge at all, which no worker
    // can resolve: thrown to the operator, with only objects written.
    if ((error as { status?: unknown }).status !== 1) throw error;
    return (
      `Auto-merge of ${shown} hit conflicts. Run ` +
      `\`git merge ${shellWord(`refs/heads/${shown}`)}\`, ` +
      `resolve the conflicts, and commit the merge.\n${commandFailureDetail(error)}`
    );
  }
  const merged = runGit(
    repoPath,
    [
      'commit-tree',
      '--no-gpg-sign',
      '-p',
      branchSha,
      '-p',
      targetSha,
      '-m',
      `Merge ${target} into ${branch}`,
      tree,
    ],
    piped,
  ).trim();
  const worktreeGit = (args: string[]): string =>
    runGit(worktree, args, { env: { ...worktreeEnv }, ...piped });
  // A compare-and-swap: git refuses unless the branch is still at `from`.
  const swapBranch = (message: string, to: string, from: string): void => {
    runGit(repoPath, ['update-ref', '--no-deref', '-m', message, branchRef, to, from], piped);
  };
  // Read before the branch moves, so an interrupt here leaves nothing to put
  // back: only the read-tree step below runs while the branch holds the merge.
  let head: string | undefined;
  try {
    head = worktreeGit(['symbolic-ref', '-q', 'HEAD']).trim();
  } catch (error) {
    rethrowIfKilled(error);
  }
  try {
    swapBranch(`pup merge: merge ${target}`, merged, branchSha);
  } catch (error) {
    rethrowIfKilled(error);
    return (
      `${branch} moved from ${branchSha} while the gate merged ${shown} into it; nothing was ` +
      `merged.\n${commandFailureDetail(error)}`
    );
  }
  if (head !== branchRef) return undefined;
  try {
    // Before the refresh too, which runs a clean filter on every file whose
    // stat changed.
    assertNoArmedGitDrivers(worktree, worktreeEnv);
    worktreeGit(['update-index', '-q', '--ignore-submodules', '--refresh']);
    worktreeGit([
      'read-tree',
      '--no-recurse-submodules',
      '--no-sparse-checkout',
      '-m',
      '-u',
      branchSha,
      merged,
    ]);
  } catch (error) {
    // The branch goes back to the tip whose index the worktree still holds,
    // before anything else, an interrupt or an armed driver included. Left on
    // the merge, HEAD would sit over those files and status would show the
    // target's changes reversed, staged for the next commit to take.
    try {
      swapBranch(`pup merge: undo merge of ${target}`, branchSha, merged);
    } catch (undo) {
      // The operator's, as the fast-forward's failed restore is: what the
      // branch holds now is not something the gate can name.
      throw new Error(
        `The merge of ${shown} failed in ${worktree}, and putting ${branch} back from the ` +
          `merge ${merged} on ${branchSha} failed too:\n${commandFailureDetail(undo)}\n` +
          `While ${branch} holds the merge, a commit over this worktree's files undoes ` +
          `${shown}'s changes. The merge failed with:\n${commandFailureDetail(error)}`,
      );
    }
    if (error instanceof ArmedGitDriverError) throw error;
    rethrowIfKilled(error);
    // A refusal over a local change writes nothing, but a read-tree that
    // failed partway (a full disk, a permission) may have written files.
    return (
      `The merge of ${shown} failed in this worktree, and ${branch} is back on ${branchSha} ` +
      'without it. Any file git wrote before it stopped shows as a change in `git status`: ' +
      `discard those, commit or discard your own, and the next gate merges ${shown} again.\n` +
      commandFailureDetail(error)
    );
  }
  return undefined;
}

async function gateAndMerge(
  db: Database,
  req: MergeRequest,
  session: SessionRow,
  target: string,
  sandbox: string,
  checkoutDir: string,
  pullRequest?: PullRequestPlan,
): Promise<MergeOutcome> {
  const worktree = session.worktree_path;
  const stages: GateStageResult[] = [];
  const failed = (): MergeOutcome =>
    rejectOrBlock(db, { sessionId: session.id, passed: false, sandbox, stages });

  // Every git call in the worktree runs pinned to the admin and common dirs pup
  // trusts, checked again under the lock: the session can rewrite the pointers
  // that would otherwise pick the config, and so the filters, git runs
  // (decision 101). `--ignore-submodules=all`, because a gitlink in the index
  // over a `.git` of the session's makes status run a child git in it that
  // drops the pins.
  const worktreeEnv = verifiedWorktreeGitEnv(req.repoPath, worktree);
  const pinned = { env: { ...worktreeEnv } };
  let started = Date.now();
  const dirty = runGit(
    worktree,
    ['status', '--porcelain', '--ignore-submodules=all'],
    pinned,
  ).trim();
  if (dirty) {
    stages.push(
      timedSince(started, {
        stage: 'worktree-clean',
        status: 'fail',
        detail: `Uncommitted changes in the worktree:\n${dirty}`,
      }),
    );
    return failed();
  }
  stages.push(timedSince(started, { stage: 'worktree-clean', status: 'pass' }));

  // Both ends pinned under the lock, and every later git call names a sha
  // (decision 80): the target here, so the rebase or merge, the diffs and the
  // compare-and-swap all mean one commit; the branch once fresh-base settled
  // it, so what the diffs and the scope audit named is what lands, whatever the
  // live session commits or tags meanwhile. The stages read that sha's files
  // from the gate's own checkout (decision 81).
  const branchRef = `refs/heads/${session.branch}`;
  started = Date.now();
  const targetSha = resolveCommit(req.repoPath, `refs/heads/${target}`);
  // An open PR's commits are what its review and CI read, so its branch takes
  // the target as a merge commit and is never rewritten; a branch with no open
  // PR is still rebased (decision 105).
  const isPrBranch = pullRequest?.adoptedUrl !== undefined;
  // What the gate last pushed, which the merge keeps and a rewrite by the
  // session would drop: refused here, with the fix in the worker's hands,
  // rather than by the push once every stage has run.
  const pushed = isPrBranch
    ? resolveCommitIfPresent(req.repoPath, `refs/remotes/origin/${session.branch}`)
    : undefined;
  if (pushed && !isAncestor(req.repoPath, pushed, branchRef)) {
    stages.push(
      timedSince(started, {
        stage: 'fresh-base',
        status: 'fail',
        detail:
          `${session.branch} no longer contains ${pushed}, which its open PR holds. Bring those ` +
          `commits back (merge ${shellWord(`refs/heads/${sanitizeReason(target)}`)} rather ` +
          'than rebase onto it), then commit.',
      }),
    );
    return failed();
  }
  if (isAncestor(req.repoPath, targetSha, branchRef)) {
    stages.push(
      timedSince(started, {
        stage: 'fresh-base',
        status: 'pass',
        detail: `already based on ${target}`,
      }),
    );
  } else if (isPrBranch) {
    const refused = mergeTargetInto(
      req.repoPath,
      worktree,
      worktreeEnv,
      session.branch,
      target,
      targetSha,
    );
    if (refused) {
      stages.push(timedSince(started, { stage: 'fresh-base', status: 'fail', detail: refused }));
      return failed();
    }
    stages.push(
      timedSince(started, { stage: 'fresh-base', status: 'pass', detail: `auto-merged ${target}` }),
    );
  } else {
    try {
      runGit(worktree, ['rebase', targetSha], pinned);
      stages.push(
        timedSince(started, {
          stage: 'fresh-base',
          status: 'pass',
          detail: `auto-rebased onto ${target}`,
        }),
      );
    } catch (error) {
      try {
        runGit(worktree, ['rebase', '--abort'], pinned);
      } catch {
        // nothing to abort — the rebase never started
      }
      stages.push(
        timedSince(started, {
          stage: 'fresh-base',
          status: 'fail',
          detail:
            `Auto-rebase onto ${sanitizeReason(target)} hit conflicts. Run ` +
            `\`git rebase ${shellWord(`refs/heads/${sanitizeReason(target)}`)}\`, ` +
            `resolve the conflicts, and finish the rebase.\n${commandFailureDetail(error)}`,
        }),
      );
      return failed();
    }
  }
  const sha = resolveCommit(req.repoPath, branchRef);
  // The rebase moves whatever the worktree has checked out, so a session that
  // detached it or switched branch leaves the pinned branch behind the target:
  // no fast-forward, and the diffs would measure against the wrong base.
  if (!isAncestor(req.repoPath, targetSha, sha)) {
    const onto = `refs/heads/${sanitizeReason(target)}`;
    const [step, fix] = isPrBranch
      ? ['merge', `merge ${onto} into it`]
      : ['rebase', `rebase it onto ${onto}`];
    // Replaces the pass pushed above: one fresh-base line, not a pass then a fail.
    stages.pop();
    stages.push(
      timedSince(started, {
        stage: 'fresh-base',
        status: 'fail',
        detail:
          `${session.branch} at ${sha} is not based on ${sanitizeReason(target)} at ${targetSha} ` +
          `after the auto-${step}. Check out ${session.branch} in this worktree and ${fix}.`,
      }),
    );
    return failed();
  }

  const measured = await measureBranch(db, req, session, stages, checkoutDir, targetSha, sha);
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
      pushBranch(req.repoPath, pullRequest.originUrl, session.branch, sha, !pullRequest.adoptedUrl);
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
  let keptWorktree: string | undefined;
  try {
    // By pane as well as name: a rename from inside the session would leave
    // the name pointing at nothing while the window ran on (decision 46).
    killTmux(session.id, session.tmux_target);
    try {
      runGit(req.repoPath, ['worktree', 'remove', '--force', worktree]);
    } catch (error) {
      // A worktree the session locked, which one `--force` refuses, a gitfile
      // it rewrote, or an interrupt after the merge landed: kept and named in
      // the outcome rather than skip the ratchet and the draft (decision 88),
      // with git's own words, since only they tell a lock from a tampered
      // pointer. Its branch stays with it, since `update-ref -d` would pull the
      // checkout away.
      keptWorktree = worktree;
      console.error(
        `git worktree remove refused ${sanitizeReason(worktree)}: ${failureSummary(error)}`,
      );
    }
    // Deleted only while it still names the gated commit, in both modes: a
    // commit the session added after the pin was never measured, so it is left
    // on the branch for the operator rather than merged or thrown away.
    try {
      if (keptWorktree === undefined) isDeleted = deleteBranchAt(req.repoPath, branchRef, sha);
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
  // A merge that ended no fix round answers nothing (decision 90).
  if (pullRequest) {
    replyOnFixRoundThreads(db, req.repoPath, session.id, pullRequest, targetSha);
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
    ...(keptWorktree !== undefined ? { keptWorktree } : {}),
  };
}

/**
 * The replies a gated fix round owes its threads (decision 90), told in one
 * line. Never fatal: the PR already holds the pinned sha and the merge is
 * recorded, so a failing gh, or one past the answers' time budget under the
 * merge lock, costs the replies and the warning says so.
 */
function replyOnFixRoundThreads(
  db: Database,
  repoPath: string,
  sessionId: string,
  pullRequest: PullRequestPlan,
  targetSha: string,
): void {
  try {
    const answers = answerFixRoundThreads(db, repoPath, sessionId, pullRequest.repo, targetSha);
    if (answers === undefined) return;
    console.error(
      `Answered the fix round's threads on ${answers.prUrl}: ${answers.addressed} addressed and ` +
        `resolved, ${answers.unverified} answered fixed that pup could not verify, ` +
        `${answers.declined} declined, ${answers.unanswered} unanswered.`,
    );
  } catch (error) {
    rethrowIfKilled(error);
    // pup's own alarm, whole: the reason cap would cut its call to treat the
    // session as compromised.
    if (error instanceof ArmedGitDriverError) {
      console.error(`Answered none of the fix round's threads. ${error.message}`);
      return;
    }
    console.error(
      `Could not answer the fix round's threads on GitHub: ` +
        `${sanitizeReason(error instanceof Error ? error.message : String(error))}. Reply on ` +
        'and resolve them by hand.',
    );
  }
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
 * tell from a flake. Anything else fails at once. The operator's Ctrl-C never
 * gets here: pup forwards it to the stage child and the run rejects with
 * `GateInterruptedError`, which no stage catches (decision 95). An interrupt
 * from anywhere else is still not re-run, since a re-run that passed would turn
 * the abort into a merge: so a child a signal killed, a runner that caught the
 * interrupt (130, or pytest's 2), and a wrapper reporting a killed child (129,
 * 143) fail at once. So does a stage that ran out `GATE_COMMAND_TIMEOUT_MS`,
 * which `runGateChild` marks with a `code` even when the runner traps the
 * SIGTERM and exits 1, and whose re-run would hold the merge lock twice as long
 * on a hung suite.
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
 * Before the gate's tests, wait until the machine's 1-minute load average is
 * under its available parallelism (decision 88): a suite started on a machine
 * its workers already saturate runs into its stage timeout, and the gate fails
 * on the machine rather than the branch. Bounded as the slot wait is, since it
 * holds the merge lock, and once that runs out the tests run anyway. One line
 * says the wait started and one that it ran out. An interrupt ends it as a
 * stage child's would: no child runs to forward one to, and the lock keeps
 * node alive through it. A platform with no load average reads zeros and never
 * waits. `readLoad` and `ceiling` are the machine's unless a test passes its own.
 */
export async function waitForLoad(
  readLoad: () => number = () => loadavg()[0] ?? 0,
  ceiling = availableParallelism(),
): Promise<void> {
  let load = readLoad();
  if (load < ceiling) return;
  console.error(
    `The 1-minute load average is ${load.toFixed(1)}, not under ${ceiling}; the gate waits up to ` +
      `${formatDuration(GATE_SLOT_WAIT_MS)} for it to fall before its tests.`,
  );
  const deadline = Date.now() + GATE_SLOT_WAIT_MS;
  let interrupted: (typeof LOCK_SIGNALS)[number] | undefined;
  let wake: () => void = () => undefined;
  const onSignal = (signal: (typeof LOCK_SIGNALS)[number]): void => {
    interrupted = signal;
    wake();
  };
  for (const signal of LOCK_SIGNALS) process.on(signal, onSignal);
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        console.error(
          `The load average is still ${load.toFixed(1)} after ` +
            `${formatDuration(GATE_SLOT_WAIT_MS)}; the gate runs its tests anyway.`,
        );
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(LOAD_POLL_MS, left));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (interrupted) throw new GateInterruptedError(interrupted);
      load = readLoad();
      if (load < ceiling) return;
    }
  } finally {
    for (const signal of LOCK_SIGNALS) process.off(signal, onSignal);
  }
}

/**
 * The stages every gate run measures on the pinned sha, from the gate's
 * checkout (decision 81): build, test and lint, a touched nested package's own
 * scripts, the scope audit, the diff size and the debt deltas. Undefined once a
 * hard stage has recorded its failure in `stages`; the caller decides what a
 * failure does to the session.
 */
export async function measureBranch(
  db: Database,
  req: MergeRequest,
  session: SessionRow,
  stages: GateStageResult[],
  checkoutDir: string,
  targetSha: string,
  sha: string,
): Promise<BranchMeasurement | undefined> {
  /** One run of a stage's command: the error it threw, `undefined` on a pass. */
  const runCommand = async (
    command: { command: string; args: string[]; writablePaths?: string[] },
    cwd: string,
  ): Promise<unknown> => {
    try {
      // The session wrote what this runs (its own scripts, its own config), so
      // it runs confined: an env allowlist (decision 28) inside a sandbox whose
      // writes are default-deny (decision 36). The stage writes in the gate's
      // checkout; `repoPath` is passed to scope the toolchain cache, and stays
      // read-only, which is what keeps decision 29's trusted checkout trusted
      // while the session's own code is running.
      await runGateChild(command.command, command.args, {
        cwd,
        repoPath: req.repoPath,
        ...(command.writablePaths ? { writablePaths: command.writablePaths } : {}),
        gateEnv: req.gateEnv,
        timeout: GATE_COMMAND_TIMEOUT_MS,
      });
      return undefined;
    } catch (error) {
      // No stage result: pup was interrupted, and the gate unwinds on it.
      if (error instanceof GateInterruptedError) throw error;
      return error ?? new Error('command failed');
    }
  };

  /**
   * Runs one hard stage to its result. A failed test
   * stage runs once more, still under the lock, before it counts: a suite that
   * passes on the re-run passes, named flaky with what failed the first time,
   * so a timing-sensitive test the host's load tipped over is no rejection
   * (decision 94). Build and lint are deterministic and never re-run, and
   * neither is a test run that ended other than by the runner's own failing
   * exit (`isRerunnable`).
   */
  const commandStage = async (
    stage: string,
    command: { stage: string; command: string; args: string[]; writablePaths?: string[] },
    cwd: string,
  ): Promise<GateStageResult> => {
    // A re-run's time counts: the stage held the lock for both.
    const started = Date.now();
    const first = await runCommand(command, cwd);
    if (first === undefined) return timedSince(started, { stage, status: 'pass' });
    if (command.stage !== 'test' || !isRerunnable(first)) {
      return timedSince(started, { stage, status: 'fail', detail: commandFailureDetail(first) });
    }
    const rerun = await runCommand(command, cwd);
    if (rerun === undefined) {
      return timedSince(started, {
        stage,
        status: 'pass',
        detail: `flaky — failed, then passed on its one re-run; failing the first time: ${failingTestNames(first)}`,
      });
    }
    return timedSince(started, {
      stage,
      status: 'fail',
      detail:
        `failed twice — failing the first time: ${failingTestNames(first)}; ` +
        `on the re-run: ${failingTestNames(rerun)}\n${commandFailureDetail(rerun)}`,
    });
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
  // editing its own manifest (decision 29). What git reads of the pinned sha
  // is read from the main checkout's repo, never through the checkout's admin
  // dir, which a session can rewrite after the cut (decision 101).
  cutGateCheckout(req.repoPath, checkoutDir, sha);
  const capabilityContext: CapabilityContext = {
    measurePath: checkoutDir,
    configPath: req.repoPath,
    measureSha: sha,
    ...(req.gateEnv?.length ? { gateEnv: req.gateEnv } : {}),
  };
  const changedPaths = gitDiffPaths(req.repoPath, targetSha, sha);
  const nestedPackages = primary?.touchedNestedPackages?.(capabilityContext, changedPaths) ?? [];
  // Every environment before any stage: a stage runs session code with the
  // checkout writable, so a link made after it could follow a swapped-in
  // parent out of the checkout (decision 81).
  for (const rel of ['.', ...nestedPackages.map((pkg) => pkg.dir)]) {
    linkEnvironment(req.repoPath, checkoutDir, rel);
  }
  // Resolved from the trusted main checkout, not the session's worktree: a
  // session that deletes a script fails that stage instead of skipping it.
  const commands = primary?.gateCommands(req.repoPath) ?? [];
  const commandFor = (stage: GateStage) => commands.find((c) => c.stage === stage);
  const notMeasured = (stage: GateStage): GateStageResult => ({
    stage,
    status: 'skipped',
    detail: 'not measured — no command available',
  });
  const nestedStage = (pkg: NestedPackage, stage: string): string =>
    `${stage} (${quotePath(pkg.dir)})`;

  // Build first and alone: every stage after it reads what it produced.
  const build = commandFor('build');
  const built = build ? await commandStage('build', build, checkoutDir) : notMeasured('build');
  stages.push(built);
  if (built.status === 'fail') return undefined;

  // One instrumented run answers for the test stage and for coverage when the
  // adapter whose test command it is measures coverage too (decision 95).
  const test = commandFor('test');
  const hasSuite =
    test !== undefined ||
    nestedPackages.some((pkg) => pkg.commands.some((c) => c.stage === 'test'));
  // Before the slot and before the stages that run alongside the suites, so
  // the load measured is the machine's and not this gate's own children.
  if (hasSuite && req.wait) await waitForLoad();
  const coverageAdapter = req.adapters.find((a) => a.coverage);
  const covered =
    test && coverageAdapter === primary ? primary?.coveredTest?.(capabilityContext) : undefined;
  // The suites run one after another, never two at once: the root's, then each
  // nested package's (decision 59), each stopping the chain where its failure
  // stops the report.
  const runSuites = async () => {
    const results = new Map<string, GateStageResult>();
    let folded: CoverageReport | CapabilityUnavailable | undefined;
    try {
      if (test) {
        const run = covered ? { ...test, ...covered } : test;
        const result = await commandStage('test', run, checkoutDir);
        results.set('test', result);
        if (result.status === 'fail') return { results };
        folded = covered?.report();
      }
    } finally {
      covered?.dispose();
    }
    for (const pkg of nestedPackages) {
      for (const command of pkg.commands.filter((c) => c.stage === 'test')) {
        const stage = nestedStage(pkg, command.stage);
        const result = await commandStage(stage, command, join(checkoutDir, pkg.dir));
        results.set(stage, result);
        if (result.status === 'fail') return { results, folded };
      }
    }
    return { results, folded };
  };
  // All of them in one of the machine's test slots, which the gate is served
  // before any worker (decision 96); the wait is not the stage's time. No
  // suite to run takes no slot.
  const suites = hasSuite
    ? withTestSlot({ kind: 'gate', label: session.id }, runSuites, {
        onWait: (holders, gatesAhead) => console.error(describeSlotWait(holders, gatesAhead)),
        // Bounded, as the wait holds the merge lock (decision 96).
        maxWaitMs: GATE_SLOT_WAIT_MS,
        onWaitExpired: () =>
          console.error(
            `No test slot came free in ${formatDuration(GATE_SLOT_WAIT_MS)}; the gate runs its ` +
              'tests without one.',
          ),
        // A slots path a session broke must not fail every gate on the machine.
        onSlotsUnusable: (error) =>
          console.error(
            `The test slots could not be used (${failureSummary(error)}); the ` +
              'gate runs its tests without one.',
          ),
      }).catch((error: unknown) => {
        // A wait that ended before the suites ran leaves the coverage run's
        // directory to this; a second dispose after theirs removes nothing.
        covered?.dispose();
        // Unwound like a stage child's interrupt, which every reader below expects.
        throw error instanceof SlotWaitInterruptedError
          ? new GateInterruptedError(error.signal)
          : error;
      })
    : runSuites();
  // Alongside the suites: every stage that only reads the checkout, each in a
  // child of its own as before (decision 95).
  const lint = commandFor('lint');
  const linted = lint && commandStage('lint', lint, checkoutDir);
  const typechecks = new Map<string, Promise<GateStageResult>>();
  for (const pkg of nestedPackages) {
    for (const command of pkg.commands.filter((c) => c.stage !== 'test')) {
      const stage = nestedStage(pkg, command.stage);
      typechecks.set(stage, commandStage(stage, command, join(checkoutDir, pkg.dir)));
    }
  }
  const staticDebt = measureStaticDebt(req.adapters, capabilityContext);
  const complexityAdapters = req.adapters.filter((a) => a.complexity);
  const complexityOf = async (ctx: CapabilityContext): Promise<FileComplexity[]> => {
    const files: FileComplexity[] = [];
    for (const adapter of complexityAdapters) {
      files.push(...((await adapter.complexity?.(ctx, changedPaths)) ?? []));
    }
    return files;
  };
  const complexityStarted = Date.now();
  const complexity =
    complexityAdapters.length > 0
      ? {
          // "Before" reads the main checkout, which the merge lock holds at
          // the target branch — no historical checkout needed.
          before: complexityOf(localContext(req.repoPath, req.gateEnv)),
          after: complexityOf(capabilityContext),
        }
      : undefined;
  // Once both sides have settled, however either did; it never rejects.
  const complexityElapsed = Promise.allSettled([complexity?.before, complexity?.after]).then(
    () => Date.now() - complexityStarted,
  );
  // Every one settles before any is read, so none outlives the checkout this
  // gate removes, and an interrupt is the outcome whatever else failed. A debt
  // capability's own error waits for the debt stages, where it surfaced before.
  const settled = await Promise.allSettled([
    suites,
    linted,
    staticDebt,
    complexity?.before,
    complexity?.after,
    ...typechecks.values(),
  ]);
  const interrupted = settled.find(
    (outcome) => outcome.status === 'rejected' && outcome.reason instanceof GateInterruptedError,
  );
  if (interrupted?.status === 'rejected') throw interrupted.reason;

  // Reported in today's order, stopping where today's run stopped.
  const { results: suiteResults, folded } = await suites;
  for (const [stage, result] of [
    ['test', suiteResults.get('test')],
    ['lint', await linted],
  ] as const) {
    const reported = result ?? notMeasured(stage);
    stages.push(reported);
    if (reported.status === 'fail') return undefined;
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
      const stage = nestedStage(pkg, command.stage);
      // A nested test is in `suiteResults` here: the chain stops only at a
      // failure, and every earlier one was reported, and returned on, above.
      const result =
        command.stage === 'test'
          ? (suiteResults.get(stage) as GateStageResult)
          : await (typechecks.get(stage) as Promise<GateStageResult>);
      stages.push(result);
      if (result.status === 'fail') return undefined;
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
  let started = Date.now();
  const spec = readTaskSpec(db, session.task_id);
  const violations = auditScope(changedPaths, spec.scopeIn, spec.scopeOut);
  if (violations.length > 0) {
    stages.push(
      timedSince(started, {
        stage: 'scope-audit',
        status: 'fail',
        detail: `Out-of-scope changes:\n${violations
          .map((v) => `  ${quotePath(v.path)} (${v.reason})`)
          .join('\n')}`,
      }),
    );
    return undefined;
  }
  stages.push(
    timedSince(started, {
      stage: 'scope-audit',
      status: 'pass',
      detail: `${changedPaths.length} files in scope`,
    }),
  );

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

  started = Date.now();
  const changed = countChangedLines(req.repoPath, targetSha, sha);
  const split = `${changed.source} source + ${changed.test} test + ${changed.docs} docs changed lines`;
  const sizeFindings: string[] = [];
  if (changed.source > DIFF_SIZE_FLAG_LINES) {
    // The figure is the source count; the wording is kept so a re-gate still
    // reads an entry filed before decision 107 as the same kind.
    flaggedDebt.push({
      description: `Oversize diff (${changed.source} lines) merged from session ${session.id}`,
      files: changedPaths,
    });
    sizeFindings.push(`source exceeds the ${DIFF_SIZE_FLAG_LINES}-line flag`);
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
  stages.push(
    timedSince(
      started,
      sizeFindings.length > 0
        ? {
            stage: 'diff-size',
            status: 'flagged',
            detail: flagDetail(`${split}: ${sizeFindings.join('; ')}`),
          }
        : { stage: 'diff-size', status: 'pass', detail: split },
    ),
  );

  const measurement = await measureCoverage(
    await staticDebt,
    req.adapters,
    capabilityContext,
    folded,
  );
  const judged = judgeDebt(
    {
      ...measurement,
      ...(complexity
        ? {
            complexity: { before: await complexity.before, after: await complexity.after },
            elapsedMs: { ...measurement.elapsedMs, complexity: await complexityElapsed },
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
export function refuseGate(
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
export function commitSubjectsBetween(repoPath: string, targetSha: string, sha: string): string[] {
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
export function fileAcceptedDebt(
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
export function recordMerge(
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
export function pullRequestText(
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
export function debtKind(description: string, sessionId: string): string | undefined {
  const suffix = ` session ${sessionId}`;
  if (!description.endsWith(suffix)) return undefined;
  return DEBT_FIGURES.reduce(
    (kind, figures) => kind.replace(figures, (span) => span.replace(/\d+/g, '#')),
    description.slice(0, -suffix.length),
  );
}

/**
 * Push the session branch to origin's pinned URL. With `mayRewrite`, a branch
 * no open PR holds: a retry after a failed `--pr` run has usually been rebased
 * onto a moved target, so a plain push would be rejected non-fast-forward — and
 * so would every retry after it, dead-ending the branch. The branch is pup's
 * own (`pup/<slug>`, created and deleted by pup) and the gate just validated
 * these commits, so the rewrite is intended. The lease still refuses if origin
 * moved past what pup itself last pushed, and it only applies once a
 * remote-tracking ref exists — on the first push there is nothing to lease
 * against. Without it, the branch of an open PR, whose fresh-base merged the
 * target rather than rebased (decision 105): a plain push, which git refuses
 * unless it fast-forwards, so no commit the PR's review read is ever dropped.
 *
 * Naming the URL is not enough on its own: git rewrites a literal URL through
 * `url.<base>.insteadOf` and `pushInsteadOf` exactly as it rewrites a remote's,
 * and a `-c` rewrite of our own loses the tie to a session's that matches the
 * whole URL. So the push runs from an empty scratch git dir borrowing the
 * repo's objects: the shared config is never read, while the operator's global
 * and system config still apply (decision 54). Pushing to a URL updates no
 * remote-tracking ref, so the lease names its value and the ref is moved here.
 */
function pushBranch(
  repoPath: string,
  originUrl: string,
  branch: string,
  tip: string,
  mayRewrite: boolean,
): void {
  const tracking = `refs/remotes/origin/${branch}`;
  const leased = (() => {
    if (!mayRewrite) return undefined;
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
 * object store, removed afterwards (a removal that fails is reported, never
 * thrown over `fn`'s result: decision 100): git there never reads the shared config a
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
    removeGateDir(scratch);
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
export function withLedgerKept(error: unknown, kept: number): unknown {
  if (kept > 0 && error instanceof Error) {
    const [subject, pronoun] =
      kept === 1
        ? ['The accepted-debt ledger entry was', 'it']
        : [`All ${kept} accepted-debt ledger entries were`, 'them'];
    error.message += `\n${subject} kept for the retry, which will not file ${pronoun} twice; this session is not merged.`;
  }
  return error;
}

/**
 * The lifetime rejection count a CI fix round started from, when the session
 * is in one (a `fix_round` after its newest merge), so the round's own
 * rejections reach the cap and the first run's do not (decision 90); else 0.
 * A stored base past `rejectCount` reads as none: the count only grows.
 */
function fixRoundRejectBase(db: Database, sessionId: string, rejectCount: number): number {
  const round = currentFixRound(db, sessionId);
  if (round === undefined) return 0;
  const event = decodeEvent(round);
  const base = event.type === 'other' ? event.fields.rejectBase : undefined;
  return Number.isSafeInteger(base) && (base as number) <= rejectCount ? (base as number) : 0;
}

function rejectOrBlock(db: Database, report: GateReport): MergeOutcome {
  const lifetimeRejects = incrementRejectCount(db, report.sessionId);
  // The round's own count, so the cap and the CLI's "rejection n/2" agree.
  const rejectCount = lifetimeRejects - fixRoundRejectBase(db, report.sessionId, lifetimeRejects);
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
