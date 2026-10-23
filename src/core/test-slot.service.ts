import { execFileSync, spawn } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants, freemem, homedir } from 'node:os';
import { join } from 'node:path';
import { detectAdapters } from '../adapters/adapter.registry.js';
import { sanitizeReason } from '../adapters/capability.utils.js';
import type { GateCommand } from '../adapters/types/adapter.types.js';

// The machine is what 6 to 8 workers share, and test runs are what saturate it
// (decision 96): sessions think and edit freely, and every test run waits for
// one of a few machine-wide slots. The launch's memory guard reads the same
// machine, so it lives here too.

/** How many test runs the machine takes at once, the gate's among them (decision 96). */
export const TEST_SLOTS = 2;

/** A launch is refused below this much available memory (decision 96). */
export const MIN_AVAILABLE_MEMORY_BYTES = 1.5 * 1024 ** 3;

/**
 * Set on the child `pup session test` runs, so a gate a test starts in-process
 * runs inside the slot its runner already holds rather than queueing behind
 * it. The gate's own children never see it (their environment is an
 * allowlist), and their sandbox denies writes under `HOME`, which is what
 * lets them through instead (`isUnwritable`).
 */
export const HELD_SLOT_ENV = 'PUP_TEST_SLOT';

const POLL_MS = 1000;

/** Who takes a slot: the merge gate goes first, a worker's `pup session test` after it. */
export type SlotHolderKind = 'gate' | 'worker';

export interface SlotHolder {
  kind: SlotHolderKind;
  /** The session the run is for, as `pup session test` and the gate name it. */
  label: string;
  pid: number;
}

export interface TestSlotOptions {
  /** `~/.pupitre/slots` unless a test names another. */
  dir?: string;
  slots?: number;
  pollMs?: number;
  /**
   * Called once, the first time every slot is taken or a gate is waiting
   * ahead of a worker: who holds the slots, and the gates queued first.
   */
  onWait?: (holders: SlotHolder[], gatesAhead: SlotHolder[]) => void;
}

/**
 * Derived here rather than added to `projectPaths`: the slots are the
 * machine's, not a project's, and this module is their only reader.
 */
export function slotsDir(): string {
  return join(homedir(), '.pupitre', 'slots');
}

interface SlotRecord extends SlotHolder {
  /** Minted per take, so a release removes only the file it wrote. */
  token: string;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another user's process is alive but not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A slot or wait file's record; undefined when it is gone or holds nothing pup wrote. */
function readRecord(path: string): SlotRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // Written whole by a link, so unparseable text is not a take in progress.
    return { kind: 'worker', label: '', pid: 0, token: '' };
  }
  const record = raw as Partial<SlotRecord>;
  return {
    kind: record.kind === 'gate' ? 'gate' : 'worker',
    label: typeof record.label === 'string' ? record.label : '',
    pid: typeof record.pid === 'number' ? record.pid : 0,
    token: typeof record.token === 'string' ? record.token : '',
  };
}

/**
 * Remove a slot whose holder died, without removing one a live process took in
 * between. Renamed first, which only one reclaimer can do; if what it moved
 * turns out to be a live take, it is linked back, unless the path was taken
 * again meanwhile, which costs one run's over-subscription and nothing else.
 */
function reclaim(path: string, token: string): void {
  const aside = `${path}.reclaim-${token}`;
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  const moved = readRecord(aside);
  if (moved && isAlive(moved.pid)) {
    try {
      linkSync(aside, path);
    } catch {
      // taken again meanwhile: the live take runs without its file
    }
  }
  unlinkSync(aside);
}

/** The live holders of the slots, reclaiming every slot whose holder died. */
function liveHolders(dir: string, slots: number, token: string): (SlotRecord | undefined)[] {
  return Array.from({ length: slots }, (_, index) => {
    const path = join(dir, `slot-${index}.lock`);
    const record = readRecord(path);
    if (record && !isAlive(record.pid)) {
      reclaim(path, token);
      return undefined;
    }
    return record;
  });
}

/** Gates waiting for a slot; a dead waiter's file is removed. */
function waitingGates(dir: string): SlotHolder[] {
  const gates: SlotHolder[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.wait')) continue;
    const path = join(dir, name);
    const record = readRecord(path);
    if (!record) continue;
    if (isAlive(record.pid)) {
      gates.push(record);
    } else {
      try {
        unlinkSync(path);
      } catch {
        // another reader removed it first
      }
    }
  }
  return gates;
}

/** A write the gate's sandbox refused: its children may read `HOME`, never write it. */
function isUnwritable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EROFS';
}

/** Take the first free slot, answering its path, or undefined when every one is held. */
function take(dir: string, slots: number, record: SlotRecord): string | undefined {
  const staged = join(dir, `take-${record.pid}-${record.token}.tmp`);
  writeFileSync(staged, JSON.stringify(record));
  try {
    for (let index = 0; index < slots; index++) {
      const path = join(dir, `slot-${index}.lock`);
      try {
        // A link, not an exclusive open: the slot appears with its whole
        // record or not at all, so no reader ever sees an empty take.
        linkSync(staged, path);
        return path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return undefined;
  } finally {
    unlinkSync(staged);
  }
}

function release(path: string, token: string): void {
  if (readRecord(path)?.token !== token) return;
  try {
    unlinkSync(path);
  } catch {
    // reclaimed already
  }
}

/** A wait for a slot that an interrupt of pup's own ended: nothing ran. */
export class SlotWaitInterruptedError extends Error {
  constructor(readonly signal: 'SIGINT' | 'SIGTERM') {
    super(`Interrupted by ${signal} while waiting for a test slot; nothing ran.`);
    this.name = 'SlotWaitInterruptedError';
  }
}

/**
 * Run `fn` once it holds one of the machine's test slots, and free the slot
 * when it settles (decision 96). A slot is a lock file holding its holder's
 * pid, and a slot whose holder is dead is reclaimed. A waiting gate is served
 * before every waiting worker: it leaves a wait file for as long as it waits,
 * and no worker takes a free slot while a live gate's is there.
 *
 * Runs `fn` with no slot inside a run that already holds one: the child of a
 * `pup session test`, and a gate's sandboxed child, which cannot write the
 * slots at all.
 */
export async function withTestSlot<TResult>(
  holder: { kind: SlotHolderKind; label: string },
  fn: () => Promise<TResult>,
  options: TestSlotOptions = {},
): Promise<TResult> {
  if (process.env[HELD_SLOT_ENV]) return fn();
  const record: SlotRecord = {
    ...holder,
    pid: process.pid,
    token: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
  };
  let slot: string;
  try {
    slot = await acquire(record, options);
  } catch (error) {
    if (!isUnwritable(error)) throw error;
    return fn();
  }
  try {
    return await fn();
  } finally {
    release(slot, record.token);
  }
}

/** Wait for a free slot and take it, a gate ahead of every worker; answers its path. */
async function acquire(record: SlotRecord, options: TestSlotOptions): Promise<string> {
  const dir = options.dir ?? slotsDir();
  const slots = options.slots ?? TEST_SLOTS;
  mkdirSync(dir, { recursive: true });
  const waitFile =
    record.kind === 'gate' ? join(dir, `gate-${record.pid}-${record.token}.wait`) : undefined;
  // A wait can be long, and the merge lock keeps node alive through a signal
  // (`withMergeLock`): with no child to forward it to, an interrupt has to
  // end the wait here, or a Ctrl-C does nothing until a slot frees.
  let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
  let wake: () => void = () => undefined;
  const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    interrupted = signal;
    wake();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    if (waitFile) writeFileSync(waitFile, JSON.stringify(record));
    let told = false;
    for (;;) {
      if (interrupted) throw new SlotWaitInterruptedError(interrupted);
      const holders = liveHolders(dir, slots, record.token);
      const gatesAhead = waitFile ? [] : waitingGates(dir);
      if (gatesAhead.length === 0 && holders.includes(undefined)) {
        const slot = take(dir, slots, record);
        if (slot) return slot;
      }
      if (!told) {
        told = true;
        options.onWait?.(
          holders.filter((held): held is SlotRecord => held !== undefined),
          gatesAhead,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.pollMs ?? POLL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (waitFile) {
      try {
        unlinkSync(waitFile);
      } catch {
        // never written: the sandbox refused it
      }
    }
  }
}

/**
 * The line a run that waits prints once: who holds the slots, and the gates
 * served before it. Labels are store text, so each is scrubbed.
 */
export function describeSlotWait(holders: SlotHolder[], gatesAhead: SlotHolder[]): string {
  const named = (holder: SlotHolder): string =>
    `${holder.kind === 'gate' ? 'the merge gate for' : 'session'} ${sanitizeReason(holder.label)} (pid ${holder.pid})`;
  const held = holders.length > 0 ? `, held by ${holders.map(named).join(' and ')}` : '';
  const ahead = gatesAhead.length > 0 ? `; ${gatesAhead.map(named).join(' and ')} waits first` : '';
  return `Waiting for a test slot${held}${ahead}.`;
}

/**
 * The test command a session runs, as the gate resolves it: the first detected
 * adapter's, read from the main checkout rather than the session's worktree,
 * so it is the command the session's profile refuses to run directly.
 * Undefined when no adapter declares one.
 */
export function sessionTestCommand(repoPath: string): GateCommand | undefined {
  return detectAdapters(repoPath)[0]
    ?.gateCommands(repoPath)
    .find((command) => command.stage === 'test');
}

/**
 * `pup session test [args]`: the project's test command with `args` after it,
 * run in the session's worktree once it holds a test slot, its output on this
 * terminal. npm passes a script's arguments only after `--`. Answers the
 * run's exit status; an interrupt or a stop of pup's own reaches the run too,
 * so the slot is never freed under a suite that is still going.
 */
export async function runSessionTest(req: {
  command: GateCommand;
  args: string[];
  cwd: string;
  sessionId: string;
  slots?: TestSlotOptions;
}): Promise<number> {
  const { command, args } = req;
  const separator = command.command === 'npm' && args.length > 0 ? ['--'] : [];
  return withTestSlot(
    { kind: 'worker', label: req.sessionId },
    () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(command.command, [...command.args, ...separator, ...args], {
          cwd: req.cwd,
          env: { ...process.env, [HELD_SLOT_ENV]: req.sessionId },
          stdio: 'inherit',
        });
        const forward = (signal: NodeJS.Signals): void => {
          child.kill(signal);
        };
        process.on('SIGINT', forward);
        process.on('SIGTERM', forward);
        const settle = (): void => {
          process.off('SIGINT', forward);
          process.off('SIGTERM', forward);
        };
        child.on('error', (error) => {
          settle();
          reject(error);
        });
        child.on('close', (status, signal) => {
          settle();
          // A shell's convention for a run a signal ended.
          resolve(status ?? 128 + (signal ? constants.signals[signal] : 0));
        });
      }),
    req.slots,
  );
}

/**
 * Available memory in bytes: on macOS the free, inactive and speculative pages
 * `vm_stat` reports, which the kernel hands out without swapping; elsewhere
 * `os.freemem`. macOS's `freemem` counts free pages only, and reads near zero
 * on a machine with gigabytes to spare (decision 96).
 */
export function availableMemoryBytes(): number {
  if (process.platform !== 'darwin') return freemem();
  try {
    return vmStatAvailableBytes(execFileSync('vm_stat', { encoding: 'utf8' })) ?? freemem();
  } catch {
    return freemem();
  }
}

/**
 * Free + inactive + speculative pages times the page size `vm_stat` prints;
 * undefined when the text carries no free-page count to read.
 */
export function vmStatAvailableBytes(text: string): number | undefined {
  const count = (name: string): number | undefined => {
    const match = new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(text);
    return match ? Number(match[1]) : undefined;
  };
  const free = count('free');
  if (free === undefined) return undefined;
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  return (free + (count('inactive') ?? 0) + (count('speculative') ?? 0)) * pageSize;
}
