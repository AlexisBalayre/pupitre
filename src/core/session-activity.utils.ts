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
  const events = eventsJsonl.split('\n').flatMap(parseEvent);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as Record<string, unknown>;
    if (isTurnEnd(event)) {
      return { kind: endedOnBackgroundShell(events, turnEndOf(events, i)) ? 'background' : 'idle' };
    }
    switch (event.hook_event_name) {
      case 'Notification':
        return {
          kind: 'awaiting-input',
          ...(typeof event.message === 'string' ? { detail: event.message } : {}),
        };
      case 'PostToolUse':
        return { kind: 'working' };
      default:
    }
  }
  return { kind: 'unknown' };
}

function parseEvent(line: string): Record<string, unknown>[] {
  try {
    const event: unknown = JSON.parse(line);
    return typeof event === 'object' && event !== null ? [event as Record<string, unknown>] : [];
  } catch {
    return [];
  }
}

function isIdlePrompt(event: Record<string, unknown>): boolean {
  return event.hook_event_name === 'Notification' && event.notification_type === 'idle_prompt';
}

function isTurnEnd(event: Record<string, unknown>): boolean {
  return event.hook_event_name === 'Stop' || isIdlePrompt(event);
}

/**
 * The event that ended the turn an idle prompt at `at` follows: the Stop before
 * it, past any earlier prompts, or the prompt itself when no Stop fired, as on
 * a turn interrupted with Escape. A Stop right before another Stop is a turn of
 * its own, so only prompts are skipped.
 */
function turnEndOf(events: Record<string, unknown>[], at: number): number {
  for (let i = at; i >= 0; i--) {
    const event = events[i] as Record<string, unknown>;
    if (event.hook_event_name === 'Stop') return i;
    if (!isIdlePrompt(event) && isClassified(event)) return at;
  }
  return at;
}

function isClassified(event: Record<string, unknown>): boolean {
  return ['Notification', 'Stop', 'PostToolUse'].includes(event.hook_event_name as string);
}

/**
 * Whether the turn that ended at `stopAt` launched a background shell it did
 * not stop before ending. A Bash call's PostToolUse carries a `backgroundTaskId`
 * when the shell went to the background, asked for or moved there on its
 * timeout, and a `TaskStop` names the id it ended. The turn runs back to the
 * previous Stop or idle prompt. Nothing in the log says when a shell exits on
 * its own: its completion re-invokes the session, whose next events start a new
 * turn, but one that exits while its own turn is still going reads `background`
 * until the stall rule catches the quiet (decision 103).
 */
function endedOnBackgroundShell(events: Record<string, unknown>[], stopAt: number): boolean {
  const stopped = new Set<unknown>();
  for (let i = stopAt - 1; i >= 0; i--) {
    const event = events[i] as Record<string, unknown>;
    if (event.hook_event_name === 'Stop' || isIdlePrompt(event)) return false;
    if (event.hook_event_name !== 'PostToolUse') continue;
    const input = asRecord(event.tool_input);
    if (event.tool_name === 'TaskStop') stopped.add(input.task_id ?? input.shell_id);
    const shell = asRecord(event.tool_response).backgroundTaskId;
    if (event.tool_name === 'Bash' && typeof shell === 'string' && !stopped.has(shell)) return true;
  }
  return false;
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
