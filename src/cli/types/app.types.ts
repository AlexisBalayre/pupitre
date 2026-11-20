import type { DashboardReading } from './snapshot.types.js';

/** What `pup ui` hands the `App` layout. */
export interface AppProps {
  /** One look at every store on screen, each with the deps its rows' keys write through. */
  read: () => DashboardReading;
  showAttach: boolean;
  /** Set for a session or the conductor: the dashboard, and no controls. */
  readOnlyReason?: string;
}
