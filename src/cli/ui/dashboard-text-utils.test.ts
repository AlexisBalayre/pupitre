import { describe, expect, it } from 'vitest';

import type { DashboardSession } from '../../core/types/dashboard.types.js';
import { activityLabel } from './dashboard-text.utils.js';

/** A running session with nothing to say, for the one label under test to fill in. */
function sessionFixture(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: 's-mue99umh-1',
    state: 'running',
    branch: 'pup/t-mue99umh',
    taskId: 't-mue99umh',
    goal: 'close the last raw sinks',
    origin: 'human',
    scope: ['src/**'],
    acceptance: ['it works'],
    rejectCount: 0,
    needsHuman: false,
    recentEvents: [],
    ...overrides,
  };
}

describe('activityLabel', () => {
  it('says what a session waiting on input is waiting for', () => {
    const label = activityLabel(
      sessionFixture({ activity: { kind: 'awaiting-input', detail: 'Bash permission' } }),
    );

    expect(label).toBe('WAITING ON INPUT (Bash permission)');
  });

  /**
   * The detail is a Notification hook's `message`, written by whatever runs in
   * the session's own pane and printed here on the operator's terminal — so it
   * is scrubbed at the fold like every other foreign string (decision 29).
   */
  it("strips what a terminal would obey out of the hook's own message", () => {
    const label = activityLabel(
      sessionFixture({
        activity: { kind: 'awaiting-input', detail: '\u001b[2Jneeds permission' },
      }),
    );

    expect(label).toBe('WAITING ON INPUT ([2Jneeds permission)');
  });

  it('is empty for a session that has fired no hook to classify', () => {
    expect(activityLabel(sessionFixture())).toBe('');
  });
});
