import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardSession, DashboardSnapshot } from '../../core/types/dashboard.types.js';
import type { ActionDeps } from './actions.service.js';
import { App } from './app.component.js';
import { clip, windowStart } from './viewport.utils.js';

/**
 * Ink clears the whole screen when a frame is as tall as the terminal, so the
 * contract here is one number: the frame is always shorter than the rows
 * (decision 121).
 */
const DEPS = { db: {}, repoPath: '/repo/pupitre', pupBin: '/abs/pup.js' } as unknown as ActionDeps;
const DOWN = '\u001b[B';

function sessionAt(index: number): DashboardSession {
  return {
    id: `s-live${index}-1`,
    isMintedId: true,
    state: 'running',
    branch: `pup/t-live${index}`,
    taskId: `t-live${index}`,
    goal: `live goal ${index}`,
    origin: 'human',
    scope: ['src/**'],
    acceptance: ['it works'],
    rejectCount: 0,
    needsHuman: false,
    recentEvents: [],
  };
}

function snapshot(live: number, planned: number): DashboardSnapshot {
  return {
    projectId: 'ab12cd34ef56',
    repoPath: '/repo/pupitre',
    conductor: { running: false, name: 'c', attachCommand: 'tmux attach' },
    sessions: Array.from({ length: live }, (_, index) => sessionAt(index)),
    backlog: Array.from({ length: planned }, (_, index) => ({
      id: `t-plan${index}`,
      goal: `planned goal ${index}`,
      scope: ['src/**'],
      acceptance: [],
      origin: 'human' as const,
    })),
    overdueDebt: Array.from({ length: 5 }, (_, index) => ({
      id: String(index + 1),
      description: `debt ${index}`,
      reviewBy: '2026-01-01',
    })),
    openDebtCount: 5,
    overlaps: Array.from({ length: 5 }, (_, index) => ({
      sessionA: `s-a${index}`,
      sessionB: `s-b${index}`,
      files: ['src/x.ts'],
    })),
    radarStale: false,
  };
}

/** The app on a terminal `rows` tall: the stream is told its height, then resized, as a real one is. */
async function renderAt(
  rows: number,
  live = 6,
  planned = 40,
  options: { projects?: DashboardSnapshot[]; readOnlyReason?: string } = {},
) {
  const snapshots = options.projects ?? [snapshot(live, planned)];
  const instance = render(
    createElement(App, {
      read: () => ({
        projects: snapshots.map((each) => ({ deps: DEPS, snapshot: each })),
        unreadable: [],
      }),
      showAttach: true,
      ...(options.readOnlyReason ? { readOnlyReason: options.readOnlyReason } : {}),
    }),
  );
  await resize(instance, rows);
  return instance;
}

async function resize(instance: ReturnType<typeof render>, rows: number) {
  (instance.stdout as unknown as { rows: number }).rows = rows;
  instance.stdout.emit('resize');
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const heightOf = (instance: ReturnType<typeof render>) =>
  (instance.lastFrame() ?? '').split('\n').length;

afterEach(cleanup);

describe('viewport', () => {
  it.each([16, 20, 24, 30, 40, 60])('keeps the frame under a %i-row terminal', async (rows) => {
    const instance = await renderAt(rows);

    expect(heightOf(instance)).toBeLessThan(rows);
    instance.unmount();
  });

  it('keeps long header, prompt and read-only lines to one row each', async () => {
    const running = {
      ...snapshot(6, 40),
      conductor: {
        running: true,
        name: 'c',
        attachCommand:
          "tmux -L pup-conductor-ab12cd34ef56 attach -t '=pup-conductor-ab12cd34ef56:'",
      },
    };
    const instance = await renderAt(24, 6, 40, {
      projects: [running],
      readOnlyReason: 'this is the conductor: it reads the dashboard and presses no keys. '.repeat(
        3,
      ),
    });

    expect(heightOf(instance)).toBeLessThan(24);
    instance.unmount();
  });

  it('keeps a long prompt to one row', async () => {
    const instance = await renderAt(24);

    instance.stdin.write('k');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(instance.lastFrame()).toContain('(y/n, Esc cancels)');
    expect(heightOf(instance)).toBeLessThan(24);
    instance.unmount();
  });

  it.each([20, 24, 30])(
    'keeps a stale radar over two projects under a %i-row terminal',
    async (rows) => {
      const stale = (projectId: string) => ({
        ...snapshot(6, 40),
        projectId,
        overlaps: [{ sessionA: 's-a', sessionB: 's-b', files: ['src/x.ts'] }],
        radarStale: true,
      });
      const instance = await renderAt(rows, 6, 40, {
        projects: [stale('ab12cd34ef56'), stale('cd34ef56ab12')],
      });

      expect(heightOf(instance)).toBeLessThan(rows);
      instance.unmount();
    },
  );

  it('ends a clipped list with a +N more line', async () => {
    const instance = await renderAt(24);

    expect(instance.lastFrame()).toMatch(/\+\d+ more/);
    instance.unmount();
  });

  it('draws everything when the terminal has the room', async () => {
    const instance = await renderAt(200, 2, 3);

    expect(instance.lastFrame()).not.toMatch(/\+\d+ more\s*$/m);
    expect(instance.lastFrame()).toContain('t-plan2');
    instance.unmount();
  });

  it('scrolls the window to keep the cursor visible', async () => {
    const instance = await renderAt(24);
    expect(instance.lastFrame()).not.toContain('t-plan30');

    for (let step = 0; step < 36; step++) {
      instance.stdin.write(DOWN);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(instance.lastFrame()).toMatch(/^\s*> planned\s+t-plan30/m);
    expect(heightOf(instance)).toBeLessThan(24);
    instance.unmount();
  });

  it('re-fits when the terminal is resized', async () => {
    const instance = await renderAt(40);
    const tall = heightOf(instance);

    await resize(instance, 20);

    expect(heightOf(instance)).toBeLessThan(20);
    expect(heightOf(instance)).toBeLessThan(tall);
    instance.unmount();
  });

  it('puts the detail pane where the table was', async () => {
    const instance = await renderAt(24);

    instance.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(instance.lastFrame()).not.toContain('t-plan5');
    expect(instance.lastFrame()).toContain('s-live0-1');
    instance.unmount();
  });

  describe('clip', () => {
    it('leaves a list that fits alone', () => {
      expect(clip([1, 2, 3], 3)).toEqual({ shown: [1, 2, 3], hidden: 0 });
    });

    it('spends the last line on the +N more line', () => {
      expect(clip([1, 2, 3, 4], 3)).toEqual({ shown: [1, 2], hidden: 2 });
    });
  });

  describe('windowStart', () => {
    it.each([
      [0, 0],
      [3, 0],
      [10, 5],
      [49, 40],
    ])('puts a window of 10 over 50 rows around cursor %i at %i', (cursor, start) => {
      expect(windowStart(50, 10, cursor)).toBe(start);
    });
  });
});
