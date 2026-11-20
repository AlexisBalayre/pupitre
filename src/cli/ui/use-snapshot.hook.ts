import { useCallback, useEffect, useState } from 'react';
import { SNAPSHOT_REFRESH_MS } from '../constants/dashboard.constants.js';
import type { DashboardReading, SnapshotReading } from '../types/snapshot.types.js';

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
