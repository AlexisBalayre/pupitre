import { STALLED_AFTER_MS } from './session-activity.constants.js';
import type { SessionActivity } from './types/session-activity.types.js';

/**
 * Classify what a running session is doing from its hook event log (decision 2:
 * PostToolUse = activity, Notification = blocked on input, Stop = turn end).
 * The latest classifiable event wins: a Notification followed by tool activity
 * means the input arrived and the session is working again. Malformed lines are
 * skipped — hooks append concurrently, so a torn tail line is expected.
 *
 * A Notification's `message` is carried through as the hook wrote it: this is a
 * classifier, not a renderer, and the surface that prints it (`activityLabel`)
 * scrubs it at the fold, where decision 29 puts that work.
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

/**
 * A running session is stalled once its events file has gone quiet for
 * STALLED_AFTER_MS, regardless of what its last classified activity was — a
 * five-second permission ask and a silent hour-long wedge both read as
 * `awaiting-input`/`working` from the event log's content alone, so only the
 * file's age can tell them apart (decision 35).
 */
export function isSessionStalled(ageMs: number): boolean {
  return ageMs >= STALLED_AFTER_MS;
}

/** Whole minutes since the events file last changed, for a STALLED marker. */
export function formatStaleAge(ageMs: number): string {
  return `${Math.round(ageMs / 60_000)}m`;
}
