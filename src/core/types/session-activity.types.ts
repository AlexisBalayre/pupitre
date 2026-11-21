import type { SessionActivityKind } from '../enums/session-activity-kind.enums.js';
export interface SessionActivity {
  kind: SessionActivityKind;
  /** The Notification message when awaiting input (a permission ask, never the idle prompt). */
  detail?: string;
}
