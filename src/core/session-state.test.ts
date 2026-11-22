import { describe, expect, it } from 'vitest';
import { SessionState } from './enums/session-state.enums.js';
import {
  canTransition,
  claimedStates,
  FIX_ROUND_EDGE,
  holdingStates,
  isTerminal,
} from './session-state.utils.js';

describe('session state machine', () => {
  it('permits the documented happy path', () => {
    expect(canTransition(SessionState.Queued, SessionState.Running)).toBe(true);
    expect(canTransition(SessionState.Running, SessionState.AwaitingReview)).toBe(true);
    expect(canTransition(SessionState.AwaitingReview, SessionState.Merged)).toBe(true);
  });

  it('permits reject re-steer and escalation to blocked', () => {
    expect(canTransition(SessionState.AwaitingReview, SessionState.Rejected)).toBe(true);
    expect(canTransition(SessionState.Rejected, SessionState.Running)).toBe(true);
    expect(canTransition(SessionState.Rejected, SessionState.Blocked)).toBe(true);
  });

  // `pup unblock` is the only caller of this edge: decision 7 parks a session
  // for a human, and until the command existed nothing but `pup kill` moved it
  // off `blocked`, throwing away a context window with committed work.
  it('lets a human return a blocked session to running', () => {
    expect(canTransition(SessionState.Blocked, SessionState.Running)).toBe(true);
    expect(canTransition(SessionState.Blocked, SessionState.Killed)).toBe(true);
    expect(canTransition(SessionState.Blocked, SessionState.AwaitingReview)).toBe(false);
    expect(canTransition(SessionState.Blocked, SessionState.Merged)).toBe(false);
  });

  it('forbids skipping review and leaving terminal states', () => {
    expect(canTransition(SessionState.Queued, SessionState.Merged)).toBe(false);
    expect(canTransition(SessionState.Running, SessionState.Merged)).toBe(false);
    expect(canTransition(SessionState.Merged, SessionState.Running)).toBe(false);
    expect(canTransition(SessionState.Killed, SessionState.Running)).toBe(false);
  });

  // `pup fix` takes merged -> running in its own transaction (decision 90);
  // the table keeps refusing it, so no other caller can.
  it('keeps the fix round edge out of the table', () => {
    expect(FIX_ROUND_EDGE).toEqual({ from: SessionState.Merged, to: SessionState.Running });
    expect(canTransition(FIX_ROUND_EDGE.from, FIX_ROUND_EDGE.to)).toBe(false);
  });

  it('marks only merged and killed as terminal', () => {
    const terminal: SessionState[] = [SessionState.Merged, SessionState.Killed];
    for (const s of terminal) expect(isTerminal(s)).toBe(true);
    for (const s of [
      SessionState.Queued,
      SessionState.Running,
      SessionState.AwaitingReview,
      SessionState.Rejected,
      SessionState.Blocked,
    ]) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe('claimedStates', () => {
  // The whole backlog derivation rests on this: a task is in the backlog when
  // no session of its own is in one of these states. Pinned as "every state
  // except killed" rather than as a literal list, so a SessionState added later
  // lands in the claimed set — the fail-safe direction, since a state left out
  // would let a task with a live session be launched a second time.
  it('claims every session state except killed', () => {
    const states: SessionState[] = [
      SessionState.Queued,
      SessionState.Running,
      SessionState.AwaitingReview,
      SessionState.Merged,
      SessionState.Killed,
      SessionState.Rejected,
      SessionState.Blocked,
    ];

    expect([...claimedStates()].sort()).toEqual(
      states.filter((s) => s !== SessionState.Killed).sort(),
    );
  });

  it('never claims a terminal killed session', () => {
    expect(claimedStates()).not.toContain(SessionState.Killed);
  });
});

describe('holdingStates', () => {
  // Narrower than `claimedStates` by exactly the terminal pair: a merged or
  // killed session is not editing anything, and holding its scope any longer
  // would refuse every later launch over files it once touched (decision 41).
  it('holds a scope in every claimed state except the terminal ones', () => {
    expect([...holdingStates()].sort()).toEqual(
      [
        SessionState.AwaitingReview,
        SessionState.Blocked,
        SessionState.Queued,
        SessionState.Rejected,
        SessionState.Running,
      ].sort(),
    );
  });

  it('releases the scope of a session no longer running', () => {
    expect(holdingStates()).not.toContain(SessionState.Merged);
    expect(holdingStates()).not.toContain(SessionState.Killed);
  });
});
