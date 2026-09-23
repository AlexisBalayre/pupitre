import { useCallback, useEffect, useState } from 'react';
import type { FleetReading } from '../../core/types/fleet.types.js';
import { SNAPSHOT_REFRESH_MS } from './dashboard.constants.js';

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
 * One reading and when it was taken. Private to the hook: what a caller gets is
 * the hook's return type, and naming the half of it that comes from the store
 * separately only invites a second reader to build one of these by hand.
 */
interface SnapshotReading {
  reading: DashboardReading;
  /**
   * When the reading was taken. On screen so a dashboard that has stopped
   * refreshing — a dead interval, a store that will not open — is not read as a
   * fleet that has gone quiet, which is the one misreading this view must not
   * allow: both look like nothing happening.
   */
  readAt: Date;
}

/**
 * The dashboard's clock. The only thing in `pup ui` that decides *when* to look;
 * `read` decides what a look returns, and it is always `buildDashboardSnapshot`
 * on each store, so every component below renders one store reading taken at
 * one instant (decision 52). `read` must be stable across renders — the
 * interval is rebuilt whenever it is not.
 */
export function useSnapshot(read: () => DashboardReading): SnapshotReading & {
  refresh: () => void;
} {
  const take = useCallback(
    (): SnapshotReading => ({ reading: read(), readAt: new Date() }),
    [read],
  );
  const [reading, setReading] = useState(take);
  const refresh = useCallback(() => setReading(take()), [take]);
  useEffect(() => {
    const timer = setInterval(refresh, SNAPSHOT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  return { ...reading, refresh };
}
