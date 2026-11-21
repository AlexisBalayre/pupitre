import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { GATE_COMMAND_TIMEOUT_MS } from '../core/constants/merge-gate.constants.js';
import { runGit, runGitBytes } from '../core/git-diff.client.js';
import { readPlainFile } from './capability.utils.js';
import type { RootFiles } from './types/adapter.types.js';

/** Timed like every other child pup runs: git reads config a session can write. */
const GIT_READ: Parameters<typeof runGit>[2] = {
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: GATE_COMMAND_TIMEOUT_MS,
};

/** The tree modes of a regular file; a link, a submodule or a directory is none. */
const PLAIN_BLOB_MODE = /^100(?:644|755)$/;

/** A directory's tree mode, which `ls-tree` lists recursively. */
const TREE_MODE = '040000';

/** A link's tree mode: its blob is the link's target, as text. */
const LINK_MODE = '120000';

/** A submodule's tree mode, which `ls-tree -r` lists as one line, its commit. */
const GITLINK_MODE = '160000';

/** The longest line `hash-object` prints for one file: a SHA-256 name and its newline. */
const OBJECT_NAME_LINE_BYTES = 65;

function unreadable(name: string): () => string {
  return () => {
    throw new Error(`${name} is not read: a name not in lower case, or not a plain file`);
  };
}

/** Higher for a name not in lower case, which sorts after one that is. */
const notLowerCase = ([name]: [string, unknown]): number => Number(name !== name.toLowerCase());

/**
 * A character outside ASCII. APFS folds some onto ASCII by its own tables
 * (`ſ` onto `s`), which no JavaScript case mapping reproduces, so a root name
 * holding one may open for any file a run reads.
 */
export const NON_ASCII = /[\u0080-￿]/;

/** Throws where a name holds a character outside ASCII (`NON_ASCII`). */
function rootFiles(entries: [string, () => string][]): RootFiles {
  if (entries.some(([name]) => NON_ASCII.test(name))) {
    throw new Error('a root name outside ASCII may open for any file a run reads');
  }
  const root: RootFiles = new Map();
  // Lower-case names first, so one that folds onto another replaces its read.
  for (const [name, read] of entries.sort((a, b) => notLowerCase(a) - notLowerCase(b))) {
    const key = name.toLowerCase();
    root.set(key, name === key ? read : unreadable(name));
  }
  return root;
}

/** A listing's lines in one order, whichever order they were found in. */
function listing(lines: string[]): string {
  return lines.sort().join('\0');
}

/**
 * A directory on disk listed as `ls-tree -r -z` lists a tree: a line per file,
 * its mode, object name and path, each file hashed in `repoPath`'s object
 * format and nothing written. A link lists as a tree lists one, by the object
 * name of its target's text, never followed (`diskLinkName`). An empty
 * directory, which no tree holds, lists nothing, as does the submodule a
 * checkout leaves uninitialised (`treeListing`). Throws on anything else a
 * tree would not check out as a plain file or a link, and on a name holding a
 * line break, which `hash-object` cannot read back from its input.
 */
function diskListing(repoPath: string, dir: string): string {
  const files: { path: string; mode: string }[] = [];
  const links: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(join(dir, at), { withFileTypes: true })) {
      const path = at === '' ? entry.name : `${at}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
      } else if (/[\r\n]/.test(path) || !(entry.isFile() || entry.isSymbolicLink())) {
        throw new Error(`${path} is not read: not a plain file or a link named on one line`);
      } else if (entry.isSymbolicLink()) {
        links.push(`${LINK_MODE} blob ${diskLinkName(repoPath, join(dir, path))}\t${path}`);
      } else {
        const executable = (lstatSync(join(dir, path)).mode & 0o100) !== 0;
        files.push({ path, mode: executable ? '100755' : '100644' });
      }
    }
  };
  walk('');
  if (files.length === 0) return listing(links);
  const names = runGitBytes(repoPath, ['hash-object', '--no-filters', '--stdin-paths'], {
    input: Buffer.from(files.map(({ path }) => `${join(dir, path)}\n`).join('')),
    maxBuffer: files.length * OBJECT_NAME_LINE_BYTES,
    timeout: GATE_COMMAND_TIMEOUT_MS,
  })
    .toString('utf8')
    .split('\n');
  return listing([
    ...links,
    ...files.map(({ path, mode }, i) => `${mode} blob ${names[i]}\t${path}`),
  ]);
}

/**
 * A link's object name as a tree holds it: its target's bytes hashed as a blob
 * in `repoPath`'s format, the link never followed, and nothing written.
 */
function diskLinkName(repoPath: string, path: string): string {
  return runGitBytes(repoPath, ['hash-object', '--no-filters', '--stdin'], {
    input: readlinkSync(path, { encoding: 'buffer' }),
    maxBuffer: OBJECT_NAME_LINE_BYTES,
    timeout: GATE_COMMAND_TIMEOUT_MS,
  })
    .toString('utf8')
    .trim();
}

/**
 * A tree as `ls-tree -r` lists it, as `diskListing` lists one on disk: a
 * submodule's line left out, since the gate checks one out as the empty
 * directory a disk listing holds nothing of, whichever commit it names.
 */
function treeListing(repoPath: string, oid: string): string {
  return listing(
    runGit(repoPath, ['ls-tree', '--full-tree', '-r', '-z', oid], GIT_READ)
      .split('\0')
      .filter((line) => line !== '' && !line.startsWith(`${GITLINK_MODE} `)),
  );
}

/**
 * A plain file's object name in `repoPath`'s format, hashed as it stands, of
 * any size, and nothing written. Throws on a link or anything else a tree
 * would not check out as a plain file.
 */
function diskObjectName(repoPath: string, path: string): string {
  if (!lstatSync(path).isFile()) throw new Error(`${path} is not read: not a plain file`);
  return runGit(repoPath, ['hash-object', '--no-filters', '--', path], GIT_READ).trim();
}

/**
 * A checkout's root as it stands on disk, each file read without following a
 * link. Given the `repoPath` whose object format hashes its files, a directory
 * reads as the listing of its tree (`diskListing`), and with `byObjectName` a
 * file reads as its object name (`diskObjectName`), as `treeRoot` reads a
 * blob with it, so a file over the cap a text read has, such as a root
 * lockfile, still compares with a commit's. Without `repoPath`, a directory
 * is not read and a file reads as its text.
 */
export function diskRoot(
  checkout: string,
  repoPath?: string,
  { byObjectName = false } = {},
): RootFiles {
  return rootFiles(
    readdirSync(checkout, { withFileTypes: true }).map((entry) => {
      const path = join(checkout, entry.name);
      const read =
        repoPath !== undefined && entry.isDirectory()
          ? () => diskListing(repoPath, path)
          : repoPath !== undefined && byObjectName
            ? () => diskObjectName(repoPath, path)
            : () => readPlainFile(path, { followLinks: false });
      return [entry.name, read];
    }),
  );
}

/**
 * A commit's root, listed and read from `repoPath`'s object store, never from a
 * checkout a session's code has run in (decision 143), each listing with
 * `--full-tree`, so a session's `core.worktree` cannot narrow it to a prefix
 * (decision 161). Only a regular file's
 * blob is read, so a link is not followed, as its text or, with
 * `byObjectName`, as its object name; a directory reads as `treeListing`
 * lists it, as `diskRoot` lists one on disk.
 */
export function treeRoot(repoPath: string, sha: string, { byObjectName = false } = {}): RootFiles {
  return rootFiles(
    runGit(repoPath, ['ls-tree', '--full-tree', '-z', sha], GIT_READ)
      .split('\0')
      .filter((entry) => entry !== '')
      .map((entry) => {
        // "<mode> <type> <oid>\t<name>": the name is everything after the first tab.
        const tab = entry.indexOf('\t');
        const [mode = '', , oid = ''] = entry.slice(0, tab).split(' ');
        const name = entry.slice(tab + 1);
        const read = PLAIN_BLOB_MODE.test(mode)
          ? byObjectName
            ? () => oid
            : () => runGit(repoPath, ['cat-file', 'blob', oid], GIT_READ)
          : mode === TREE_MODE
            ? () => treeListing(repoPath, oid)
            : unreadable(name);
        return [name, read];
      }),
  );
}

/**
 * A commit's entries anywhere in its tree whose path `pattern` matches, as
 * `ls-tree -r` lists them: mode, object name and path, so two commits holding
 * the same such files give the same listing. Read from `repoPath`'s object
 * store, the whole tree whatever directory a session's `core.worktree` makes
 * git think it runs in (decision 161).
 */
export function treeEntriesMatching(repoPath: string, sha: string, pattern: RegExp): string {
  return listing(
    runGit(repoPath, ['ls-tree', '--full-tree', '-r', '-z', sha], GIT_READ)
      .split('\0')
      .filter((line) => line !== '' && pattern.test(line.slice(line.indexOf('\t') + 1))),
  );
}
