type SessionActivityKind = 'working' | 'background' | 'awaiting-input' | 'idle' | 'unknown';

export interface SessionActivity {
  kind: SessionActivityKind;
  /** The Notification message when awaiting input (a permission ask, never the idle prompt). */
  detail?: string;
}
