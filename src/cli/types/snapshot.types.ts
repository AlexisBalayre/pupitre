import type { FleetReading } from '../../core/types/fleet.types.js';

/**
 * One project's snapshot and the store its rows' keys write through. The two
 * travel together because a row is only ever acted on through the project it
 * was read from: `pup ui --all` puts several stores' rows in one table, and an
 * action handed any other store's deps would drive a fleet the row is not in
 * (decision 61).
 */
export type ProjectReading = FleetReading['projects'][number];

/**
 * Everything one look at the store returns: one project for `pup ui` in a repo,
 * every registered one for `pup ui --all` (decision 61).
 */
export type DashboardReading = FleetReading;

/**
 * One reading and when it was taken. Only `useSnapshot` names it: what a caller
 * gets is the hook's return type, and naming the half of it that comes from the
 * store separately only invites a second reader to build one of these by hand.
 */
export interface SnapshotReading {
  reading: DashboardReading;
  /**
   * When the reading was taken. On screen so a dashboard that has stopped
   * refreshing — a dead interval, a store that will not open — is not read as a
   * fleet that has gone quiet, which is the one misreading this view must not
   * allow: both look like nothing happening.
   */
  readAt: Date;
}
