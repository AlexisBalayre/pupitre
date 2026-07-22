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

export const TERMINAL_STATES: readonly SessionState[] = ['merged', 'killed'];

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.includes(state);
}
