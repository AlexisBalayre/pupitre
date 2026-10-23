import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';
import {
  GATE_SLOT_WAIT_MS,
  HELD_SLOT_ENV,
  type SlotHolder,
  type TestSlotOptions,
  vmStatAvailableBytes,
  withTestSlot,
} from './test-slot.service.js';

/** A run that holds its slot until the test ends it. */
function heldRun(): { end: () => void; done: Promise<void> } {
  let end: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    end = resolve;
  });
  return { end, done };
}

const tick = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The pid of a process that has already exited. */
function deadPid(): number {
  return spawnSync('true').pid as number;
}

describe('withTestSlot (decision 96)', () => {
  let dir: string;
  let options: TestSlotOptions;

  beforeEach(() => {
    vi.stubEnv(HELD_SLOT_ENV, '');
    dir = tempDir('pup-slots-');
    options = { dir, slots: 2, pollMs: 10 };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Writable again before the temp dir's removal, which runs after this.
    chmodSync(dir, 0o700);
  });

  /** Start a run in a slot, answering when it began and a way to end it. */
  function run(
    kind: 'gate' | 'worker',
    label: string,
    log: string[],
    extra: Partial<TestSlotOptions> = {},
  ): { end: () => void; settled: Promise<void> } {
    const held = heldRun();
    const settled = withTestSlot(
      { kind, label },
      async () => {
        log.push(label);
        await held.done;
      },
      { ...options, ...extra },
    );
    return { end: held.end, settled };
  }

  it('runs two of three at once and starts the third when one ends', async () => {
    const log: string[] = [];
    const first = run('worker', 's1', log);
    const second = run('worker', 's2', log);
    const third = run('worker', 's3', log);
    await tick();
    expect(log).toEqual(['s1', 's2']);

    first.end();
    await first.settled;
    await tick();
    expect(log).toEqual(['s1', 's2', 's3']);

    second.end();
    third.end();
    await Promise.all([second.settled, third.settled]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('tells the waiting run once who holds the slots', async () => {
    const log: string[] = [];
    const waits: SlotHolder[][] = [];
    const first = run('worker', 's1', log);
    const second = run('gate', 's2', log);
    const third = run('worker', 's3', log, { onWait: (holders) => waits.push(holders) });
    await tick();

    expect(waits).toHaveLength(1);
    expect(waits[0]?.map((h) => [h.kind, h.label, h.pid])).toEqual([
      ['worker', 's1', process.pid],
      ['gate', 's2', process.pid],
    ]);
    for (const held of [first, second, third]) held.end();
    await Promise.all([first.settled, second.settled, third.settled]);
  });

  it('reclaims a slot whose holder is dead', async () => {
    for (const index of [0, 1]) {
      writeFileSync(
        join(dir, `slot-${index}.lock`),
        JSON.stringify({ kind: 'worker', label: 'gone', pid: deadPid(), token: 'x' }),
      );
    }
    const log: string[] = [];
    const held = run('worker', 's1', log);
    await tick();

    expect(log).toEqual(['s1']);
    held.end();
    await held.settled;
  });

  it('waits on a slot whose holder is alive in another process', async () => {
    for (const index of [0, 1]) {
      writeFileSync(
        join(dir, `slot-${index}.lock`),
        JSON.stringify({ kind: 'worker', label: 'other', pid: process.ppid, token: 'x' }),
      );
    }
    const log: string[] = [];
    const held = run('worker', 's1', log);
    await tick();
    expect(log).toEqual([]);

    rmSync(join(dir, 'slot-1.lock'));
    await tick();
    expect(log).toEqual(['s1']);
    held.end();
    await held.settled;
    expect(existsSync(join(dir, 'slot-0.lock'))).toBe(true);
  });

  it('serves a waiting gate before every waiting worker, even one that waited longer', async () => {
    const log: string[] = [];
    const first = run('worker', 's1', log);
    const second = run('worker', 's2', log);
    await tick();
    const worker = run('worker', 's3', log);
    await tick(5);
    const gate = run('gate', 'gate s9', log);
    const lateWorker = run('worker', 's4', log);
    await tick();
    expect(log).toEqual(['s1', 's2']);

    first.end();
    await first.settled;
    await tick();
    expect(log).toEqual(['s1', 's2', 'gate s9']);

    second.end();
    await second.settled;
    await tick();
    expect(log).toHaveLength(4);
    expect(log.slice(3)[0]).toMatch(/^s[34]$/);
    for (const held of [gate, worker, lateWorker]) held.end();
    await Promise.all([gate.settled, worker.settled, lateWorker.settled]);
    expect(log).toHaveLength(5);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('names the gate a worker waits behind', async () => {
    const log: string[] = [];
    const gatesSeen: SlotHolder[][] = [];
    const first = run('worker', 's1', log);
    const second = run('worker', 's2', log);
    await tick();
    const gate = run('gate', 'gate s9', log);
    const worker = run('worker', 's3', log, {
      onWait: (_holders, gates) => gatesSeen.push(gates),
    });
    await tick();

    expect(gatesSeen).toEqual([[expect.objectContaining({ kind: 'gate', label: 'gate s9' })]]);
    for (const held of [first, second, gate, worker]) held.end();
    await Promise.all([first.settled, second.settled, gate.settled, worker.settled]);
  });

  it('runs without a slot once its longest wait runs out, saying so', async () => {
    for (const index of [0, 1]) {
      writeFileSync(
        join(dir, `slot-${index}.lock`),
        JSON.stringify({ kind: 'worker', label: 'hung', pid: process.ppid, token: 'x' }),
      );
    }
    const expired = vi.fn();
    let ran = false;
    await withTestSlot(
      { kind: 'gate', label: 'gate s1' },
      async () => {
        ran = true;
      },
      { ...options, maxWaitMs: 50, onWaitExpired: expired },
    );

    expect(ran).toBe(true);
    expect(expired).toHaveBeenCalledOnce();
    expect(readdirSync(dir).sort()).toEqual(['slot-0.lock', 'slot-1.lock']);
  });

  it.skipIf(process.getuid?.() === 0)(
    "reclaims a slot naming another user's process, such as pid 1",
    async () => {
      for (const index of [0, 1]) {
        writeFileSync(
          join(dir, `slot-${index}.lock`),
          JSON.stringify({ kind: 'worker', label: 'forged', pid: 1, token: 'x' }),
        );
      }
      const log: string[] = [];
      const held = run('worker', 's1', log);
      await tick();

      expect(log).toEqual(['s1']);
      held.end();
      await held.settled;
    },
  );

  it('reclaims a fifo planted as a slot without blocking on it', async () => {
    execFileSync('mkfifo', [join(dir, 'slot-0.lock'), join(dir, 'slot-1.lock')]);
    const log: string[] = [];
    const held = run('worker', 's1', log);
    await tick();

    expect(log).toEqual(['s1']);
    held.end();
    await held.settled;
  });

  it("ignores a live gate's wait file older than a gate ever waits", async () => {
    const wait = join(dir, 'gate-1-x.wait');
    writeFileSync(
      wait,
      JSON.stringify({ kind: 'gate', label: 'stale', pid: process.ppid, token: 'x' }),
    );
    const longAgo = (Date.now() - GATE_SLOT_WAIT_MS - 60_000) / 1000;
    utimesSync(wait, longAgo, longAgo);
    const log: string[] = [];
    const held = run('worker', 's1', log);
    await tick();

    expect(log).toEqual(['s1']);
    held.end();
    await held.settled;
  });

  it('ignores the wait file of a gate that died waiting', async () => {
    writeFileSync(
      join(dir, 'gate-1-x.wait'),
      JSON.stringify({ kind: 'gate', label: 'gone', pid: deadPid(), token: 'x' }),
    );
    const log: string[] = [];
    const held = run('worker', 's1', log);
    await tick();

    expect(log).toEqual(['s1']);
    expect(existsSync(join(dir, 'gate-1-x.wait'))).toBe(false);
    held.end();
    await held.settled;
  });

  it('frees the slot when the run throws', async () => {
    await expect(
      withTestSlot(
        { kind: 'worker', label: 's1' },
        async () => {
          throw new Error('suite failed');
        },
        options,
      ),
    ).rejects.toThrow('suite failed');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves a slot another run took since alone', async () => {
    await withTestSlot(
      { kind: 'worker', label: 's1' },
      async () => {
        // Reclaimed and taken again while this run was still going.
        writeFileSync(
          join(dir, 'slot-0.lock'),
          JSON.stringify({ kind: 'worker', label: 's2', pid: process.pid, token: 'other' }),
        );
      },
      options,
    );
    expect(existsSync(join(dir, 'slot-0.lock'))).toBe(true);
  });

  it('runs inside a slot its `pup session test` already holds, taking none', async () => {
    vi.stubEnv(HELD_SLOT_ENV, '1');
    const nested = join(dir, 'nested');
    let ran = false;
    await withTestSlot(
      { kind: 'gate', label: 'gate s1' },
      async () => {
        ran = true;
      },
      { ...options, dir: nested },
    );
    expect(ran).toBe(true);
    expect(existsSync(nested)).toBe(false);
  });

  it('runs a gate child the sandbox keeps from writing the slots, taking none', async () => {
    chmodSync(dir, 0o500);
    let ran = false;
    await withTestSlot(
      { kind: 'gate', label: 'gate s1' },
      async () => {
        ran = true;
      },
      options,
    );
    expect(ran).toBe(true);
  });
});

describe('vmStatAvailableBytes (decision 96)', () => {
  const VM_STAT = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               10000.',
    'Pages active:                            500000.',
    'Pages inactive:                           20000.',
    'Pages speculative:                         3000.',
    'Pages wired down:                         90000.',
  ].join('\n');

  it('counts free, inactive and speculative pages at the printed page size', () => {
    expect(vmStatAvailableBytes(VM_STAT)).toBe((10000 + 20000 + 3000) * 16384);
  });

  it('answers nothing for text with no free-page count', () => {
    expect(vmStatAvailableBytes('vm_stat: not available')).toBeUndefined();
  });
});
