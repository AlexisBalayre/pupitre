import type { SessionState } from './db.client.js';

export class MergeLockHeldError extends Error {
  constructor(lockPath: string) {
    super(
      `Another merge is in progress (lock held at ${lockPath}). ` +
        'Wait for it to finish, or remove the lock if it is stale.',
    );
    this.name = 'MergeLockHeldError';
  }
}

export class SessionNotReviewableError extends Error {
  constructor(sessionId: string, state: SessionState) {
    super(`Session ${sessionId} is ${state}, not awaiting-review; nothing to merge.`);
    this.name = 'SessionNotReviewableError';
  }
}
