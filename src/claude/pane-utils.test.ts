import { describe, expect, it } from 'vitest';

import { hasUnsubmittedInput, pasteLanded } from './pane.utils.js';

// Fixtures are trimmed captures from live Claude Code 2.1.218 and 2.1.263 panes.

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

/** A 3000-char single-line paste, folded (2.1.263). */
const FOLDED_PANE = `⏺ ok
────────────────────────────────────────
❯ [Pasted text #26]
────────────────────────────────────────
                                        
  paste again to expand`;

/** A 19 KB, 150-line paste, folded with its newline count (2.1.263). */
const FOLDED_LINES_PANE = `────────────────────────────────────────
❯ [Pasted text #19 +149 lines]
────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)`;

/** A 300-char paste rendered inline, wrapped at the pane width (2.1.263). */
const INLINE_PANE = `────────────────────────────────────────
❯ HEAD word word word word word word wor
  word word word word word word TAIL.
────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)`;

/**
 * The reproduced failure: the box holds only the tail of a 1.8 KB message,
 * mid-ingestion, and its submitted echo sits above the box with the same glyph.
 */
const TAIL_ONLY_PANE = `❯ 19 tok120 tok121 tok122 tok123 tok124
  tok212 tok213 tok214 tok215 LASTWORD
⏺ Your message came through as a tail.
────────────────────────────────────────
❯ 19 tok120 tok121 tok122 tok123 tok124
  tok212 tok213 tok214 tok215 LASTWORD
────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)`;

/** A paste appended to a draft the box already held (2.1.263). */
const DRAFT_PLUS_PASTE_PANE = `────────────────────────────────────────
❯ row one[Pasted text #33]
────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)`;

const LONG_MESSAGE = `FIRSTWORD ${'tok '.repeat(700)}LASTWORD`;

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

  it('sees text on a continuation row when the prompt row itself is empty', () => {
    // A paste that starts with a newline leaves the prompt row blank; Ctrl-U
    // clears the box from the bottom up, so this is what a half-cleared box
    // looks like too.
    expect(hasUnsubmittedInput('────\n❯\n  second line\n────')).toBe(true);
  });

  it('reads the last prompt line, not the echo of a submitted one', () => {
    expect(hasUnsubmittedInput(`❯ submitted earlier\n⏺ ok\n────\n❯\n────`)).toBe(false);
  });
});

describe('pasteLanded', () => {
  it('accepts a folded single-line paste by its placeholder', () => {
    expect(pasteLanded(FOLDED_PANE, LONG_MESSAGE)).toBe(true);
  });

  it('accepts a folded multi-line paste only when the line count matches', () => {
    const context = Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n');
    expect(pasteLanded(FOLDED_LINES_PANE, context)).toBe(true);
    expect(pasteLanded(FOLDED_LINES_PANE, `${context}\nline 150`)).toBe(false);
    // A single-line placeholder is not a multi-line message's, and vice versa.
    expect(pasteLanded(FOLDED_PANE, context)).toBe(false);
    expect(pasteLanded(FOLDED_LINES_PANE, LONG_MESSAGE)).toBe(false);
  });

  it('accepts an inline paste that begins with the first word and ends with the last', () => {
    expect(pasteLanded(INLINE_PANE, `HEAD ${'word '.repeat(13)}TAIL.`)).toBe(true);
  });

  it('refuses a box holding only the tail of the message', () => {
    const message = `FIRSTWORD Reply with ${Array.from({ length: 230 }, (_, i) => `tok${i}`).join(' ')} LASTWORD`;
    expect(pasteLanded(TAIL_ONLY_PANE, message)).toBe(false);
  });

  it('refuses a paste appended to a draft already in the box', () => {
    expect(pasteLanded(DRAFT_PLUS_PASTE_PANE, LONG_MESSAGE)).toBe(false);
  });

  it('refuses an empty box, the idle hint, and a pane without an input box', () => {
    expect(pasteLanded(SUBMITTED_PANE, 'do X instead')).toBe(false);
    expect(pasteLanded(IDLE_PLACEHOLDER_PANE, 'Try "write a test for <filepath>"')).toBe(false);
    expect(pasteLanded('Accessing workspace:\n ❯ 1. Yes, I trust this folder', 'yes')).toBe(false);
  });

  it('never reports a blank message as landed', () => {
    expect(pasteLanded(SUBMITTED_PANE, '  \n')).toBe(false);
  });
});
