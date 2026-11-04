import { readPlainFile } from '../adapters/capability.utils.js';
import { IntentStatus } from './intent.enums.js';
import { IntentRefusedError } from './intent.errors.js';
import type { Intent } from './intent.types.js';
import { INTENT_DIR } from './intent-files.utils.js';
import { SECTION_HEADING, understandingQuestions, visibleLines } from './intent-markdown.utils.js';

/**
 * One intent file read into an `Intent` (decision 126): its title line, its
 * one shown status line and its questions, or a refusal saying what is wrong.
 */

// CONTROL_CHARS is a copy of brief.service.ts's, until a task shares it.

/**
 * C0 and C1 control characters, keeping newline and tab, as the brief strips
 * them (decision 57): `pup intent show` prints the file to the operator's
 * terminal, and a session may have written it.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const TITLE_LINE = /^# ([0-9]{4})\. (.+)$/;
const STATUS_LINE = /^- Status: (.*)$/;

/**
 * Read and parse one intent file. Only a plain file is read, never through a
 * link (the directory above it was checked by `intentDir`). Returns the raw
 * text and the status line's index beside the intent, for `acceptIntent`.
 */
export function loadIntent(
  path: string,
  id: string,
): { intent: Intent; raw: string; statusLine: number } {
  const name = `${INTENT_DIR}/${path.slice(path.lastIndexOf('/') + 1)}`;
  let raw: string;
  try {
    raw = readPlainFile(path, { followLinks: false });
  } catch {
    throw new IntentRefusedError(
      `${name} is not a plain file pup can read: a link, a fifo or too big.`,
    );
  }
  // Stripping keeps every newline, so a line's index is the same in both texts.
  const text = raw.replace(CONTROL_CHARS, '');
  const lines = text.split('\n');
  const titled = TITLE_LINE.exec(lines[0] ?? '');
  const title = titled?.[2]?.trim();
  if (titled?.[1] !== id || !title) {
    throw new IntentRefusedError(`${name} does not open with "# ${id}. <title>".`);
  }
  const visible = visibleLines(lines);
  const { status, statusLine } = statusOf(name, lines, visible);
  return {
    intent: { id, title, status, path, text, questions: understandingQuestions(visible) },
    raw,
    statusLine,
  };
}

/**
 * The status and its line's index. Every status line above the first shown
 * section counts, hidden or not, and there must be exactly one, shown: pup
 * must read the status a reader of the rendered file sees, and a second line
 * in a comment or a fence is a way to make the two differ.
 */
function statusOf(
  name: string,
  lines: string[],
  visible: (string | undefined)[],
): { status: IntentStatus; statusLine: number } {
  const head = visible.findIndex(
    (line, index) => index > 0 && line !== undefined && SECTION_HEADING.test(line),
  );
  const statusLines = lines
    .slice(0, head === -1 ? lines.length : head)
    .flatMap((line, index) => (STATUS_LINE.test(line) ? [index] : []));
  const [statusLine = -1] = statusLines;
  const written = STATUS_LINE.exec(visible[statusLine] ?? '')?.[1]?.trim();
  const status = Object.values(IntentStatus).find((value) => value === written);
  if (statusLines.length !== 1 || status === undefined) {
    throw new IntentRefusedError(
      `${name} needs exactly one "- Status: draft|accepted|closed" line above its first ` +
        'section, outside any code fence or HTML comment.',
    );
  }
  return { status, statusLine };
}
