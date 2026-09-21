import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The actions themselves are mocked here, and only here: what a key does is
// tested against the real store in actions.test.ts, and what this file tests is
// that the key reaches the right one with the row under the cursor. Splitting
// them is what keeps a rebind from passing because the action still works.
vi.mock('./actions.service.js', () => ({
  attachTo: vi.fn(() => ({ message: 'Detached from pup-s-run-1.' })),
  conductorAttachTarget: vi.fn(() => ({ label: 'conductor-window', args: ['-L', 's', 'attach'] })),
  // A pure formatter, not a boundary — stubbed only because the factory
  // replaces the whole module. Its sanitizing is asserted in actions.test.ts.
  failure: (error: unknown) => ({
    message: String((error as Error)?.message ?? error),
    failed: true,
  }),
  interruptSelected: vi.fn(() => ({ message: 'Interrupted.' })),
  killSelected: vi.fn(() => ({ message: 'Killed.' })),
  launchSelected: vi.fn(() => ({ message: 'Launched.' })),
  respawnSelected: vi.fn(() => Promise.resolve({ message: 'Respawned.' })),
  runMerge: vi.fn(() => ({ kill: vi.fn() })),
  selectedBlockedReason: vi.fn(() => 'the reject cap'),
  sessionAttachTarget: vi.fn((id: string) => ({ label: `pup-${id}`, args: ['attach', '-t', id] })),
  steerSelected: vi.fn(() => ({ message: 'Steered.' })),
  toggleConductor: vi.fn(() => ({ message: 'Conductor stopped.' })),
  unblockSelected: vi.fn(() => ({ message: 'Unblocked.' })),
}));

import type { DashboardSession, DashboardSnapshot } from '../../core/types/dashboard.types.js';
import {
  type ActionDeps,
  attachTo,
  conductorAttachTarget,
  interruptSelected,
  killSelected,
  launchSelected,
  type MergeHandlers,
  respawnSelected,
  runMerge,
  selectedBlockedReason,
  sessionAttachTarget,
  steerSelected,
  toggleConductor,
  unblockSelected,
} from './actions.service.js';
import { App } from './app.component.js';
import { MERGE_LOG_LINES } from './dashboard.constants.js';
import type { DashboardReading } from './use-snapshot.hook.js';

const DEPS = { db: {}, repoPath: '/repo', pupBin: '/abs/pup.js' } as unknown as ActionDeps;

function sessionFixture(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: 's-run-1',
    state: 'running',
    branch: 'pup/t-run',
    taskId: 't-run',
    goal: 'the work in flight',
    origin: 'human',
    scope: ['src/**'],
    acceptance: ['it works'],
    rejectCount: 0,
    needsHuman: false,
    recentEvents: [],
    ...overrides,
  };
}

function snapshotFixture(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    projectId: 'ab12cd34ef56',
    repoPath: '/repo',
    conductor: { running: false, name: 'pup-conductor-ab12cd34ef56', attachCommand: 'tmux …' },
    sessions: [sessionFixture()],
    backlog: [
      {
        id: 't-planned',
        goal: 'the work to come',
        scope: ['src/**'],
        acceptance: [],
        origin: 'human',
      },
    ],
    overdueDebt: [],
    openDebtCount: 0,
    overlaps: [],
    radarStale: false,
    ...overrides,
  };
}

/** One project's reading, written through `DEPS`, as `pup ui` in a repo reads it. */
function readingOf(snapshot: DashboardSnapshot): DashboardReading {
  return { projects: [{ deps: DEPS, snapshot }], unreadable: [] };
}

/** The dashboard, mounted on one fixture reading, with the keys live. */
function mount(snapshot: DashboardSnapshot = snapshotFixture(), readOnlyReason?: string) {
  return render(
    createElement(App, {
      read: () => readingOf(snapshot),
      showAttach: true,
      ...(readOnlyReason ? { readOnlyReason } : {}),
    }),
  );
}

/**
 * Ink reads stdin, renders and commits its frames on timers of its own, so the
 * frame a key produces is not on screen the moment `write` returns — every
 * assertion below is on `settled()`, never on the frame straight after a press.
 */
async function press(instance: ReturnType<typeof mount>, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    instance.stdin.write(key);
    await settled();
  }
}

/**
 * Several timer turns, not one: a key can start a chain that crosses the
 * macrotask queue more than once — `waitUntilRenderFlush` yields to React's
 * scheduler, waits for the commit, then waits for the stdout write — and one
 * turn is enough only on an unloaded machine.
 */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ENTER = '\r';
const DOWN = '\u001b[B';
const BACKSPACE = '\u0008';
const ESC = '\u001b';

afterEach(cleanup);

describe('dashboard controls', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('the keys, on the row under the cursor', () => {
    it('steers the selected session on `s`, once Enter sends the line', async () => {
      const instance = mount();

      await press(instance, 's');
      expect(instance.lastFrame()).toContain('steer s-run-1');

      await press(instance, 'g', 'o', ENTER);

      expect(steerSelected).toHaveBeenCalledWith(DEPS, 's-run-1', 'go');
      expect(instance.lastFrame()).toContain('Steered.');
      instance.unmount();
    });

    it('sends nothing when the steer line is left empty', async () => {
      const instance = mount();

      await press(instance, 's', ENTER);

      expect(steerSelected).not.toHaveBeenCalled();
      expect(instance.lastFrame()).toContain('Nothing typed');
      instance.unmount();
    });

    it('drops the last character on backspace', async () => {
      const instance = mount();

      await press(instance, 's', 'a', 'b', BACKSPACE, 'c', ENTER);

      expect(steerSelected).toHaveBeenCalledWith(DEPS, 's-run-1', 'ac');
      instance.unmount();
    });

    it('interrupts the selected session on `i`, with nothing to confirm', async () => {
      const instance = mount();

      await press(instance, 'i');

      expect(interruptSelected).toHaveBeenCalledWith(DEPS, 's-run-1');
      instance.unmount();
    });

    it('kills on `k` only once the confirmation is answered', async () => {
      const instance = mount();

      await press(instance, 'k');
      expect(instance.lastFrame()).toContain('Kill s-run-1?');
      expect(killSelected).not.toHaveBeenCalled();

      await press(instance, 'y');

      expect(killSelected).toHaveBeenCalledWith(DEPS, 's-run-1');
      instance.unmount();
    });

    it('leaves the session alone when the kill is answered `n`', async () => {
      const instance = mount();

      await press(instance, 'k', 'n');

      expect(killSelected).not.toHaveBeenCalled();
      expect(instance.lastFrame()).toContain('Cancelled.');
      instance.unmount();
    });

    it('respawns on `R` through the same flow `pup respawn` runs', async () => {
      const instance = mount();

      await press(instance, 'R');

      expect(vi.mocked(respawnSelected).mock.calls[0]?.slice(0, 2)).toEqual([DEPS, 's-run-1']);
      instance.unmount();
    });

    it("attaches to the row's window on `a`", async () => {
      const instance = mount();

      await press(instance, 'a');

      expect(sessionAttachTarget).toHaveBeenCalledWith('s-run-1');
      expect(attachTo).toHaveBeenCalledWith({
        label: 'pup-s-run-1',
        args: ['attach', '-t', 's-run-1'],
      });
      instance.unmount();
    });

    // The conductor is not a row, and its window is on a socket of its own
    // (decision 47), so it has a key rather than a place in the list.
    it('attaches to the conductor on `A` when one is running', async () => {
      const running = snapshotFixture();
      running.conductor.running = true;
      const instance = mount(running);

      await press(instance, 'A');

      expect(conductorAttachTarget).toHaveBeenCalledWith(running);
      expect(attachTo).toHaveBeenCalled();
      instance.unmount();
    });

    it('says there is no conductor to attach to rather than attaching to nothing', async () => {
      const instance = mount();

      await press(instance, 'A');

      expect(attachTo).not.toHaveBeenCalled();
      expect(instance.lastFrame()).toContain('No conductor to attach to.');
      instance.unmount();
    });
  });

  describe('launch', () => {
    it('launches the planned row under the cursor on `l`, with the model typed', async () => {
      const instance = mount();

      await press(instance, DOWN);
      expect(instance.lastFrame()).toMatch(/^\s*> planned/m);

      await press(instance, 'l');
      expect(instance.lastFrame()).toContain('model for t-planned');

      await press(instance, 'o', 'p', 'u', 's', ENTER);

      expect(launchSelected).toHaveBeenCalledWith(DEPS, 't-planned', 'opus');
      instance.unmount();
    });

    // One keystroke per launch for a fleet run on one model, rather than the
    // same string retyped down the backlog.
    it('offers the last model typed as the next default', async () => {
      const instance = mount();
      await press(instance, DOWN, 'l', 'o', 'p', 'u', 's', ENTER);

      await press(instance, 'l');

      expect(instance.lastFrame()).toContain('(blank for the default): opus');
      instance.unmount();
    });

    it('refuses to launch a session row', async () => {
      const instance = mount();

      await press(instance, 'l');

      expect(launchSelected).not.toHaveBeenCalled();
      expect(instance.lastFrame()).toContain('not on a planned task');
      instance.unmount();
    });
  });

  describe('unblock', () => {
    const blocked = snapshotFixture({ sessions: [sessionFixture({ state: 'blocked' })] });

    // Unblocking is a claim that the block was addressed, so the reason comes
    // first and comes out of the store.
    it('shows the reason the gate recorded before it asks', async () => {
      const instance = mount(blocked);

      await press(instance, 'u');
      expect(instance.lastFrame()).toContain('s-run-1 was blocked: the reject cap');

      await press(instance, 'y');

      expect(unblockSelected).toHaveBeenCalledWith(DEPS, 's-run-1');
      instance.unmount();
    });

    it('refuses a session that is not blocked, and names its state', async () => {
      const instance = mount();

      await press(instance, 'u');

      expect(unblockSelected).not.toHaveBeenCalled();
      expect(instance.lastFrame()).toContain('s-run-1 is running');
      instance.unmount();
    });
  });

  describe('conductor', () => {
    it('asks for both models on `c`, then starts one', async () => {
      const instance = mount();

      await press(instance, 'c');
      expect(instance.lastFrame()).toContain('conductor model');

      await press(instance, 'o', 'p', 'u', 's', ENTER);
      expect(instance.lastFrame()).toContain('worker model');

      await press(instance, 's', 'o', 'n', ENTER);

      expect(toggleConductor).toHaveBeenCalledWith(DEPS, false, {
        model: 'opus',
        workerModel: 'son',
      });
      instance.unmount();
    });

    it('stops the running one on `c` with nothing to answer', async () => {
      const running = snapshotFixture();
      running.conductor.running = true;
      const instance = mount(running);

      await press(instance, 'c');

      expect(toggleConductor).toHaveBeenCalledWith(DEPS, true, { model: '', workerModel: '' });
      instance.unmount();
    });
  });

  describe('merge', () => {
    const reviewable = snapshotFixture({
      sessions: [sessionFixture({ state: 'awaiting-review' })],
    });

    it('runs the gate as a child and fills the log pane as it writes', async () => {
      const instance = mount(reviewable);

      await press(instance, 'm', 'y');

      expect(vi.mocked(runMerge).mock.calls[0]?.slice(0, 2)).toEqual([DEPS, 's-run-1']);
      expect(instance.lastFrame()).toContain('pup merge s-run-1 --pr');
      expect(instance.lastFrame()).toContain('waiting for the first stage');

      const handlers = vi.mocked(runMerge).mock.calls[0]?.[2] as MergeHandlers;
      handlers.onLine('  tests           PASS');
      handlers.onLine('  dead-code       PASS');
      await settled();

      expect(instance.lastFrame()).toContain('tests           PASS');
      expect(instance.lastFrame()).toContain('dead-code       PASS');

      handlers.onExit(0);
      await settled();

      expect(instance.lastFrame()).toContain('passed');
      instance.unmount();
    });

    it('says where a failing gate stopped, and keeps the log up', async () => {
      const instance = mount(reviewable);
      await press(instance, 'm', 'y');
      const handlers = vi.mocked(runMerge).mock.calls[0]?.[2] as MergeHandlers;

      handlers.onLine('Gate failed; session parked as blocked.');
      handlers.onExit(1);
      await settled();

      expect(instance.lastFrame()).toContain('did not land (exit 1)');
      expect(instance.lastFrame()).toContain('Gate failed; session parked as blocked.');
      instance.unmount();
    });

    // The gate runs for minutes. Without a way out that is not Ctrl-C, the
    // only exit signals the child too, and the lock directory it releases in a
    // `finally` is stranded for every later merge.
    it('ends the child with SIGTERM on `q`, rather than leaving Ctrl-C to do it', async () => {
      const child = { kill: vi.fn() };
      vi.mocked(runMerge).mockReturnValueOnce(child as unknown as ReturnType<typeof runMerge>);
      const instance = mount(reviewable);

      await press(instance, 'm', 'y');
      expect(instance.lastFrame()).toContain('(running)');

      await press(instance, 'q');

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      instance.unmount();
    });

    // The ordinal is the only identity these lines have, so it has to keep
    // counting once the tail starts scrolling — a key that came round again
    // would draw a new line over an old one.
    it('keeps every line in the pane distinct past the tail it holds', async () => {
      const instance = mount(reviewable);
      await press(instance, 'm', 'y');
      const handlers = vi.mocked(runMerge).mock.calls[0]?.[2] as MergeHandlers;

      for (let line = 0; line < MERGE_LOG_LINES + 3; line += 1) handlers.onLine(`stage ${line}`);
      await settled();

      const frame = instance.lastFrame() ?? '';
      // The oldest three have scrolled off and the newest are all on screen,
      // each once: a repeated key would have dropped or doubled one of them.
      expect(frame).not.toContain('stage 0');
      expect(frame).toContain(`stage ${MERGE_LOG_LINES + 2}`);
      expect(frame.match(/stage \d+/g)).toHaveLength(MERGE_LOG_LINES);
      instance.unmount();
    });

    it('gives the keys back when the child could not be spawned at all', async () => {
      vi.mocked(runMerge).mockImplementationOnce(() => {
        throw new Error('spawn ENOENT');
      });
      const instance = mount(reviewable);

      await press(instance, 'm', 'y');

      expect(instance.lastFrame()).toContain('spawn ENOENT');
      expect(instance.lastFrame()).not.toContain('waiting for the first stage');
      // Not wedged behind `busy`: the next key is answered.
      await press(instance, 'i');
      expect(interruptSelected).toHaveBeenCalledWith(DEPS, 's-run-1');
      instance.unmount();
    });

    it('merges only a branch that is finished', async () => {
      const instance = mount();

      await press(instance, 'm');

      expect(runMerge).not.toHaveBeenCalled();
      expect(instance.lastFrame()).toContain('only a finished branch merges');
      instance.unmount();
    });
  });

  // Decision 61: with `--all` the rows come from several stores, and every key
  // acts on its row through that row's own project — the first project, the
  // one a cwd would have resolved, is the wrong answer for all of them.
  describe('across projects', () => {
    const DEPS_B = { db: {}, repoPath: '/repo-b', pupBin: '/abs/pup.js' } as unknown as ActionDeps;
    const projectA = snapshotFixture({ backlog: [] });
    const projectB = snapshotFixture({
      projectId: 'bbbbbbbbbbbb',
      repoPath: '/repo-b',
      conductor: { running: true, name: 'pup-conductor-bbbbbbbbbbbb', attachCommand: 'tmux …' },
      sessions: [
        sessionFixture({ id: 's-b-blocked', state: 'blocked' }),
        sessionFixture({ id: 's-b-review', state: 'awaiting-review' }),
      ],
      backlog: [{ id: 't-b-plan', goal: 'B', scope: [], acceptance: [], origin: 'human' }],
    });

    function mountFleet(projects = [projectA, projectB]) {
      const deps = [DEPS, DEPS_B];
      return render(
        createElement(App, {
          read: () => ({
            projects: projects.map((snapshot, index) => ({
              deps: deps[index] as ActionDeps,
              snapshot,
            })),
            unreadable: [],
          }),
          showAttach: true,
        }),
      );
    }

    // Rows: s-run-1 (A), s-b-blocked, s-b-review, t-b-plan (all B).
    it.each([
      ['steer', [DOWN, 's', 'g', 'o', ENTER], () => [steerSelected, DEPS_B, 's-b-blocked', 'go']],
      ['interrupt', [DOWN, 'i'], () => [interruptSelected, DEPS_B, 's-b-blocked']],
      ['kill', [DOWN, 'k', 'y'], () => [killSelected, DEPS_B, 's-b-blocked']],
      ['unblock', [DOWN, 'u', 'y'], () => [unblockSelected, DEPS_B, 's-b-blocked']],
      ['launch', [DOWN, DOWN, DOWN, 'l', ENTER], () => [launchSelected, DEPS_B, 't-b-plan', '']],
      [
        'conductor stop',
        [DOWN, 'c'],
        () => [toggleConductor, DEPS_B, true, { model: '', workerModel: '' }],
      ],
    ])('dispatches the %s with the row’s own project', async (_what, keys, expected) => {
      const [action, ...args] = expected() as [(...a: unknown[]) => unknown, ...unknown[]];
      const instance = mountFleet();

      await press(instance, ...keys);

      expect(action).toHaveBeenCalledWith(...args);
      instance.unmount();
    });

    // Both leave the key handler before they act, so the row's project has to
    // survive the wait — and the merge holds the keys until its child exits.
    it.each([
      ['merge', [DOWN, DOWN, 'm', 'y'], runMerge],
      ['respawn', [DOWN, DOWN, 'R'], respawnSelected],
    ])('starts the %s through the row’s own project', async (_what, keys, action) => {
      const instance = mountFleet();

      await press(instance, ...keys);

      expect(vi.mocked(action).mock.calls[0]?.slice(0, 2)).toEqual([DEPS_B, 's-b-review']);
      instance.unmount();
    });

    it('asks the row’s own project for the block reason and the conductor to attach', async () => {
      const instance = mountFleet();

      await press(instance, DOWN, 'u');
      expect(selectedBlockedReason).toHaveBeenCalledWith(DEPS_B, 's-b-blocked');
      await press(instance, ESC, 'A');

      expect(conductorAttachTarget).toHaveBeenCalledWith(projectB);
      instance.unmount();
    });

    it('still acts on the first project’s rows through the first project', async () => {
      const instance = mountFleet();

      await press(instance, 'k', 'y');

      expect(killSelected).toHaveBeenCalledWith(DEPS, 's-run-1');
      instance.unmount();
    });

    // A single project's conductor needs no row; a fleet's cannot be guessed.
    it('refuses the conductor keys with no row to say whose', async () => {
      const empty = { sessions: [], backlog: [] };
      const instance = mountFleet([
        snapshotFixture(empty),
        snapshotFixture({ ...empty, projectId: 'bbbbbbbbbbbb' }),
      ]);

      await press(instance, 'c');
      expect(instance.lastFrame()).toContain('Whose conductor?');
      await press(instance, 'A');

      expect(toggleConductor).not.toHaveBeenCalled();
      expect(conductorAttachTarget).not.toHaveBeenCalled();
      expect(instance.lastFrame()).toContain('Whose conductor?');
      instance.unmount();
    });

    it('starts a lone project’s conductor from an empty screen', async () => {
      const instance = mount(snapshotFixture({ sessions: [], backlog: [] }));

      await press(instance, 'c', ENTER, ENTER);

      expect(toggleConductor).toHaveBeenCalledWith(DEPS, false, { model: '', workerModel: '' });
      instance.unmount();
    });
  });

  describe('the detail pane', () => {
    const detailed = snapshotFixture({
      sessions: [
        sessionFixture({
          acceptance: ['the pane opens'],
          lastGate: {
            passed: true,
            stages: [{ stage: 'coverage', status: 'pass' }],
            at: '2026-09-13T10:00:00.000Z',
          },
          recentEvents: [{ type: 'steer', at: '2026-09-13T09:00:00.000Z', detail: 'kickoff' }],
        }),
      ],
      backlog: [
        {
          id: 't-planned',
          goal: 'the work to come',
          scope: ['docs/**'],
          acceptance: ['the docs say so'],
          origin: 'human',
        },
      ],
    });

    it('opens on Enter for the selected session, in place of the table', async () => {
      const instance = mount(detailed);

      await press(instance, ENTER);

      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('Esc closes');
      expect(frame).toContain('- the pane opens');
      expect(frame).toMatch(/coverage\s+pass/);
      expect(frame).toMatch(/steer\s+kickoff/);
      expect(frame).not.toMatch(/^\s*> running/m);
      instance.unmount();
    });

    it('closes on Esc, giving the table back', async () => {
      const instance = mount(detailed);

      await press(instance, ENTER, ESC);

      expect(instance.lastFrame()).not.toContain('Esc closes');
      expect(instance.lastFrame()).toMatch(/^\s*> running/m);
      instance.unmount();
    });

    it('opens on the planned row the cursor is on', async () => {
      const instance = mount(detailed);

      await press(instance, DOWN, ENTER);

      expect(instance.lastFrame()).toContain('planned t-planned');
      expect(instance.lastFrame()).toContain('- the docs say so');
      instance.unmount();
    });

    // A view of the row under the cursor, not a mode: the arrows move it.
    it('follows the cursor while it is open', async () => {
      const instance = mount(detailed);

      await press(instance, ENTER, DOWN);

      expect(instance.lastFrame()).toContain('planned t-planned');
      instance.unmount();
    });

    // An open prompt owns Esc: it cancels the kill, and the pane stays up.
    it('leaves Esc to an open prompt', async () => {
      const instance = mount(detailed);

      await press(instance, ENTER, 'k', ESC);

      expect(killSelected).not.toHaveBeenCalled();
      expect(instance.lastFrame()).toContain('Cancelled.');
      expect(instance.lastFrame()).toContain('- the pane opens');
      instance.unmount();
    });

    // Enter on a finished merge log closes the log, as it did before the pane.
    it('leaves Enter to a merge log that is open', async () => {
      const instance = mount(
        snapshotFixture({ sessions: [sessionFixture({ state: 'awaiting-review' })] }),
      );
      await press(instance, 'm', 'y');
      const handlers = vi.mocked(runMerge).mock.calls[0]?.[2] as MergeHandlers;
      handlers.onExit(0);
      await settled();

      await press(instance, ENTER);

      expect(instance.lastFrame()).not.toContain('pup merge s-run-1 --pr');
      expect(instance.lastFrame()).not.toContain('Esc closes');
      instance.unmount();
    });

    it('says there is nothing to open on an empty list', async () => {
      const instance = mount(snapshotFixture({ sessions: [], backlog: [] }));

      await press(instance, ENTER);

      expect(instance.lastFrame()).toContain('Nothing to open');
      instance.unmount();
    });
  });

  describe('a caller that may not drive the fleet', () => {
    const REASON = 'read-only: sessions do not drive sessions (decisions 42, 44).';

    it('says why, and hides the keys it will not answer', async () => {
      const instance = mount(snapshotFixture(), REASON);

      expect(instance.lastFrame()).toContain(REASON);
      expect(instance.lastFrame()).not.toContain('k kill');
      expect(instance.lastFrame()).toContain('q quit');
      instance.unmount();
    });

    it.each([['s'], ['i'], ['k'], ['u'], ['R'], ['a'], ['A'], ['c'], ['m'], ['l']])(
      'does nothing on `%s`',
      async (key) => {
        // With the conductor up, so `A` is refused for the tier rather than
        // for having no window to attach to.
        const running = snapshotFixture();
        running.conductor.running = true;
        const instance = mount(running, REASON);

        await press(instance, key, 'y', ENTER);

        for (const action of [
          steerSelected,
          interruptSelected,
          killSelected,
          unblockSelected,
          respawnSelected,
          attachTo,
          toggleConductor,
          runMerge,
          launchSelected,
        ]) {
          expect(action).not.toHaveBeenCalled();
        }
        instance.unmount();
      },
    );

    // The screen is still a screen: looking at it, re-reading it and leaving it
    // are not things a session is refused.
    it('still opens and closes the detail pane', async () => {
      const instance = mount(snapshotFixture(), REASON);

      await press(instance, ENTER);
      expect(instance.lastFrame()).toContain('- it works');

      await press(instance, ESC);
      expect(instance.lastFrame()).not.toContain('Esc closes');
      instance.unmount();
    });

    it('still moves the cursor and re-reads on `r`', async () => {
      let reads = 0;
      const instance = render(
        createElement(App, {
          read: () => {
            reads += 1;
            return readingOf(snapshotFixture());
          },
          showAttach: false,
          readOnlyReason: REASON,
        }),
      );

      await press(instance, DOWN);
      expect(instance.lastFrame()).toMatch(/^\s*> planned/m);

      await press(instance, 'r');

      expect(reads).toBe(2);
      instance.unmount();
    });
  });

  /**
   * `launchTask`, `startConductor` and `steerSession` all block this thread —
   * `kickoff` polls a new window for up to ~51 s, a steer for 3.5 s — so the
   * frame that says what is happening has to be on screen before the call, not
   * after it. Each case asserts the line from inside the action: at that moment
   * the thread is where it would be for the whole freeze, and the frame there
   * is the one the operator would be staring at.
   */
  describe('the actions that block the thread', () => {
    it.each([
      [
        'launch',
        [DOWN, 'l', ENTER],
        launchSelected,
        'Launching t-planned: waiting for the window …',
      ],
      ['steer', ['s', 'g', 'o', ENTER], steerSelected, 'Steering s-run-1: waiting for the paste'],
      ['conductor start', ['c', ENTER, ENTER], toggleConductor, 'Starting the conductor'],
    ])('paints the wait before it runs the %s', async (_what, keys, action, waiting) => {
      let frameWhenCalled = '';
      const instance = mount();
      vi.mocked(action).mockImplementationOnce(((...args: unknown[]) => {
        frameWhenCalled = instance.lastFrame() ?? '';
        return { message: `done ${args.length}` };
      }) as never);

      await press(instance, ...keys);

      expect(action).toHaveBeenCalled();
      expect(frameWhenCalled).toContain(waiting);
      instance.unmount();
    });

    it('gives the keys back once the call returns', async () => {
      const instance = mount();

      await press(instance, 's', 'g', 'o', ENTER);
      expect(instance.lastFrame()).toContain('Steered.');

      await press(instance, 'i');

      expect(interruptSelected).toHaveBeenCalledWith(DEPS, 's-run-1');
      instance.unmount();
    });
  });

  // Without this the dashboard is left on screen and deaf, with no way out but
  // Ctrl-C.
  it('gives the keys back when the terminal refuses to be handed over', async () => {
    const instance = mount();
    vi.mocked(attachTo).mockImplementationOnce(() => {
      throw new Error('the terminal would not hand input back');
    });

    await press(instance, 'a');
    expect(instance.lastFrame()).toContain('would not hand input back');

    await press(instance, 'i');

    expect(interruptSelected).toHaveBeenCalledWith(DEPS, 's-run-1');
    instance.unmount();
  });

  it('cancels any prompt on Esc, leaving the action untaken', async () => {
    const instance = mount();

    await press(instance, 'k', ESC);

    expect(killSelected).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('Cancelled.');
    instance.unmount();
  });

  // A prompt open over the table owns every key: `k` in a steer is a letter.
  it('types into an open prompt rather than acting on the row', async () => {
    const instance = mount();

    await press(instance, 's', 'k', 'i', 'l', 'l');

    expect(killSelected).not.toHaveBeenCalled();
    expect(interruptSelected).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('steer s-run-1: kill');
    instance.unmount();
  });
});
