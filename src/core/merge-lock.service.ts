import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  failureSummary,
  formatDuration,
  readPlainFile,
  sanitizeReason,
} from '../adapters/capability.utils.js';
import { GATE_COMMAND_TIMEOUT_MS, MERGE_LOCK_DIRNAME } from './constants/merge-gate.constants.js';
import { InterruptSignal } from './enums/interrupt-signal.enums.js';
import { MergeLockHeldError, MergeLockLostError } from './errors/merge-gate.errors.js';
import { formatElapsed, MERGE_LOCK_STAGE, NO_PROGRESS } from './progress.utils.js';
import { GATE_SLOT_WAIT_MS } from './test-slot.service.js';
import type { LockIdentity, LockTake, MergeLockStatus } from './types/merge-gate.types.js';
import type { StageProgress } from './types/progress.types.js';

/** Inside the merge lock's directory: the holder's pid, which a later run reads (decision 88). */
const MERGE_LOCK_PID_FILE = 'pid';

/**
 * Beside the pid: what the holder runs, since when, and its stage, which a
 * waiter prints and nothing decides on (decision 184).
 */
const MERGE_LOCK_STATUS_FILE = 'status';

/**
 * Inside the merge lock's directory: a random token fresh to each take, which
 * the run that took it checks before every ref it moves.
 */
const MERGE_LOCK_TOKEN_FILE = 'token';

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
export const LOCK_SIGNALS: readonly InterruptSignal[] = [
  InterruptSignal.Sigint,
  InterruptSignal.Sigterm,
  InterruptSignal.Sighup,
];

/**
 * The longest `pup merge`, `pup land` and `pup fix` wait for a merge lock a live process
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

/**
 * A held lock's status, read as the pid is; undefined when there is none or
 * it is not what pup writes: a lock an earlier pup took has none.
 */
function mergeLockStatus(lockPath: string): MergeLockStatus | undefined {
  let status: Partial<MergeLockStatus>;
  try {
    status = JSON.parse(
      readPlainFile(join(lockPath, MERGE_LOCK_STATUS_FILE), { followLinks: false }),
    ) as Partial<MergeLockStatus>;
  } catch {
    return undefined;
  }
  const { command, since, stage } = status ?? {};
  if (typeof command !== 'string' || typeof stage !== 'string') return undefined;
  if (typeof since !== 'number' || !Number.isFinite(since)) return undefined;
  return { command, since, stage };
}

/**
 * Record the status in the file the take made, through the descriptor it
 * kept, never the lock's path: a session can swap that path for a link, and a
 * later run's lock can reuse the inode of one a session moved away, so a
 * write by path could land in a file or a lock that is not this take's.
 * Written over from the start and never shrunk, the old text past the new
 * becoming spaces, which JSON allows; a waiter that reads mid-write finds no
 * status and names only the pid. Best effort, since only a waiter's line
 * reads it. Answers the file's length, which the next write pads to.
 */
function writeMergeLockStatus(fd: number, status: MergeLockStatus, length: number): number {
  const text = JSON.stringify(status).padEnd(length);
  try {
    writeSync(fd, text, 0);
    return text.length;
  } catch {
    return length;
  }
}

/**
 * The line a waiter prints: the holder's pid, and once a pup that records it
 * holds the lock, its command, how long it has held it and its stage. Store
 * text a session can write, so each is scrubbed.
 */
function describeLockWait(
  holder: number,
  status: MergeLockStatus | undefined,
  leftMs: number,
): string {
  const doing = status
    ? ` (\`${sanitizeReason(status.command)}\`, held for ${formatElapsed(Date.now() - status.since)}` +
      `${status.stage ? `, at ${sanitizeReason(status.stage)}` : ''})`
    : '';
  return `Waiting for the merge lock, held by pid ${holder}${doing}, for up to ${formatDuration(leftMs)}.`;
}

/** `path`'s identity when it is a real directory, never a link to one; undefined otherwise. */
function directoryIdentity(path: string): LockIdentity | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isDirectory() ? { dev: stat.dev, ino: stat.ino } : undefined;
}

/**
 * The take the running locked section holds, which `assertMergeLockHeld`
 * checks. Per async context, not per path: two sections of one process on one
 * lock path, which only a swapped lock lets run at once, keep a take each.
 */
const heldMergeLock = new AsyncLocalStorage<{ lockPath: string; take: LockTake }>();

/**
 * Whether `take` is still the lock at `lockPath`: the same directory, holding
 * the same token. Neither alone: the directory's inode is free for the next
 * run's `mkdir` once a session renamed it away and deleted it, and a session
 * can read the token and copy it into a directory of its own. False when
 * either cannot be read.
 */
function isTake(lockPath: string, take: LockTake): boolean {
  try {
    const token = readPlainFile(join(lockPath, MERGE_LOCK_TOKEN_FILE), { followLinks: false });
    const now = directoryIdentity(lockPath);
    return now?.dev === take.dev && now.ino === take.ino && token === take.token;
  } catch {
    return false;
  }
}

/**
 * Refuse `step` unless this process still holds `repoPath`'s merge lock as it
 * took it. Called right before each ref the locked section moves, so a run
 * whose lock a session moved away, while another run may have taken a fresh
 * one, refuses before acting rather than finding out at the release
 * (decision 88).
 */
export function assertMergeLockHeld(repoPath: string, step: string): void {
  const lockPath = join(repoPath, '.git', MERGE_LOCK_DIRNAME);
  const held = heldMergeLock.getStore();
  if (held?.lockPath === lockPath && isTake(lockPath, held.take)) return;
  throw new Error(
    `The merge lock at ${lockPath} is no longer the one this run took, so another merge or ` +
      `land may be running: ${step} was refused, and nothing was moved by it. Check the target ` +
      'branch and `pup status`, and treat a session that moved the lock as compromised.',
  );
}

/**
 * Remove a lock directory and the pid, status and token in it, and nothing else: it sits in the
 * `.git` a session can write, so anything else found there is left and named
 * rather than removed with it, and so is a directory that is no longer
 * `identity`, a link or another directory a session swapped in, whose pid
 * could be another lock's (decision 88). False for such a directory. One
 * whose identity cannot be read is left and named too. Only EIO, a disk
 * fault, counts it as the take's, so a correct release never fails the run it
 * ends: the rename already took it off the lock path. Every other error does
 * not: a session that owns `.git` can chmod the path (EACCES, EPERM) or swap a
 * component of it (ENOTDIR, ELOOP) to hide a swapped lock.
 */
function removeLockDir(dir: string, identity: LockIdentity): boolean {
  let now: LockIdentity | undefined;
  try {
    now = directoryIdentity(dir);
  } catch (error) {
    const fault = (error as NodeJS.ErrnoException).code === 'EIO';
    console.error(
      `Could not read ${dir}: ${failureSummary(error)}, so it was left as it is. ` +
        (fault
          ? 'No run reads it; remove it from the trusted checkout.'
          : 'Treat a session that kept pup from its lock as compromised.'),
    );
    return fault;
  }
  if (now?.dev !== identity.dev || now.ino !== identity.ino) {
    console.error(
      `${dir} is no longer the lock directory pup made, so it was left as it is. Treat a ` +
        'session that replaced it as compromised.',
    );
    return false;
  }
  try {
    rmSync(join(dir, MERGE_LOCK_STATUS_FILE), { force: true });
    rmSync(join(dir, MERGE_LOCK_PID_FILE), { force: true });
    rmSync(join(dir, MERGE_LOCK_TOKEN_FILE), { force: true });
    rmdirSync(dir);
  } catch (error) {
    console.error(
      `Could not remove ${dir}: ${failureSummary(error)}. No run reads it; remove it from the ` +
        'trusted checkout.',
    );
  }
  return true;
}

/**
 * Move the lock directory aside under a fresh name, then remove it there, so
 * no reader ever finds the lock without its pid. A removal that fails leaves
 * only the aside directory, which no reader looks at. False when what was
 * moved aside is not `identity`, the directory the take made.
 */
function dropMergeLock(
  lockPath: string,
  why: 'released' | 'reclaimed',
  identity: LockIdentity,
): boolean {
  const aside = `${lockPath}.${why}-${randomBytes(8).toString('hex')}`;
  renameSync(lockPath, aside);
  return removeLockDir(aside, identity);
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
 * holding the taker's pid, a token fresh to the take and the status file the
 * taker keeps open (decision 184). Answers the take once
 * it is made, the pid holding the lock, or null for a lock with no pid to
 * read; a lock whose pid is dead is reclaimed and tried again, and a dead pid
 * is answered only while another run is reclaiming it (decision 88).
 */
function tryMergeLock(lockPath: string): LockTake | number | null {
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
      const token = randomBytes(16).toString('hex');
      let statusFd: number;
      try {
        // The token before the pid: a reader takes a lock with no pid yet for
        // one being taken, so the take is never seen whole without its token.
        writeFileSync(join(lockPath, MERGE_LOCK_TOKEN_FILE), token, { flag: 'wx' });
        writeFileSync(join(lockPath, MERGE_LOCK_PID_FILE), `${process.pid}\n`, { flag: 'wx' });
        statusFd = openSync(join(lockPath, MERGE_LOCK_STATUS_FILE), 'wx', 0o600);
      } catch (error) {
        // Taken but not recorded: undone, since a lock with no pid refuses every later run.
        removeLockDir(lockPath, identity);
        throw error;
      }
      const now = directoryIdentity(lockPath);
      if (now?.dev === identity.dev && now.ino === identity.ino) {
        return { ...identity, token, statusFd };
      }
      try {
        closeSync(statusFd);
      } catch {
        // Best effort: nothing was taken, which is what this branch says.
      }
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
 * line when the wait starts and one whenever the holder or its stage changes,
 * and by default not at all (decision 88). While held, the lock records this
 * run's command, since when, and `progress`'s stage (decision 184). `fn` is
 * told whether the take waited: anything read before the wait may have changed
 * under the run that held the lock meanwhile. While `fn` runs, the section
 * checks the take with `assertMergeLockHeld` before each ref it moves. A lock
 * found gone or replaced at the release, another directory or one holding
 * another token, is left where it is and throws `MergeLockLostError` with
 * `fn`'s result, or is printed beside `fn`'s error, whatever error the release
 * met; only a lock still the take that cannot be moved is printed and the
 * result returned. A release error never replaces what `fn` did.
 */
export async function withMergeLock<TResult>(
  repoPath: string,
  fn: (waited: boolean) => TResult | Promise<TResult>,
  maxWaitMs = 0,
  progress: StageProgress = NO_PROGRESS,
): Promise<TResult> {
  const lockPath = join(repoPath, '.git', MERGE_LOCK_DIRNAME);
  const deadline = Date.now() + maxWaitMs;
  let waited = false;
  /** The holder and its stage last said, so a change is said again and nothing else is. */
  let announced: string | undefined;
  progress.stage(MERGE_LOCK_STAGE);
  /** When the lock was first found with no pid to read. */
  let pidless: number | undefined;
  // Waited for with node's default disposition, so a Ctrl-C ends the wait;
  // the listeners go on in the same tick as the take, leaving no turn of the
  // event loop between them.
  let take: LockTake | undefined;
  for (;;) {
    const holder = tryMergeLock(lockPath);
    if (holder !== null && typeof holder === 'object') {
      take = holder;
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
    const status = mergeLockStatus(lockPath);
    const seen = `${holder} ${status?.command} ${status?.stage}`;
    if (announced !== seen) {
      announced = seen;
      progress.note(describeLockWait(holder, status, left));
    }
    waited = true;
    await sleep(Math.min(MERGE_LOCK_POLL_MS, left));
  }
  const stayAlive = (): void => undefined;
  for (const signal of LOCK_SIGNALS) process.on(signal, stayAlive);
  const taken = take;
  const held = { command: ['pup', ...process.argv.slice(2)].join(' '), since: Date.now() };
  let statusLength = 0;
  const unwatch = progress.watch((stage) => {
    statusLength = writeMergeLockStatus(taken.statusFd, { ...held, stage }, statusLength);
  });
  /** Release the lock; false when it was no longer the one this run took. */
  const release = (): boolean => {
    unwatch();
    try {
      closeSync(taken.statusFd);
    } catch {
      // Best effort, as every status write is: only a waiter's line reads it,
      // and a deferred write error a close can return must not keep the lock.
    }
    // The lock goes first: a signal between the two would otherwise meet
    // node's default disposition with the lock still on disk.
    try {
      // Checked before the move: a lock that is no longer this take is another
      // run's, or a session's, and is left on its path rather than moved from
      // under the run holding it. Only the rename's own window is then left for
      // a swap that a moved-aside lock too faulty to read would hide.
      if (!isTake(lockPath, taken)) return false;
      return dropMergeLock(lockPath, 'released', taken);
    } catch (error) {
      // Whatever failed, the lock counts as this run's only while the take is
      // still at the path: one moved away, even with another run's lock now
      // there, is lost, and so is one that cannot be read.
      if (!isTake(lockPath, taken)) return false;
      // Printed, never thrown, since `fn` has done what it did, and the lock
      // left in place names this pid, which a later run reclaims once this
      // process has exited (decision 88).
      console.error(
        `Could not release ${lockPath}: ${failureSummary(error)}. A later run reclaims it once ` +
          'this process has exited.',
      );
      return true;
    } finally {
      for (const signal of LOCK_SIGNALS) process.off(signal, stayAlive);
    }
  };
  let result: TResult;
  try {
    result = await heldMergeLock.run({ lockPath, take: taken }, () => fn(waited));
  } catch (error) {
    // The section's own error still wins; the lost lock is said beside it.
    if (!release()) console.error(new MergeLockLostError(lockPath, undefined).message);
    throw error;
  }
  if (!release()) throw new MergeLockLostError(lockPath, result);
  return result;
}
