import type { DashboardSession } from './dashboard.types.js';

/** What one render of a session's view reads: its snapshot row and what its window shows. */
export interface SessionView {
  session: DashboardSession;
  pane: { text: string } | { hint: string };
}
