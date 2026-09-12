/**
 * Pure parsers over `tmux capture-pane` text. Transport-level heuristics only —
 * session STATE must come from hooks/transcripts (decision 2), but verifying
 * that a paste physically reached the input box is a transport concern.
 *
 * Captures come from `capture-pane -e`, which keeps the styling, because that
 * is the only thing that tells the box's ghost text from a draft: Claude Code
 * renders the `Try "…"` hint AND the prompt it suggests after a turn dim
 * (SGR 2) in the box, where typed and pasted text carry no dim at all
 * (verified on 2.1.269). A capture taken without `-e` still parses — with no
 * escapes to read nothing is dim, and the `Try "` prefix is the fallback it
 * always was — but a suggested prompt in one is indistinguishable from a
 * draft, which is what refused every post-turn steer (addendum to decision 45).
 */

const INPUT_PROMPT = /^❯(.*)$/;
/** The box's bottom border; the rows between the prompt and it are the box. */
const BOX_BORDER = /^─/;
/**
 * The generic idle hint, for a capture with no styling to read. A styled one
 * needs no prefix: the hint is dim, like every other suggestion the box shows.
 */
const PLACEHOLDER_PREFIX = /^Try "/;
/**
 * Claude Code folds a paste over ~800 chars, or over a couple of lines, into
 * one placeholder; `+L lines` is the message's newline count (absent when 0).
 * Verified against Claude Code 2.1.263 panes.
 */
const PASTE_PLACEHOLDER = /^\[Pasted text #\d+(?: \+(\d+) lines)?\]$/;

/**
 * A CSI escape: where a `capture-pane -e` carries its styling. The OSC 8
 * hyperlinks Claude Code prints in its transcript are left as they fall — they
 * reach the box's rows nowhere, and a UI that put one there would leak its
 * payload into the box's text and refuse the steer, which is the side to fail
 * on.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const ESCAPE = /\u001b\[[0-9;:?]*[ -/]*[@-~]/g;
/** The CSI escape that carries styling, and the params that set and clear dim. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const SGR = /^\u001b\[([0-9;:]*)m$/;

/** One captured row, escapes removed. */
interface PaneRow {
  /** Every character the row shows — the structure is read from this. */
  text: string;
  /**
   * The same row with each dim character blanked, so offsets into `text` still
   * hold: what the row shows minus what Claude Code only suggests.
   */
  typed: string;
}

/**
 * The pane's rows. Dim is tracked across the whole capture, from the top and
 * in order, because tmux emits only the changes: a row inherits the attributes
 * the row above it left set, and `\u001b[39m` opening a row is the tail of the
 * colour the row before it used.
 */
function paneRows(pane: string): PaneRow[] {
  let dim = false;
  const blank = (chunk: string): string => (dim ? ' '.repeat(chunk.length) : chunk);
  return pane.split('\n').map((line) => {
    const row: PaneRow = { text: '', typed: '' };
    let index = 0;
    for (const sequence of line.matchAll(ESCAPE)) {
      const chunk = line.slice(index, sequence.index);
      row.text += chunk;
      row.typed += blank(chunk);
      const params = SGR.exec(sequence[0]);
      if (params) dim = applySgr(dim, params[1] as string);
      index = sequence.index + sequence[0].length;
    }
    const tail = line.slice(index);
    row.text += tail;
    row.typed += blank(tail);
    return row;
  });
}

/**
 * Dim after one SGR escape's params, applied left to right: 2 sets it, 22 and
 * a reset (0, or an empty param — `\u001b[m` is `\u001b[0m`) clear it. 38, 48
 * and 58 take a colour argument list that has to be skipped whole, or its
 * digits read as attributes: `38;5;2` is colour index 2, not dim, and
 * `38;5;22` is not a reset. Claude Code paints the box in 256 colours, so both
 * are shapes the real capture puts in front of this.
 */
function applySgr(dim: boolean, params: string): boolean {
  const codes = params.split(';');
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code === '38' || code === '48' || code === '58') {
      index += codes[index + 1] === '2' ? 4 : codes[index + 1] === '5' ? 2 : 1;
    } else if (code === '2') {
      dim = true;
    } else if (code === '0' || code === '' || code === '22') {
      dim = false;
    }
  }
  return dim;
}

/**
 * Text the user put in the input box, rows joined by newlines: the last
 * column-0 `❯` line and every row below it up to the box's bottom border,
 * prompt and indent stripped, and every dim run blanked — the hint and the
 * suggested next prompt are the box's, not the user's. The prompt `❯` renders
 * at column 0; dialog selectors and history lines are indented, so only
 * column-0 matches count, and the input box is the last one — a submitted
 * prompt is echoed above it with the same glyph. The box's prompt is followed
 * by a non-breaking space, which trims away like any other.
 * Undefined when the pane has no input box (a dialog, a dead pane).
 */
function inputBoxText(pane: string): string | undefined {
  const lines = paneRows(pane);
  let promptIndex = -1;
  lines.forEach((line, index) => {
    if (INPUT_PROMPT.test(line.text)) promptIndex = index;
  });
  if (promptIndex === -1) return undefined;
  const prompt = lines[promptIndex] as PaneRow;
  // `INPUT_PROMPT` anchors on the single `❯`, so the same one character of
  // the blanked row is the prompt there too.
  const rows = [prompt.typed.slice(1).trimStart()];
  for (const line of lines.slice(promptIndex + 1)) {
    if (BOX_BORDER.test(line.text)) break;
    rows.push(line.typed.replace(/^ {2}/, ''));
  }
  return rows.map((row) => row.trimEnd()).join('\n');
}

/**
 * True when the input box still holds unsubmitted text. What Claude Code only
 * suggests — the idle hint, and the next prompt it offers after a turn — is
 * not text: it is dim, `inputBoxText` has already blanked it, and a box
 * showing nothing else is empty. Pressing Ctrl-U at one clears nothing, so
 * reading it as a draft refused every steer to a session that had just
 * finished a turn.
 */
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
  // A paste replaces whatever the box was suggesting, so a box still showing a
  // suggestion holds nothing: blanked away already when the capture is styled,
  // and caught by the hint's prefix when it is not.
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
