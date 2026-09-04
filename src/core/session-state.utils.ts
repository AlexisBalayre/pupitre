import type { SessionState } from './db.client.js';

/**
 * Allowed session state transitions (docs/01-architecture.md, amended by decision 7).
 *   queued -> running -> awaiting-review -> merged
 *   running -> killed
 *   awaiting-review -> rejected -> running   (gate report injected; capped at 2)
 *   rejected|running -> blocked              (cap reached; needs a human)
 */
const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  queued: ['running', 'killed'],
  running: ['awaiting-review', 'killed', 'blocked'],
  'awaiting-review': ['merged', 'rejected', 'running', 'killed'],
  rejected: ['running', 'blocked', 'killed'],
  blocked: ['running', 'killed'],
  merged: [],
  killed: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * States meaning a task is spoken for, so it is out of the backlog and its spec
 * is frozen. Derived from `TRANSITIONS` rather than listed, because that record
 * is exhaustive over `SessionState`: a state added later is claimed by default,
 * and the unsafe direction would be a task with a live session reappearing in
 * the backlog to be launched twice. `killed` is the one deliberate exclusion —
 * abandoned work returns to the backlog (decision 40).
 */
export function claimedStates(): SessionState[] {
  return (Object.keys(TRANSITIONS) as SessionState[]).filter((state) => state !== 'killed');
}

const TERMINAL_STATES: readonly SessionState[] = ['merged', 'killed'];

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.includes(state);
}
