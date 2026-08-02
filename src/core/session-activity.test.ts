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
    const jsonl = `${[POST_TOOL_USE, IDLE_NOTIFICATION].join('\n')}\n{"hook_event_name": "Post`;

    expect(classifySessionActivity(jsonl)).toEqual({
      kind: 'awaiting-input',
      detail: 'Claude is waiting for your input',
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
