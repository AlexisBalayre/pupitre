import { describe, expect, it } from 'vitest';

import { STALLED_AFTER_MS } from './session-activity.constants.js';
import {
  classifySessionActivity,
  formatStaleAge,
  isSessionStalled,
} from './session-activity.utils.js';

function line(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

const POST_TOOL_USE = line({ hook_event_name: 'PostToolUse', tool_name: 'Read' });
const STOP = line({ hook_event_name: 'Stop', stop_hook_active: false });
const IDLE_NOTIFICATION = line({
  hook_event_name: 'Notification',
  message: 'Claude is waiting for your input',
  notification_type: 'idle_prompt',
});
const PERMISSION_NOTIFICATION = line({
  hook_event_name: 'Notification',
  message: 'Claude needs your permission to use Bash',
  notification_type: 'permission_request',
});

function backgroundBash(id: string, extra: Record<string, unknown> = {}): string {
  return line({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m wip', run_in_background: true },
    tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id, ...extra },
  });
}

function taskStop(id: string): string {
  return line({
    hook_event_name: 'PostToolUse',
    tool_name: 'TaskStop',
    tool_input: { task_id: id },
  });
}

describe('classifySessionActivity', () => {
  it('reports awaiting-input with the message when a Notification is the latest event', () => {
    const jsonl = [POST_TOOL_USE, STOP, PERMISSION_NOTIFICATION].join('\n');

    expect(classifySessionActivity(jsonl)).toEqual({
      kind: 'awaiting-input',
      detail: 'Claude needs your permission to use Bash',
    });
  });

  it('reports idle when a Stop is the latest event (turn ended, no done signal)', () => {
    const jsonl = [POST_TOOL_USE, IDLE_NOTIFICATION, POST_TOOL_USE, STOP].join('\n');

    expect(classifySessionActivity(jsonl)).toEqual({ kind: 'idle' });
  });

  it('reports working when tool activity is the latest event', () => {
    const jsonl = [STOP, IDLE_NOTIFICATION, POST_TOOL_USE].join('\n');

    expect(classifySessionActivity(jsonl)).toEqual({ kind: 'working' });
  });

  it('clears awaiting-input once activity resumes after the notification', () => {
    const jsonl = [PERMISSION_NOTIFICATION, POST_TOOL_USE].join('\n');

    expect(classifySessionActivity(jsonl).kind).toBe('working');
  });

  it('skips torn or malformed trailing lines from concurrent hook appends', () => {
    const jsonl = `${[POST_TOOL_USE, PERMISSION_NOTIFICATION].join('\n')}\nnull\n{"hook_event_name": "Post`;

    expect(classifySessionActivity(jsonl)).toEqual({
      kind: 'awaiting-input',
      detail: 'Claude needs your permission to use Bash',
    });
  });

  // Decision 103: the idle prompt follows a turn that ended; it asks nothing.
  it('reports idle, not awaiting-input, when the idle prompt is the latest event', () => {
    const jsonl = [POST_TOOL_USE, STOP, IDLE_NOTIFICATION, IDLE_NOTIFICATION].join('\n');

    expect(classifySessionActivity(jsonl)).toEqual({ kind: 'idle' });
  });

  it('reports idle for an idle prompt with no Stop before it, as after an interrupted turn', () => {
    expect(classifySessionActivity([POST_TOOL_USE, IDLE_NOTIFICATION].join('\n'))).toEqual({
      kind: 'idle',
    });
    expect(classifySessionActivity(IDLE_NOTIFICATION)).toEqual({ kind: 'idle' });
  });

  it('keeps every other notification type awaiting input', () => {
    const elicitation = line({
      hook_event_name: 'Notification',
      message: 'Claude has a question',
      notification_type: 'elicitation_dialog',
    });
    const untyped = line({ hook_event_name: 'Notification', message: 'Claude needs you' });

    expect(classifySessionActivity([STOP, elicitation].join('\n')).kind).toBe('awaiting-input');
    expect(classifySessionActivity([STOP, untyped].join('\n')).kind).toBe('awaiting-input');
  });

  describe('a turn that ended on a background shell', () => {
    it('reports background while the shell it launched has not reported back', () => {
      const jsonl = [STOP, backgroundBash('b2tbzdny7'), POST_TOOL_USE, STOP, IDLE_NOTIFICATION];

      expect(classifySessionActivity(jsonl.join('\n'))).toEqual({ kind: 'background' });
    });

    it('reports background for a foreground call moved to the background on its timeout', () => {
      const moved = backgroundBash('bgp19b3k2', { timedOutAfterMs: 120_000 });

      expect(classifySessionActivity([moved, STOP].join('\n'))).toEqual({ kind: 'background' });
    });

    it('reports background when the turn was interrupted after the launch, with no Stop', () => {
      const jsonl = [backgroundBash('b1'), IDLE_NOTIFICATION].join('\n');

      expect(classifySessionActivity(jsonl)).toEqual({ kind: 'background' });
    });

    it('reports idle once the turn stopped the shell it launched', () => {
      const jsonl = [backgroundBash('b1'), taskStop('b1'), STOP].join('\n');

      expect(classifySessionActivity(jsonl)).toEqual({ kind: 'idle' });
    });

    it('still reports background when the turn stopped a different shell', () => {
      const jsonl = [backgroundBash('b1'), backgroundBash('b2'), taskStop('b1'), STOP].join('\n');

      expect(classifySessionActivity(jsonl)).toEqual({ kind: 'background' });
    });

    it('reports idle when the shell reported back and the turn it started ended', () => {
      // The completion re-invokes the session: a turn with no new launch, then its Stop.
      const answered = [backgroundBash('b1'), STOP, IDLE_NOTIFICATION, POST_TOOL_USE, STOP];
      const textOnly = [backgroundBash('b1'), STOP, IDLE_NOTIFICATION, STOP];

      expect(classifySessionActivity(answered.join('\n'))).toEqual({ kind: 'idle' });
      expect(classifySessionActivity(textOnly.join('\n'))).toEqual({ kind: 'idle' });
    });

    it('reports working while the turn that launched it is still going', () => {
      expect(classifySessionActivity([STOP, backgroundBash('b1')].join('\n'))).toEqual({
        kind: 'working',
      });
    });
  });

  it('ignores events it does not classify', () => {
    const jsonl = [STOP, line({ hook_event_name: 'SessionStart' })].join('\n');

    expect(classifySessionActivity(jsonl)).toEqual({ kind: 'idle' });
  });

  it('reports unknown for an empty or event-free log', () => {
    expect(classifySessionActivity('')).toEqual({ kind: 'unknown' });
    expect(classifySessionActivity('\n\n')).toEqual({ kind: 'unknown' });
  });
});

describe('isSessionStalled', () => {
  it('is not stalled just under the threshold', () => {
    expect(isSessionStalled(STALLED_AFTER_MS - 1)).toBe(false);
  });

  it('is stalled at and past the threshold', () => {
    expect(isSessionStalled(STALLED_AFTER_MS)).toBe(true);
    expect(isSessionStalled(STALLED_AFTER_MS + 60_000)).toBe(true);
  });

  it('is not stalled for a fresh events file', () => {
    expect(isSessionStalled(0)).toBe(false);
  });
});

describe('formatStaleAge', () => {
  it('renders whole minutes, rounded', () => {
    expect(formatStaleAge(60_000)).toBe('1m');
    expect(formatStaleAge(90_000)).toBe('2m');
    expect(formatStaleAge(61 * 60_000)).toBe('61m');
  });
});
