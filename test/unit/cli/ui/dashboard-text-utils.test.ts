import { Tier } from '@src/claude/enums/tier.enums.js';
import { activityLabel, needLines, sessionLine } from '@src/cli/ui/dashboard-text.utils.js';
import { ClimbReason } from '@src/core/enums/climb-reason.enums.js';
import { SessionActivityKind } from '@src/core/enums/session-activity-kind.enums.js';
import { SessionState } from '@src/core/enums/session-state.enums.js';
import type { DashboardNeed, DashboardSession } from '@src/core/types/dashboard.types.js';
import { describe, expect, it } from 'vitest';

/** A running session with nothing to say, for the one label under test to fill in. */
function sessionFixture(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: 's-mue99umh-1',
    isMintedId: true,
    state: SessionState.Running,
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
          tier: Tier.Standard,
          model: 'claude-sonnet-5-5',
          effort: 'high',
          rung: 2,
          rungs: 4,
          reason: ClimbReason.GateRejection,
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
      sessionFixture({
        id: 'x → pup merge s-other --pr',
        isMintedId: false,
        state: SessionState.Blocked,
      }),
    );

    expect(line).toContain('(unminted session id)');
    expect(line).not.toContain('→');
    expect(line).not.toContain('pup unblock');
  });

  // Decision 200: compaction is the reset, so context size alone suggests no respawn.
  it('suggests no respawn for context size alone', () => {
    const line = sessionLine(sessionFixture({ contextTokens: 250_000 }));

    expect(line).toMatch(/ctx ~250k$/);
    expect(line).not.toContain('pup respawn');
  });

  it('prints how far the context is from its compaction point', () => {
    const line = sessionLine(sessionFixture({ contextTokens: 90_400, compactAtTokens: 117_000 }));

    expect(line).toMatch(/ctx ~90k — compacts in ~27k$/);
  });

  it('says a session is at compaction once its context reaches the point', () => {
    expect(
      sessionLine(sessionFixture({ contextTokens: 117_000, compactAtTokens: 117_000 })),
    ).toMatch(/ctx ~117k — at compaction$/);
    expect(
      sessionLine(sessionFixture({ contextTokens: 130_000, compactAtTokens: 117_000 })),
    ).toMatch(/ctx ~130k — at compaction$/);
  });
});

describe('activityLabel', () => {
  it('says what a session waiting on input is waiting for', () => {
    const label = activityLabel(
      sessionFixture({
        activity: { kind: SessionActivityKind.AwaitingInput, detail: 'Bash permission' },
      }),
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
        activity: { kind: SessionActivityKind.AwaitingInput, detail: '\u001b[2Jneeds permission' },
      }),
    );

    expect(label).toBe('WAITING ON INPUT ([2Jneeds permission)');
  });

  // Decision 103: neither idle nor waiting on the operator.
  it('says a session whose turn ended on its own background shell is working on it', () => {
    expect(
      activityLabel(sessionFixture({ activity: { kind: SessionActivityKind.Background } })),
    ).toBe('working on a background shell');
  });

  it('is empty for a session that has fired no hook to classify', () => {
    expect(activityLabel(sessionFixture())).toBe('');
  });
});

// Decision 93: a question's inbox entry, then its options numbered as `pup
// answer` reads the number, the recommended one marked.
describe('needLines', () => {
  const question: DashboardNeed = {
    kind: 'question',
    sessionId: 's1',
    label: 's1',
    reason: 'question: rebase or merge?',
    answer: 'pup answer s1 <n>, or pup answer s1 "..."',
    options: ['rebase onto main', 'merge main in'],
    recommended: 2,
  };

  it('numbers the options under the line and marks the recommended one', () => {
    expect(needLines(question)).toEqual([
      's1  question: rebase or merge?  → pup answer s1 <n>, or pup answer s1 "..."',
      '    1. rebase onto main',
      '    2. merge main in  (recommended)',
    ]);
  });

  it('is the line alone for a need with no options', () => {
    const { options: _options, recommended: _recommended, ...plain } = question;
    expect(needLines(plain)).toHaveLength(1);
  });

  // The need is built from a session's words: a control character never
  // reaches the terminal, whichever surface built the need.
  it('scrubs control characters out of an option', () => {
    const [, first] = needLines({ ...question, options: ['\u001b[2Jok\u0007; $(whoami)'] });

    expect(first).toBe('    1. [2Jok ; $(whoami)');
  });
});
