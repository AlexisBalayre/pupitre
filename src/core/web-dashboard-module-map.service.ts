import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type Stats,
} from 'node:fs';
import { join, posix } from 'node:path';
import type { Database } from 'better-sqlite3';

import { listLedgerEntries } from './ledger.repository.js';
import { projectId } from './paths.utils.js';
import { asStringArray, parseJsonOr } from './report-data.utils.js';
import { decodeEvent, type EventRow } from './session.repository.js';
import type { SessionEvent } from './types/session-event.types.js';
import { DAY_MS, oneLine } from './web-dashboard-sheet.utils.js';

/** One file of the checkout's `src/`, with what weighs on it. */
interface ModuleMapFile {
  /** Repo-relative, through `oneLine`. */
  file: string;
  lines: number;
  openDebt: number;
  /** Sessions whose merge in the window touched it. */
  merges: number;
}

export interface ModuleMap {
  files: ModuleMapFile[];
  /** Files left out: not a plain file, unreadable, or over the size cap. */
  unread: number;
  /** The walk stopped at a cap before reaching every file. */
  capped: boolean;
  /** The day the merge window opens, `YYYY-MM-DD` UTC. */
  mergesSince: string;
}

/** The directory the module map covers, under the project root. */
export const MAP_ROOT = 'src';
export const MERGE_WINDOW_DAYS = 30;
/** Never walked into: another checkout's files, or dependencies, not the project's. */
const SKIPPED_DIRS = new Set(['node_modules', '.worktrees']);
const MAX_FILE_BYTES = 1 << 20;
/** The walk's bounds, as the sheet is re-read on every poll (decision 98's hardening). */
const MAP_LIMITS = { files: 5_000, bytes: 64 << 20 };
const NEWLINE = 0x0a;

/** A file's module, as `pup map` names it: its directory. */
export function moduleOf(file: string): string {
  const dir = posix.dirname(file);
  return dir === '.' ? '(root)' : dir;
}

/** Open entries per file, each entry once per file it names. */
function debtByFile(db: Database, repoPath: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of listLedgerEntries(db, projectId(repoPath))) {
    for (const file of new Set(asStringArray(parseJsonOr<unknown>(entry.files, [])))) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Sessions merged into each file in the window: a fix round's re-gate records
 * another merge (decision 98), so a session counts once per file however many
 * of its merges named it.
 */
function mergesByFile(db: Database, since: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT session_id, type, payload FROM events
       WHERE type = 'merge' AND session_id IS NOT NULL AND created_at >= datetime(?)`,
    )
    .all(new Date(since).toISOString()) as (Pick<EventRow, 'type' | 'payload'> & {
    session_id: string;
  })[];
  const sessions = new Map<string, Set<string>>();
  for (const row of rows) {
    // Every row is a merge, by the query.
    const { files } = decodeEvent(row) as Extract<SessionEvent, { type: 'merge' }>;
    for (const file of files)
      sessions.set(file, (sessions.get(file) ?? new Set()).add(row.session_id));
  }
  return new Map([...sessions].map(([file, touched]) => [file, touched.size]));
}

/**
 * A file's line count, reading at most the `size` its `lstat` gave, opened
 * without following a link and without blocking: a link or a FIFO swapped in
 * since reads as unreadable or empty, never as a file outside the root or a
 * wait. Undefined when it cannot be read.
 */
function countLines(path: string, size: number): number | undefined {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.allocUnsafe(size);
      let length = 0;
      for (let read = -1; read !== 0 && length < size; length += read) {
        read = readSync(fd, buffer, length, size - length, null);
      }
      const text = buffer.subarray(0, length);
      let count = 0;
      for (let i = text.indexOf(NEWLINE); i !== -1; i = text.indexOf(NEWLINE, i + 1)) count++;
      // A last line with no newline after it is a line all the same.
      return text.at(-1) === NEWLINE ? count : count + Math.min(1, length);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** A directory's entries in path order, none for one that cannot be read. */
function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** A file's line count as last read, and the stat it was read under. */
interface CountedFile {
  stamp: string;
  lines: number | undefined;
}

/**
 * Line counts kept between polls, one map per mapped root, replaced by each
 * walk: opening a file costs a hundred times its `lstat`, so only a file
 * whose inode, size, or modification or change time moved is read again.
 */
const countedFiles = new Map<string, Map<string, CountedFile>>();

/**
 * The checkout's `src/` (decision 167), walked in path order without
 * following a link, so nothing outside the project root is read: a linked
 * `src/` maps nothing, a linked directory or file under it is skipped, and so
 * are `node_modules` and `.worktrees`. Each file comes with its open debt
 * entries and the sessions merged into it in the last 30 days. The walk stops
 * at `limits.files` files or `limits.bytes` of them, counted by their sizes,
 * so where it stops does not hang on what an earlier poll read.
 */
export function readModuleMap(
  db: Database,
  repoPath: string,
  now: number,
  limits = MAP_LIMITS,
): ModuleMap {
  const since = now - MERGE_WINDOW_DAYS * DAY_MS;
  const map: ModuleMap = {
    files: [],
    unread: 0,
    capped: false,
    mergesSince: new Date(since).toISOString().slice(0, 10),
  };
  const root = join(repoPath, MAP_ROOT);
  if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) return map;
  const debt = debtByFile(db, repoPath);
  const merges = mergesByFile(db, since);
  const previous = countedFiles.get(root);
  const counted = new Map<string, CountedFile>();
  let bytes = 0;
  // Counts one plain file, or says why it was not; false once a cap is reached.
  const visit = (path: string, file: string, stat: Stats): boolean => {
    bytes += Math.min(stat.size, MAX_FILE_BYTES + 1);
    if (map.files.length + map.unread >= limits.files || bytes > limits.bytes) return false;
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const known = previous?.get(path);
    // Never opened over the cap, so one huge file costs nothing.
    const lines =
      stat.size > MAX_FILE_BYTES
        ? undefined
        : known?.stamp === stamp
          ? known.lines
          : countLines(path, stat.size);
    counted.set(path, { stamp, lines });
    if (lines === undefined) map.unread++;
    else
      map.files.push({
        file: oneLine(file),
        lines,
        openDebt: debt.get(file) ?? 0,
        merges: merges.get(file) ?? 0,
      });
    return true;
  };
  const walk = (dir: string, relative: string): boolean =>
    listDir(dir).every((name) => {
      const path = join(dir, name);
      const file = posix.join(relative, name);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat?.isDirectory()) return SKIPPED_DIRS.has(name) || walk(path, file);
      return !stat?.isFile() || visit(path, file, stat);
    });
  map.capped = !walk(root, MAP_ROOT);
  countedFiles.set(root, counted);
  return map;
}
