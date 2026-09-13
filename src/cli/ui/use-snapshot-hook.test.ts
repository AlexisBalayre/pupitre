import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '../../core/types/dashboard.types.js';
import { SNAPSHOT_REFRESH_MS } from './dashboard.constants.js';
import { useSnapshot } from './use-snapshot.hook.js';

function snapshotWith(projectId: string): DashboardSnapshot {
  return {
    projectId,
    repoPath: '/repo',
    conductor: { running: false, name: 'pup-conductor-x', attachCommand: 'tmux -L x attach -t x' },
    sessions: [],
    backlog: [],
    overdueDebt: [],
    openDebtCount: 0,
    overlaps: [],
    radarStale: false,
  };
}

/**
 * A hook has no frame of its own, so it is mounted in the smallest component
 * that can show what it returns.
 */
function Probe({ read }: { read: () => DashboardSnapshot }) {
  const { snapshot } = useSnapshot(read);
  return createElement(Text, null, snapshot.projectId);
}

/**
 * The cadence is asserted on how often `read` is called, not on how often the
 * terminal changes: Ink commits frames on a throttle of its own, and under
 * fake timers the moment it chooses is not the moment the interval fired.
 * What this hook promises is one reading per interval and none after unmount —
 * that the reading reaches the screen is the first case here and the
 * components' own tests.
 */
describe('useSnapshot', () => {
  let reads: number;
  let read: () => DashboardSnapshot;

  beforeEach(() => {
    vi.useFakeTimers();
    reads = 0;
    read = () => {
      reads += 1;
      return snapshotWith(`read-${reads}`);
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('takes one reading before any interval has elapsed, and shows it', () => {
    const instance = render(createElement(Probe, { read }));

    expect(reads).toBe(1);
    expect(instance.lastFrame()).toBe('read-1');

    instance.unmount();
  });

  it('re-reads once per interval and never between two of them', async () => {
    const instance = render(createElement(Probe, { read }));

    await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_MS - 1);
    expect(reads).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(2);

    await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_MS * 3);
    expect(reads).toBe(5);

    instance.unmount();
  });

  // A dashboard left open all day must not leave an interval behind reading a
  // store the process is on its way out of.
  it('stops reading once it is unmounted', async () => {
    const instance = render(createElement(Probe, { read }));
    await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_MS);
    expect(reads).toBe(2);

    instance.unmount();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_REFRESH_MS * 5);

    expect(reads).toBe(2);
  });
});
