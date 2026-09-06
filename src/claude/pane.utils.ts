/**
 * Pure parsers over `tmux capture-pane` text. Transport-level heuristics only —
 * session STATE must come from hooks/transcripts (decision 2), but verifying
 * that a paste physically reached the input box is a transport concern.
 */

const INPUT_PROMPT = /^❯(.*)$/;
/** The box's bottom border; the rows between the prompt and it are the box. */
const BOX_BORDER = /^─/;
/** Empty input box renders a dimmed hint (`❯ Try "…"`), not user text. */
const PLACEHOLDER_PREFIX = /^Try "/;
/**
 * Claude Code folds a paste over ~800 chars, or over a couple of lines, into
 * one placeholder; `+L lines` is the message's newline count (absent when 0).
 * Verified against Claude Code 2.1.263 panes.
 */
const PASTE_PLACEHOLDER = /^\[Pasted text #\d+(?: \+(\d+) lines)?\]$/;

/**
 * Text in the input box, rows joined by newlines: the last column-0 `❯` line
 * and every row below it up to the box's bottom border, prompt and indent
 * stripped. The prompt `❯` renders at column 0; dialog selectors and history
 * lines are indented, so only column-0 matches count, and the input box is the
 * last one — a submitted prompt is echoed above it with the same glyph.
 * Undefined when the pane has no input box (a dialog, a dead pane).
 */
function inputBoxText(pane: string): string | undefined {
  const lines = pane.split('\n');
  let promptIndex = -1;
  lines.forEach((line, index) => {
    if (INPUT_PROMPT.test(line)) promptIndex = index;
  });
  if (promptIndex === -1) return undefined;
  const rows = [(INPUT_PROMPT.exec(lines[promptIndex] as string)?.[1] ?? '').trimStart()];
  for (const line of lines.slice(promptIndex + 1)) {
    if (BOX_BORDER.test(line)) break;
    rows.push(line.replace(/^ {2}/, ''));
  }
  return rows.map((row) => row.trimEnd()).join('\n');
}

/** True when the input box still holds unsubmitted text. */
export function hasUnsubmittedInput(pane: string): boolean {
  const content = inputBoxText(pane)?.trim() ?? '';
  return content.length > 0 && !PLACEHOLDER_PREFIX.test(content);
}

/**
 * True when the input box holds `message` whole, as far as the pane can show
 * it. A folded paste shows only its placeholder, so the line count is the one
 * thing that can be checked; an inline paste must begin with the message's
 * first word and end with its last. Both checks refuse a partial arrival —
 * the observed failure was a paste whose head never made it into the box —
 * and a word wrapped mid-way by a narrow pane is refused rather than guessed.
 */
export function pasteLanded(pane: string, message: string): boolean {
  const box = inputBoxText(pane)?.trim();
  // A paste replaces the idle hint, so a box still showing it holds nothing.
  if (box === undefined || PLACEHOLDER_PREFIX.test(box)) return false;
  const placeholder = PASTE_PLACEHOLDER.exec(box);
  if (placeholder) {
    const newlines = message.split('\n').length - 1;
    return Number(placeholder[1] ?? 0) === newlines;
  }
  const words = message.split(/\s+/).filter((word) => word.length > 0);
  const first = words[0];
  const last = words.at(-1);
  if (first === undefined || last === undefined) return false;
  return box.startsWith(first) && box.endsWith(last);
}
