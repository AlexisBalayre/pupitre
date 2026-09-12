import { describe, expect, it } from 'vitest';
import type { SessionState } from './db.client.js';
import { canTransition, claimedStates, holdingStates, isTerminal } from './session-state.utils.js';

describe('session state machine', () => {
  it('permits the documented happy path', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'awaiting-review')).toBe(true);
    expect(canTransition('awaiting-review', 'merged')).toBe(true);
  });

  it('permits reject re-steer and escalation to blocked', () => {
    expect(canTransition('awaiting-review', 'rejected')).toBe(true);
    expect(canTransition('rejected', 'running')).toBe(true);
    expect(canTransition('rejected', 'blocked')).toBe(true);
  });

  // `pup unblock` is the only caller of this edge: decision 7 parks a session
  // for a human, and until the command existed nothing but `pup kill` moved it
  // off `blocked`, throwing away a context window with committed work.
  it('lets a human return a blocked session to running', () => {
    expect(canTransition('blocked', 'running')).toBe(true);
    expect(canTransition('blocked', 'killed')).toBe(true);
    expect(canTransition('blocked', 'awaiting-review')).toBe(false);
    expect(canTransition('blocked', 'merged')).toBe(false);
  });

  it('forbids skipping review and leaving terminal states', () => {
    expect(canTransition('queued', 'merged')).toBe(false);
    expect(canTransition('running', 'merged')).toBe(false);
    expect(canTransition('merged', 'running')).toBe(false);
    expect(canTransition('killed', 'running')).toBe(false);
  });

  it('marks only merged and killed as terminal', () => {
    const terminal: SessionState[] = ['merged', 'killed'];
    for (const s of terminal) expect(isTerminal(s)).toBe(true);
    for (const s of ['queued', 'running', 'awaiting-review', 'rejected', 'blocked'] as const) {
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
      'queued',
      'running',
      'awaiting-review',
      'merged',
      'killed',
      'rejected',
      'blocked',
    ];

    expect([...claimedStates()].sort()).toEqual(states.filter((s) => s !== 'killed').sort());
  });

  it('never claims a terminal killed session', () => {
    expect(claimedStates()).not.toContain('killed');
  });
});

describe('holdingStates', () => {
  // Narrower than `claimedStates` by exactly the terminal pair: a merged or
  // killed session is not editing anything, and holding its scope any longer
  // would refuse every later launch over files it once touched (decision 41).
  it('holds a scope in every claimed state except the terminal ones', () => {
    expect([...holdingStates()].sort()).toEqual(
      ['awaiting-review', 'blocked', 'queued', 'rejected', 'running'].sort(),
    );
  });

  it('releases the scope of a session no longer running', () => {
    expect(holdingStates()).not.toContain('merged');
    expect(holdingStates()).not.toContain('killed');
  });
});
