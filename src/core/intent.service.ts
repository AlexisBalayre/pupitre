import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntentStatus } from './intent.enums.js';
import { IntentRefusedError } from './intent.errors.js';
import type { Intent, IntentListEntry } from './intent.types.js';
import { INTENT_DIR, intentDir, intentFiles, intentPath, slug } from './intent-files.utils.js';
import { UNDERSTANDING_HEADING } from './intent-markdown.utils.js';
import { loadIntent } from './intent-parse.utils.js';

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

/** Re-exported: the service is the interface part 2 reads (decision 126). */
export { INTENT_DIR };

/** How many questions an accepted intent carries under the understanding heading. */
const MIN_QUESTIONS = 2;
const MAX_QUESTIONS = 3;

/**
 * A title is one line of text: any control character, newline and tab
 * included, is refused, and so are U+2028 and U+2029, which end a line for
 * `TITLE_LINE` as a newline does. Refused before the file is written, so no
 * title leaves an intent that cannot be read back.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

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
  const highest = () => Math.max(0, ...intentFiles(dir).map((file) => Number(file.id)));
  // Two writers with different titles would each create their own slugged
  // name, so the id itself is reserved: an id-only file created exclusively,
  // held while the listing is checked again and the intent is written. A
  // writer holding it sees every intent an earlier holder wrote, so no id is
  // given twice. A reservation left by a crash only skips its id.
  for (let next = highest() + 1; next <= 9999; next = Math.max(next, highest()) + 1) {
    const id = String(next).padStart(4, '0');
    const reservation = join(dir, `${id}.reserved`);
    try {
      writeFileSync(reservation, '', { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      continue;
    }
    try {
      if (intentFiles(dir).some((file) => file.id === id)) continue;
      const path = join(dir, `${id}-${slug(clean)}.md`);
      // Exclusive: a link planted at the name is never written through.
      writeFileSync(path, intentTemplate(id, clean), { flag: 'wx' });
      return loadIntent(path, id).intent;
    } finally {
      unlinkSync(reservation);
    }
  }
  throw new IntentRefusedError(`${INTENT_DIR}/ already holds intent 9999; no id is left.`);
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
