import { describe, expect, it } from 'vitest';

import { hasUnsubmittedInput } from './pane.utils.js';

// Fixtures are trimmed captures from live Claude Code 2.1.218 panes.

const PENDING_PANE = `  context line 19
  context line 20
────────────────────────────────────────
❯ context line 21
  context line 22
────────────────────────────────────────
  pup-test
  ⏵⏵ auto mode on (shift+tab to cycle)`;

const SUBMITTED_PANE = `  context line 39
⏺ ok
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents`;

const IDLE_PLACEHOLDER_PANE = `╰──────────────╯
────────────────────────────────────────
❯ Try "write a test for <filepath>"
────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)`;

describe('hasUnsubmittedInput', () => {
  it('detects pasted text still sitting in the input box', () => {
    expect(hasUnsubmittedInput(PENDING_PANE)).toBe(true);
  });

  it('reports an empty input box after submission as submitted', () => {
    expect(hasUnsubmittedInput(SUBMITTED_PANE)).toBe(false);
  });

  it('does not mistake the Try-a-prompt placeholder for pending input', () => {
    expect(hasUnsubmittedInput(IDLE_PLACEHOLDER_PANE)).toBe(false);
  });

  it('reports panes without an input prompt line as submitted', () => {
    // Dialog selectors render indented (` ❯ 1. …`), never at column 0.
    expect(hasUnsubmittedInput('Accessing workspace:\n ❯ 1. Yes, I trust this folder')).toBe(false);
  });
});
