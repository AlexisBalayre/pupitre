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

/**
 * The merge lock was gone, or was another directory, when the run that took it
 * released it: a session moved it while the section ran, and another merge or
 * land could have taken a fresh one and run alongside. Carries what the
 * section returned, which happened all the same, for the caller to report
 * before it fails (decision 88).
 */
export class MergeLockLostError<TResult = unknown> extends Error {
  readonly result: TResult;

  constructor(lockPath: string, result: TResult) {
    super(
      `The merge lock at ${lockPath} was gone or replaced when this run released it, so another ` +
        'merge or land may have run at the same time. Check the target branch and `pup status` ' +
        'before the next merge, and treat a session that moved the lock as compromised.',
    );
    this.name = 'MergeLockLostError';
    this.result = result;
  }
}

export class SessionNotReviewableError extends Error {
  constructor(sessionId: string, state: SessionState) {
    super(`Session ${sessionId} is ${state}, not awaiting-review; nothing to merge.`);
    this.name = 'SessionNotReviewableError';
  }
}
