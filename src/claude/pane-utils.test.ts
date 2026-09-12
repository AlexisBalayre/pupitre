import { describe, expect, it } from 'vitest';

import { hasUnsubmittedInput, pasteLanded } from './pane.utils.js';

// Fixtures are trimmed captures from live Claude Code 2.1.218, 2.1.263 and
// 2.1.269 panes. The unstyled ones are `capture-pane -p`; the STYLED_ ones are
// `capture-pane -p -e`, which is what the runtime takes, with the escapes
// written as \u001b and the real prompt's non-breaking space as \u00a0 so
// neither is invisible in the source.

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

/** The box's border, trimmed; the colour is the one 2.1.269 paints it. */
const BORDER = `\u001b[38;5;244m${'\u2500'.repeat(40)}`;

/**
 * A box showing only the prompt Claude Code suggests after a turn: dim, and
 * the operator's first steer after decision 45 merged was refused because of
 * it. The styling and the prompt's non-breaking space are a verbatim live
 * capture (2.1.269 renders its idle hint in exactly this slot, see
 * STYLED_HINT_PANE); the suggestion's own text is the one captured on
 * 2026-09-06, when a steer to a session that had finished its turn read it as
 * a draft Ctrl-U could not clear.
 */
const STYLED_SUGGESTION_PANE = `${BORDER}
\u001b[39m\u276f\u00a0\u001b[2mrun the security review on this branch\u001b[0m
${BORDER}
\u001b[39m  \u001b[38;5;211m\u23f5\u23f5 bypass permissions on\u001b[38;5;246m (shift+tab to cycle)\u001b[39m`;

/** The idle hint, styled: the same dim slot the suggestion above uses. */
const STYLED_HINT_PANE = `${BORDER}
\u001b[39m\u276f\u00a0\u001b[2mTry "how does <filepath> work?"\u001b[0m
${BORDER}`;

/** Typed text, styled: no dim anywhere — that is the whole discriminator. */
const STYLED_DRAFT_PANE = `${BORDER}
\u001b[39m\u276f\u00a0draft text
${BORDER}`;

/** An empty box mid-turn: the prompt greys out, but with a colour, not dim. */
const STYLED_EMPTY_PANE = `${BORDER}
\u001b[38;5;246m\u276f\u00a0\u001b[39m
${BORDER}`;

/** A folded paste, styled: Claude Code prints its placeholder undimmed. */
const STYLED_FOLDED_PANE = `${BORDER}
\u001b[39m\u276f\u00a0[Pasted text #1]
${BORDER}
\u001b[39m  \u001b[38;5;246mpaste again to expand\u001b[39m`;

/** An inline paste wrapped onto a second row, which carries no escapes at all. */
const STYLED_INLINE_PANE = `${BORDER}
\u001b[39m\u276f\u00a0HEAD word word word word word word word
  word word word word word word TAIL.
${BORDER}`;

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

  it('reads a box showing only the prompt Claude Code suggests as empty', () => {
    expect(hasUnsubmittedInput(STYLED_SUGGESTION_PANE)).toBe(false);
    expect(hasUnsubmittedInput(STYLED_HINT_PANE)).toBe(false);
    expect(hasUnsubmittedInput(STYLED_EMPTY_PANE)).toBe(false);
  });

  it('tells the suggestion from the same words typed, by the dim alone', () => {
    // The discriminating pair: identical text in the box, and only the escapes
    // around it differ. A steer must clear the second and paste straight over
    // the first, where Ctrl-U has nothing to take.
    const suggested = STYLED_SUGGESTION_PANE;
    const typed = suggested.replace('\u001b[2mrun the security', 'run the security');
    expect(hasUnsubmittedInput(suggested)).toBe(false);
    expect(hasUnsubmittedInput(typed)).toBe(true);
  });

  it('keeps a draft that a suggestion is completing', () => {
    // Ghost-completion: what was typed stands undimmed, the rest is suggested.
    expect(
      hasUnsubmittedInput(
        `${BORDER}\n\u001b[39m\u276f\u00a0run the \u001b[2msecurity review\u001b[0m\n${BORDER}`,
      ),
    ).toBe(true);
  });

  it('reads dim a second row inherits, since tmux emits only the changes', () => {
    // A suggestion long enough to wrap leaves dim set at the row's end, and
    // the row below opens with no escape of its own.
    const wrapped = `${BORDER}\n\u001b[39m\u276f\u00a0\u001b[2mrun the security review\n  on this branch\u001b[0m\n${BORDER}`;
    expect(hasUnsubmittedInput(wrapped)).toBe(false);
  });

  it('does not read a 256-colour index as an attribute', () => {
    // `38;5;2` is colour index 2 and `38;5;22` is not a reset; splitting the
    // params without skipping the colour's arguments reads both as dim.
    expect(hasUnsubmittedInput(`${BORDER}\n\u001b[38;5;2m\u276f\u00a0draft text\n${BORDER}`)).toBe(
      true,
    );
    expect(
      hasUnsubmittedInput(
        `${BORDER}\n\u001b[2m\u276f\u00a0\u001b[38;5;22msuggested\u001b[0m\n${BORDER}`,
      ),
    ).toBe(false);
  });

  it('is unmoved by the OSC 8 hyperlinks the transcript above the box carries', () => {
    // Only CSI is read, so a link's payload stays in the row it is on; the box
    // is what the last column-0 prompt opens, and no link reaches it.
    const link = '\u001b]8;id=1;https://claude.ai/code\u001b\\/rc\u001b]8;;\u001b\\';
    expect(hasUnsubmittedInput(`${link}\n${STYLED_SUGGESTION_PANE}`)).toBe(false);
    expect(hasUnsubmittedInput(`${link}\n${STYLED_DRAFT_PANE}`)).toBe(true);
  });

  it('sees typed text in a styled capture, and the draft under a folded paste', () => {
    expect(hasUnsubmittedInput(STYLED_DRAFT_PANE)).toBe(true);
    expect(hasUnsubmittedInput(STYLED_FOLDED_PANE)).toBe(true);
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

  it('accepts a paste in a styled capture, folded or inline', () => {
    expect(pasteLanded(STYLED_FOLDED_PANE, LONG_MESSAGE)).toBe(true);
    expect(pasteLanded(STYLED_INLINE_PANE, `HEAD ${'word '.repeat(13)}TAIL.`)).toBe(true);
  });

  it('refuses a box showing only a suggestion, whichever one it is', () => {
    // Nothing was pasted: the box is empty and offering a prompt of its own.
    expect(pasteLanded(STYLED_SUGGESTION_PANE, 'run the security review on this branch')).toBe(
      false,
    );
    expect(pasteLanded(STYLED_HINT_PANE, 'Try "how does <filepath> work?"')).toBe(false);
  });
});
