import { describe, expect, it } from 'vitest';
import type { SessionState } from './db.client.js';
import { canTransition, isTerminal } from './session-state.utils.js';

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
