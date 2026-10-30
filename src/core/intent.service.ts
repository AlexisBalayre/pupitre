import { lstatSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPlainFile } from '../adapters/capability.utils.js';
import { IntentStatus } from './intent.enums.js';
import { IntentRefusedError } from './intent.errors.js';
import type { Intent, IntentListEntry } from './intent.types.js';

/**
 * Intents: what the operator wants, written down before any work starts, one
 * Markdown file each under the repo's `docs/intent/` (decision 126). Tracked
 * like the ADRs, so an intent travels with the code it is about and is
 * reviewed like it. Each file is `NNNN-<slug>.md`, opens with `# NNNN. Title`
 * and a `- Status:` line, and carries the template's five sections. The one
 * section pup reads meaning out of is the last: two or three questions the
 * operator must be able to answer once the work is reviewed, which
 * `pup intent accept` counts before it moves a draft to accepted.
 */

/** Where intents live, relative to the repo root. */
export const INTENT_DIR = 'docs/intent';

/** The heading whose questions `acceptIntent` counts, matched case-insensitively. */
const UNDERSTANDING_HEADING = 'What I must understand after review';

/** How many questions an accepted intent carries under the understanding heading. */
const MIN_QUESTIONS = 2;
const MAX_QUESTIONS = 3;

/**
 * An id is exactly four ASCII digits: never a path, a glob, a link name or a
 * control character. Every lookup checks it before touching the disk, and the
 * file is then found by listing the directory, never by joining the id in.
 */
const INTENT_ID = /^[0-9]{4}$/;

/** The only file names that are intents: anything else in the directory is never read. */
const INTENT_FILE = /^([0-9]{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** As many words of the title as an ADR file name carries. */
const SLUG_WORDS = 8;

// CONTROL_CHARS, FENCE_OPEN and FENCE_CLOSE are copies of brief.service.ts's, until a task shares them.

/**
 * C0 and C1 control characters, keeping newline and tab, as the brief strips
 * them (decision 57): `pup intent show` prints the file to the operator's
 * terminal, and a session may have written it.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * A title is one line of text: any control character, newline and tab
 * included, is refused, and so are U+2028 and U+2029, which end a line for
 * `TITLE_LINE` as a newline does. Refused before the file is written, so no
 * title leaves an intent that cannot be read back.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const TITLE_LINE = /^# ([0-9]{4})\. (.+)$/;
const STATUS_LINE = /^- Status: (.*)$/;
const SECTION_HEADING = /^ {0,3}## (.*)$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|[0-9]{1,9}[.)])[ \t]+(.*)$/;

/** Code fences, as the brief reads them: a heading or a list item inside one is text. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** An HTML comment block opens on a line starting `<!--` and runs to the first line holding `-->`. */
const COMMENT_OPEN = /^ {0,3}<!--/;

/** The file `pup intent new` writes: the title line, the status and the sections to fill. */
export function intentTemplate(id: string, title: string): string {
  return `# ${id}. ${title}

- Status: ${IntentStatus.Draft}

## Problem

## Outcome

## Constraints

## Open questions

## ${UNDERSTANDING_HEADING}

<!-- ${MIN_QUESTIONS} or ${MAX_QUESTIONS} questions, one list item each and ending in "?": what you must be
able to answer once the work is reviewed. \`pup intent accept\` refuses the intent without them. -->
`;
}

/** Create a draft intent numbered one past the highest in `docs/intent/`, and return it. */
export function createIntent(repoPath: string, title: string): Intent {
  const clean = title.trim();
  if (TITLE_CONTROL_CHARS.test(clean)) {
    throw new IntentRefusedError(
      'An intent title is one line of text, with no control characters.',
    );
  }
  if (!clean) throw new IntentRefusedError('An intent needs a title.');
  const dir = intentDir(repoPath, { create: true }) as string;
  const next = Math.max(0, ...intentFiles(dir).map((file) => Number(file.id))) + 1;
  if (next > 9999) {
    throw new IntentRefusedError(`${INTENT_DIR}/ already holds intent 9999; no id is left.`);
  }
  const id = String(next).padStart(4, '0');
  const path = join(dir, `${id}-${slug(clean)}.md`);
  try {
    // Exclusive: an intent another writer created first, or a link planted at
    // the name, is never written through.
    writeFileSync(path, intentTemplate(id, clean), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new IntentRefusedError(`${INTENT_DIR}/${id}-… appeared while creating it; run it again.`);
  }
  return loadIntent(path, id).intent;
}

/** The intent with this id, refused when the id is malformed or no single plain file holds it. */
export function readIntent(repoPath: string, id: string): Intent {
  return loadIntent(intentPath(repoPath, id), id).intent;
}

/** Every intent file in `docs/intent/`, by id, a malformed one listed with why. */
export function listIntents(repoPath: string): IntentListEntry[] {
  const dir = intentDir(repoPath);
  if (dir === undefined) return [];
  return intentFiles(dir).map(({ id, name }) => {
    try {
      return { id, intent: loadIntent(join(dir, name), id).intent };
    } catch (error) {
      if (!(error instanceof IntentRefusedError)) throw error;
      return { id, unreadable: error.message };
    }
  });
}

/**
 * Move a draft to accepted, refusing unless its understanding section holds
 * two or three questions. Only the status line changes; the rest of the file
 * is written back byte for byte. The caller decides who may accept: the CLI
 * keeps it the operator's.
 */
export function acceptIntent(repoPath: string, id: string): Intent {
  const path = intentPath(repoPath, id);
  const { intent, raw, statusLine } = loadIntent(path, id);
  if (intent.status !== IntentStatus.Draft) {
    throw new IntentRefusedError(`Intent ${id} is ${intent.status}; only a draft is accepted.`);
  }
  const count = intent.questions.length;
  if (count < MIN_QUESTIONS || count > MAX_QUESTIONS) {
    throw new IntentRefusedError(
      `Intent ${id} has ${count} question${count === 1 ? '' : 's'} under "## ${UNDERSTANDING_HEADING}"; ` +
        `accepting it takes ${MIN_QUESTIONS} or ${MAX_QUESTIONS}, one list item each, ending in "?".`,
    );
  }
  const lines = raw.split('\n');
  const carriageReturn = lines[statusLine]?.endsWith('\r') ? '\r' : '';
  lines[statusLine] = `- Status: ${IntentStatus.Accepted}${carriageReturn}`;
  // Staged beside it and renamed over it: a rename replaces whatever is at
  // the name, a link included, and never writes through one. The staged name
  // is no intent file name, so a reader never lists it.
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, lines.join('\n'), { flag: 'wx' });
  renameSync(staged, path);
  return loadIntent(path, id).intent;
}

/**
 * `docs/intent/` of the repo itself, or undefined when it does not exist and
 * `create` is off. Each of `docs` and `docs/intent` must be a real directory:
 * a link at either would carry every read and write somewhere of the linker's
 * choosing, so it is refused before anything is created under it.
 */
function intentDir(repoPath: string, { create = false } = {}): string | undefined {
  let path = repoPath;
  for (const part of INTENT_DIR.split('/')) {
    path = join(path, part);
    let isDirectory: boolean;
    try {
      isDirectory = lstatSync(path).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return undefined;
      mkdirSync(path);
      continue;
    }
    if (!isDirectory) {
      throw new IntentRefusedError(
        `${path} is not a directory: intents live only in the repo's own ${INTENT_DIR}/, never behind a link.`,
      );
    }
  }
  return path;
}

/** The intent files in the directory, by id. */
function intentFiles(dir: string): { id: string; name: string }[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const id = INTENT_FILE.exec(name)?.[1];
      return id === undefined ? [] : [{ id, name }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The one file holding `id`, after the id itself is checked. */
function intentPath(repoPath: string, id: string): string {
  if (!INTENT_ID.test(id)) {
    throw new IntentRefusedError(
      'An intent id is four digits, like 0001: never a path, a link or a name.',
    );
  }
  const dir = intentDir(repoPath);
  const matches = dir === undefined ? [] : intentFiles(dir).filter((file) => file.id === id);
  const [only] = matches;
  if (!only) throw new IntentRefusedError(`No intent ${id} in ${INTENT_DIR}/.`);
  if (matches.length > 1) {
    throw new IntentRefusedError(
      `Intent ${id} has ${matches.length} files in ${INTENT_DIR}/ (${matches.map((file) => file.name).join(', ')}); keep one.`,
    );
  }
  return join(dir as string, only.name);
}

/**
 * Read and parse one intent file. Only a plain file is read, never through a
 * link (the directory above it was checked by `intentDir`). Returns the raw
 * text and the status line's index beside the intent, for `acceptIntent`.
 */
function loadIntent(path: string, id: string): { intent: Intent; raw: string; statusLine: number } {
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

/**
 * Each line as the rendered file shows it as Markdown, or undefined inside a
 * code fence or an HTML comment block, which render as code or not at all.
 * Indexes match `lines`. A heading, a list item or a status line in either is
 * text, never structure, so nothing there can say what the reader cannot see.
 */
function visibleLines(lines: string[]): (string | undefined)[] {
  let fence: string | undefined;
  let comment = false;
  return lines.map((line) => {
    if (comment) {
      comment = !line.includes('-->');
      return undefined;
    }
    if (fence !== undefined) {
      const closer = FENCE_CLOSE.exec(line)?.[1];
      if (closer && closer[0] === fence[0] && closer.length >= fence.length) fence = undefined;
      return undefined;
    }
    const opener = FENCE_OPEN.exec(line)?.[1];
    if (opener) {
      fence = opener;
      return undefined;
    }
    if (COMMENT_OPEN.test(line)) {
      comment = !line.slice(line.indexOf('<!--') + 4).includes('-->');
      return undefined;
    }
    return line;
  });
}

/**
 * The list items ending in `?` under the first understanding heading, up to
 * the next level-2 heading, among the lines `visibleLines` shows: an example
 * in a fence or a comment neither opens the section nor counts as a question.
 */
function understandingQuestions(visible: (string | undefined)[]): string[] {
  const questions: string[] = [];
  let inSection = false;
  for (const line of visible) {
    if (line === undefined) continue;
    const heading = SECTION_HEADING.exec(line)?.[1];
    if (heading !== undefined) {
      if (inSection) break;
      inSection = heading.trim().toLowerCase() === UNDERSTANDING_HEADING.toLowerCase();
      continue;
    }
    const item = inSection ? LIST_ITEM.exec(line)?.[1]?.trim() : undefined;
    if (item?.endsWith('?')) questions.push(item);
  }
  return questions;
}

/** The title's first words, lowercased ASCII joined by hyphens, as the ADR file names are. */
function slug(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.slice(0, SLUG_WORDS).join('-') || 'intent';
}
