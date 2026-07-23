import type { SessionActivity } from './types/session-activity.types.js';

export type { SessionActivity, SessionActivityKind } from './types/session-activity.types.js';

/**
 * Classify what a running session is doing from its hook event log (decision 2:
 * PostToolUse = activity, Notification = blocked on input, Stop = turn end).
 * The latest classifiable event wins: a Notification followed by tool activity
 * means the input arrived and the session is working again. Malformed lines are
 * skipped — hooks append concurrently, so a torn tail line is expected.
 */
export function classifySessionActivity(eventsJsonl: string): SessionActivity {
  const lines = eventsJsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(lines[i] as string) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (event.hook_event_name) {
      case 'Notification':
        return {
          kind: 'awaiting-input',
          ...(typeof event.message === 'string' ? { detail: event.message } : {}),
        };
      case 'Stop':
        return { kind: 'idle' };
      case 'PostToolUse':
        return { kind: 'working' };
      default:
    }
  }
  return { kind: 'unknown' };
}
