/**
 * Where a session is in its lifecycle. The values are the strings the
 * `sessions.state` column stores, so changing one is a data migration.
 */
export enum SessionState {
  Queued = 'queued',
  Running = 'running',
  AwaitingReview = 'awaiting-review',
  Merged = 'merged',
  Killed = 'killed',
  Rejected = 'rejected',
  Blocked = 'blocked',
}
