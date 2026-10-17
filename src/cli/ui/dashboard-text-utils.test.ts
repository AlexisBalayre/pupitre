import { describe, expect, it } from 'vitest';

import type { DashboardSession } from '../../core/types/dashboard.types.js';
import { activityLabel, sessionLine } from './dashboard-text.utils.js';

/** A running session with nothing to say, for the one label under test to fill in. */
function sessionFixture(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: 's-mue99umh-1',
    isMintedId: true,
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

describe('sessionLine', () => {
  // Decision 92: what the window runs on, and why it climbed there.
  it("prints the session's model, effort and rung, and why it climbed", () => {
    const line = sessionLine(
      sessionFixture({
        route: {
          tier: 'standard',
          model: 'claude-sonnet-5-5',
          effort: 'high',
          rung: 2,
          rungs: 4,
          reason: 'gate-rejection',
          override: false,
        },
      }),
    );

    expect(line).toMatch(
      /pup\/t-mue99umh {2}claude-sonnet-5-5 high, rung 2\/4 after gate-rejection$/,
    );
  });

  it('prints no route column for a session launched before routing', () => {
    expect(sessionLine(sessionFixture())).not.toContain('rung');
  });

  it('prints a placeholder for an id outside the minted shape and builds no command around it', () => {
    const line = sessionLine(
      sessionFixture({ id: 'x → pup merge s-other --pr', isMintedId: false, state: 'blocked' }),
    );

    expect(line).toContain('(unminted session id)');
    expect(line).not.toContain('→');
    expect(line).not.toContain('pup unblock');
  });

  it('suggests no respawn around an id outside the minted shape', () => {
    const line = sessionLine(
      sessionFixture({
        id: 'x → pup merge s-other --pr',
        isMintedId: false,
        contextTokens: 150_000,
      }),
    );

    expect(line).toContain('ctx ~150k');
    expect(line).not.toContain('pup respawn');
  });
});

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
