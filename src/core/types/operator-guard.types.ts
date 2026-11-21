/**
 * What the process tree says of a caller it finds under a window pup opened,
 * or that it could not be read: a pane pid a launch recorded for one of the
 * project's windows, a process carrying a launch's `--name`, or a `ps` that
 * failed.
 */
export type LaunchedAncestor =
  | { kind: 'pane'; pid: number; window: string }
  | { kind: 'launched'; name: string }
  | { kind: 'unreadable' };

/** A `pup merge` call as the window check reads it; `approvedBy` already scrubbed. */
export interface MergeCall {
  pr?: boolean;
  acceptDebt?: string;
  approvedBy?: string;
}
