export type SessionActivityKind = 'working' | 'awaiting-input' | 'idle' | 'unknown';

export interface SessionActivity {
  kind: SessionActivityKind;
  /** The Notification message when awaiting input (permission ask, idle prompt). */
  detail?: string;
}
