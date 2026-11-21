/** The wait's sense of time, which a test replaces. */
export interface CiWaitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface CiWaitRequest {
  repoPath: string;
  /** A session id, or the url or number of the PR a session of this project opened. */
  target: string;
  timeoutMs: number;
  pollMs?: number;
  /** One read's budget, which a test shortens. */
  readTimeoutMs?: number;
  clock?: CiWaitClock;
}

export interface CiWaitOutcome {
  /** False when the timeout ran out before the review of the current head finished. */
  finished: boolean;
  /** The one line the caller prints: the digest, or why the wait ended without one. */
  line: string;
}
