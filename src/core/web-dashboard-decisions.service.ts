import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type Stats,
} from 'node:fs';
import { join, posix } from 'node:path';
import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import { barChart, type TreemapGroup, treemap } from './chart.utils.js';
import { listDecisionRecords } from './decision-record.repository.js';
import { listLedgerEntries } from './ledger.repository.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { projectId } from './paths.utils.js';
import { asStringArray, displayText, parseJsonOr, toIsoUtc } from './report-data.utils.js';
import { decodeEvent, type EventRow } from './session.repository.js';
import type { SessionEvent } from './types/session-event.types.js';
import { DAY_MS, escapeHtml, hint, section, UNMINTED_LABEL } from './web-dashboard-sheet.utils.js';

/** One decision record as the sheet reads it, every string through `oneLine`. */
export interface DecisionSheetRecord {
  id: number;
  /** The session id, or `UNMINTED_LABEL` for one outside the minted shape. */
  session: string;
  /** `YYYY-MM-DD HH:MM`, UTC; empty when the stored time does not parse. */
  label: string;
  /** Each a line of the stored text, as `pup log` prints it. */
  summary: string[];
  alternatives: string[];
  files: string[];
  /** The directory most of its files sit in: its place on the timeline. */
  module: string;
}

/** One file of the checkout's `src/`, with what weighs on it. */
export interface ModuleMapFile {
  /** Repo-relative, through `oneLine`. */
  file: string;
  lines: number;
  openDebt: number;
  /** Sessions whose merge in the window touched it. */
  merges: number;
}

export interface ModuleMap {
  files: ModuleMapFile[];
  /** Files left out: not a plain file, or over the size cap. */
  unread: number;
  /** The walk stopped at a cap before reading every file. */
  capped: boolean;
  /** The day the merge window opens, `YYYY-MM-DD` UTC. */
  mergesSince: string;
}

export interface DecisionsView {
  records: DecisionSheetRecord[];
  map: ModuleMap;
}

/** The directory the module map covers, under the project root. */
const MAP_ROOT = 'src';
/** Never walked into: another checkout's files, or dependencies, not the project's. */
const SKIPPED_DIRS = new Set(['node_modules', '.worktrees']);
/** The walk's bounds, as the sheet is re-read on every poll (decision 98's hardening). */
const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1 << 20;
const MAX_TOTAL_BYTES = 64 << 20;
const MERGE_WINDOW_DAYS = 30;
const TOP_MODULES = 10;
const NO_FILE = '(no file named)';
const NEWLINE = 0x0a;

/** A store or file-name string on one line with no control character and no direction mark. */
function oneLine(text: string): string {
  return displayText(sanitizeReason(text));
}

/** Multi-line prose as `pup log` prints it: each line scrubbed on its own, blank ones dropped. */
function lines(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .map(oneLine)
    .filter((line) => line !== '');
}

/** A file's module, as `pup map` names it: its directory. */
function moduleOf(file: string): string {
  const dir = posix.dirname(file);
  return dir === '.' ? '(root)' : dir;
}

/** The directory most of a record's files sit in, a tie to the first by path. */
function topModule(files: string[]): string {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(moduleOf(file), (counts.get(moduleOf(file)) ?? 0) + 1);
  let top = NO_FILE;
  let most = 0;
  for (const [module, n] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (n > most) [top, most] = [module, n];
  }
  return top;
}

/**
 * The Decisions sheet's reading (decision 167): every decision record, newest
 * first like `pup log`, and the module map of the checkout's `src/`, each file
 * with its open debt entries and the sessions merged into it in the last 30
 * days. The store is the project's own, so its records are this project's.
 */
export function readDecisionsSheet(db: Database, repoPath: string, now: number): DecisionsView {
  const records = listDecisionRecords(db).map((row) => {
    const at = Date.parse(toIsoUtc(row.created_at));
    const files = [
      ...new Set(asStringArray(parseJsonOr<unknown>(row.files, [])).map(oneLine)),
    ].filter((file) => file !== '');
    return {
      id: row.id,
      session: SESSION_ID_PATTERN.test(row.session_id) ? row.session_id : UNMINTED_LABEL,
      label: Number.isNaN(at) ? '' : new Date(at).toISOString().slice(0, 16).replace('T', ' '),
      summary: lines(row.summary),
      alternatives: lines(row.alternatives),
      files,
      module: topModule(files),
    };
  });
  return { records, map: readModuleMap(db, repoPath, now) };
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
function mergesByFile(db: Database, now: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT session_id, type, payload FROM events
       WHERE type = 'merge' AND session_id IS NOT NULL AND created_at >= datetime(?)`,
    )
    .all(new Date(now - MERGE_WINDOW_DAYS * DAY_MS).toISOString()) as (Pick<
    EventRow,
    'type' | 'payload'
  > & { session_id: string })[];
  const sessions = new Map<string, Set<string>>();
  for (const row of rows) {
    // Every row is a merge, by the query.
    const { files } = decodeEvent(row) as Extract<SessionEvent, { type: 'merge' }>;
    for (const file of files) {
      const touched = sessions.get(file) ?? new Set<string>();
      touched.add(row.session_id);
      sessions.set(file, touched);
    }
  }
  return new Map([...sessions].map(([file, touched]) => [file, touched.size]));
}

/**
 * A file's line count, read without following a link or blocking on a FIFO
 * or a device, and only up to the size it had when opened; undefined for
 * anything but a plain file under the cap.
 */
function countLines(path: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    const buffer = Buffer.allocUnsafe(stat.size);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length; length += read) {
      read = readSync(fd, buffer, length, buffer.length - length, null);
    }
    let count = 0;
    for (
      let i = buffer.indexOf(NEWLINE);
      i !== -1 && i < length;
      i = buffer.indexOf(NEWLINE, i + 1)
    ) {
      count++;
    }
    // A last line with no newline after it is a line all the same.
    return length > 0 && buffer[length - 1] !== NEWLINE ? count + 1 : count;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
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
 * The checkout's `src/`, walked in path order without following a link, so
 * nothing outside the project root is read: a linked `src/` maps nothing, a
 * linked directory or file under it is skipped, and so are `node_modules` and
 * `.worktrees`. The walk stops at `MAX_FILES` files or `MAX_TOTAL_BYTES` of
 * them, counted by their sizes, so where it stops does not hang on what an
 * earlier poll read.
 */
function readModuleMap(db: Database, repoPath: string, now: number): ModuleMap {
  const map: ModuleMap = {
    files: [],
    unread: 0,
    capped: false,
    mergesSince: new Date(now - MERGE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10),
  };
  const root = join(repoPath, MAP_ROOT);
  try {
    if (!lstatSync(root).isDirectory()) return map;
  } catch {
    return map;
  }
  const debt = debtByFile(db, repoPath);
  const merges = mergesByFile(db, now);
  const previous = countedFiles.get(root);
  const counted = new Map<string, CountedFile>();
  let bytes = 0;
  const walk = (dir: string, relative: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (map.capped) return;
      const path = join(dir, entry.name);
      const file = posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path, file);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat: Stats;
      try {
        stat = lstatSync(path);
      } catch {
        map.unread++;
        continue;
      }
      if (!stat.isFile()) continue;
      if (map.files.length + map.unread >= MAX_FILES) {
        map.capped = true;
        return;
      }
      // Never opened, and not held against the budget: one huge file cannot end the walk.
      if (stat.size > MAX_FILE_BYTES) {
        map.unread++;
        continue;
      }
      if (bytes + stat.size > MAX_TOTAL_BYTES) {
        map.capped = true;
        return;
      }
      bytes += stat.size;
      const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const known = previous?.get(path);
      const lines = known?.stamp === stamp ? known.lines : countLines(path);
      counted.set(path, { stamp, lines });
      if (lines === undefined) {
        map.unread++;
        continue;
      }
      map.files.push({
        file: oneLine(file),
        lines,
        openDebt: debt.get(file) ?? 0,
        merges: merges.get(file) ?? 0,
      });
    }
  };
  walk(root, MAP_ROOT);
  countedFiles.set(root, counted);
  return map;
}

/**
 * The Decisions sheet: the decision records as a timeline grouped by module,
 * each with its summary and the alternatives it weighed, and the module map of
 * `src/`, a treemap sized by line count and shaded by open debt or by recent
 * merges, so the fragile areas stand out.
 */
export function renderDecisionsSheet(view: DecisionsView): string {
  return [timelineSection(view.records), mapSection(view.map)].join('\n');
}

/** Modules by their newest record, each with its records newest first. */
function byModule(records: DecisionSheetRecord[]): [string, DecisionSheetRecord[]][] {
  const groups = new Map<string, DecisionSheetRecord[]>();
  for (const record of records) {
    const held = groups.get(record.module);
    if (held) held.push(record);
    else groups.set(record.module, [record]);
  }
  return [...groups];
}

function timelineSection(records: DecisionSheetRecord[]): string {
  if (records.length === 0) {
    return section('Decisions', hint('No decision recorded yet — each merge records one.'));
  }
  const groups = byModule(records);
  const ranked = [...groups]
    .sort(([a, x], [b, y]) => y.length - x.length || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, TOP_MODULES);
  return section(
    'Decisions',
    `<p class="lead">${escapeHtml(
      `${records.length} ${records.length === 1 ? 'decision' : 'decisions'} across ${groups.length} ${groups.length === 1 ? 'module' : 'modules'}, each under the directory most of its files sit in, newest first.`,
    )}</p>` +
      barChart(
        ranked.map(([module, held]) => ({ label: module, value: held.length })),
        { title: `Decisions by module, top ${TOP_MODULES}`, layout: 'rows' },
      ) +
      groups.map(([module, held]) => moduleTimeline(module, held)).join(''),
  );
}

function moduleTimeline(module: string, records: DecisionSheetRecord[]): string {
  const rows = records.map(
    (record) =>
      `<li class="decision"><div class="meta"><span class="sid">#${record.id}</span> ` +
      `${escapeHtml(`${record.session}${record.label === '' ? '' : `, ${record.label} UTC`}`)}</div>` +
      record.summary.map((line) => `<div class="desc">${escapeHtml(line)}</div>`).join('') +
      record.alternatives
        .map(
          (line, i) =>
            `<div class="fact">${escapeHtml(`${i === 0 ? 'alternatives: ' : ''}${line}`)}</div>`,
        )
        .join('') +
      (record.files.length === 0
        ? ''
        : `<div class="fact">${record.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(' ')}</div>`) +
      '</li>',
  );
  return (
    `<h3 class="state-group">${escapeHtml(`${module} — ${records.length}`)}</h3>` +
    `<ul class="rows">${rows.join('')}</ul>`
  );
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function mapSection(map: ModuleMap): string {
  const title = `Module map of ${MAP_ROOT}/`;
  const notes = [
    map.unread > 0
      ? `${plural(map.unread, 'file', 'files')} not read (not a plain file, or over 1 MiB).`
      : '',
    map.capped
      ? `The walk stopped at its cap; files after the last one shown by path are left out.`
      : '',
  ].filter((note) => note !== '');
  const total = map.files.reduce((sum, file) => sum + file.lines, 0);
  if (total === 0) {
    return section(title, hint(`No source under ${MAP_ROOT}/ to map.`) + notes.map(hint).join(''));
  }
  const groups = new Map<string, TreemapGroup>();
  for (const file of map.files) {
    const module = moduleOf(file.file);
    const group = groups.get(module) ?? { label: module, leaves: [] };
    group.leaves.push({
      label: file.file,
      value: file.lines,
      counts: [file.openDebt, file.merges],
    });
    groups.set(module, group);
  }
  return section(
    title,
    `<p class="lead">${escapeHtml(
      `${plural(map.files.length, 'file', 'files')}, ${plural(total, 'line', 'lines')} in ${plural(groups.size, 'module', 'modules')}; each file sized by its lines and shaded by its open debt entries or by the sessions merged into it since ${map.mergesSince}.`,
    )}</p>` +
      treemap([...groups.values()], {
        title,
        format: (n) => plural(n, 'line', 'lines'),
        tones: [
          {
            label: 'with open debt',
            count: (n) => plural(n, 'open debt entry', 'open debt entries'),
          },
          {
            label: `merged in the last ${MERGE_WINDOW_DAYS} days`,
            count: (n) => `${plural(n, 'merge', 'merges')} in ${MERGE_WINDOW_DAYS} days`,
          },
        ],
      }) +
      notes.map(hint).join(''),
  );
}
