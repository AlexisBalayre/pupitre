import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IntentRefusedError } from './intent.errors.js';

/**
 * Where intents sit on disk (decision 126): the repo's own `docs/intent/`,
 * never behind a link, and a file found only by listing it, never by joining
 * an id into a path.
 */

/** Where intents live, relative to the repo root. */
export const INTENT_DIR = 'docs/intent';

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

/**
 * `docs/intent/` of the repo itself, or undefined when it does not exist and
 * `create` is off. Each of `docs` and `docs/intent` must be a real directory:
 * a link at either would carry every read and write somewhere of the linker's
 * choosing, so it is refused before anything is created under it.
 */
export function intentDir(repoPath: string, { create = false } = {}): string | undefined {
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
export function intentFiles(dir: string): { id: string; name: string }[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const id = INTENT_FILE.exec(name)?.[1];
      return id === undefined ? [] : [{ id, name }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The one file holding `id`, after the id itself is checked. */
export function intentPath(repoPath: string, id: string): string {
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

/** The title's first words, lowercased ASCII joined by hyphens, as the ADR file names are. */
export function slug(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.slice(0, SLUG_WORDS).join('-') || 'intent';
}
