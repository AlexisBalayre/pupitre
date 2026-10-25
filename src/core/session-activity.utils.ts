import { STALLED_AFTER_MS } from './session-activity.constants.js';
import type { SessionActivity } from './types/session-activity.types.js';

/**
 * Classify what a running session is doing from its hook event log (decision 2:
 * PostToolUse = activity, Notification = blocked on input, Stop = turn end).
 * The latest classifiable event wins: a Notification followed by tool activity
 * means the input arrived and the session is working again. Malformed lines are
 * skipped — hooks append concurrently, so a torn tail line is expected.
 *
 * The idle prompt Claude Code sends a minute after a turn ends is a turn end,
 * not a question (decision 103): only the other notification types, a
 * permission ask first among them, wait on the operator. A turn that ended on
 * a background shell it launched and never stopped is still at work on that
 * shell, so it reads `background`, not idle.
 *
 * A Notification's `message` is carried through as the hook wrote it: this is a
 * classifier, not a renderer, and the surface that prints it (`activityLabel`)
 * scrubs it at the fold, where decision 29 puts that work.
 */
export function classifySessionActivity(eventsJsonl: string): SessionActivity {
  // Walked newest first: past the latest turn end, then through the turn it
  // ended, back to the end of the turn before. A run of idle prompts follows
  // one Stop, or stands in for it after a turn interrupted with Escape; a Stop
  // right before another Stop ended a turn of its own.
  let ended = false;
  let inTurn = false;
  const stopped = new Set<unknown>();
  for (const event of eventsJsonl.split('\n').flatMap(parseEvent).reverse()) {
    const activity = activityOf(event);
    if (event.hook_event_name === 'Stop' || isIdlePrompt(event)) {
      if (inTurn) return { kind: 'idle' };
      ended = true;
      inTurn = event.hook_event_name === 'Stop';
    } else if (!ended) {
      if (activity) return activity;
    } else if (activity) {
      inTurn = true;
      if (launchedUnstopped(event, stopped)) return { kind: 'background' };
    }
  }
  return { kind: ended ? 'idle' : 'unknown' };
}

function parseEvent(line: string): Record<string, unknown>[] {
  try {
    return [asRecord(JSON.parse(line))];
  } catch {
    return [];
  }
}

function isIdlePrompt(event: Record<string, unknown>): boolean {
  return event.hook_event_name === 'Notification' && event.notification_type === 'idle_prompt';
}

/** What an event other than a turn end says the session is doing, if anything. */
function activityOf(event: Record<string, unknown>): SessionActivity | undefined {
  switch (event.hook_event_name) {
    case 'Notification':
      return {
        kind: 'awaiting-input',
        ...(typeof event.message === 'string' ? { detail: event.message } : {}),
      };
    case 'PostToolUse':
      return { kind: 'working' };
    default:
      return undefined;
  }
}

/**
 * Whether this event of a turn that has ended launched a background shell no
 * later event of the turn stopped; `stopped` collects, newest first, the ids
 * the turn's `TaskStop` calls ended. A Bash call's PostToolUse carries a
 * `backgroundTaskId` when the shell went to the background, asked for or moved
 * there on its timeout. Nothing in the log says when a shell exits on its own:
 * its completion re-invokes the session, whose next events start a new turn,
 * but one that exits while its own turn is still going reads `background`
 * until the stall rule catches the quiet (decision 103).
 */
function launchedUnstopped(event: Record<string, unknown>, stopped: Set<unknown>): boolean {
  if (event.tool_name === 'TaskStop') stopped.add(asRecord(event.tool_input).task_id);
  const shell = asRecord(event.tool_response).backgroundTaskId;
  return event.tool_name === 'Bash' && typeof shell === 'string' && !stopped.has(shell);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
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
