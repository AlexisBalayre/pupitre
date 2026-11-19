import type { Database } from 'better-sqlite3';

import { barChart, type ChartDatum } from './chart.utils.js';
import { listLedgerEntries, listOverdueLedgerEntries } from './ledger.repository.js';
import { projectId } from './paths.utils.js';
import { asStringArray, parseJsonOr, toIsoUtc } from './report-data.utils.js';
import { actionButton } from './web-dashboard-actions.service.js';
import { DAY_MS, escapeHtml, hint, oneLine, section } from './web-dashboard-sheet.utils.js';

/** One open ledger entry as the Debt sheet reads it, every string already through `oneLine`. */
export interface DebtSheetEntry {
  id: string;
  description: string;
  reason: string;
  acceptedBy: string;
  reviewBy: string;
  /** The files it names, each once; empty when it names none. */
  files: string[];
  /** Whole days since it was filed. */
  ageDays: number;
  overdue: boolean;
}

/** A file on the pay-down ranking: its open entries, oldest first, and what they weigh together. */
interface RankedFile {
  file: string;
  weight: number;
  entries: DebtSheetEntry[];
}

const TOP_FILES = 10;
/** Files a row names in full; the rest wait behind its closed details. */
const FILES_SHOWN = 3;
/** An entry this many days old weighs twice a fresh one on the pay-down ranking. */
const WEIGHT_DOUBLING_DAYS = 30;
/** Where the pay-down ranking puts an entry that names no file, so it is not left off. */
const NO_FILE = '(no file named)';

/**
 * The kinds the gate files, told by how its descriptions begin (merge-gate's
 * flags); a free-text entry and the rarer flags are `other`.
 */
const KINDS: { label: string; prefix?: string }[] = [
  { label: 'oversize diff', prefix: 'Oversize diff' },
  { label: 'complexity rise', prefix: 'Complexity rise' },
  { label: 'duplicated lines', prefix: 'Duplicated lines' },
  { label: 'other' },
];

const AGES: { label: string; underDays: number }[] = [
  { label: 'under 1 week', underDays: 7 },
  { label: '1–4 weeks', underDays: 28 },
  { label: '1–3 months', underDays: 91 },
  { label: 'older', underDays: Number.POSITIVE_INFINITY },
];

/**
 * The open ledger as the Debt sheet reads it (decision 98), oldest first like
 * `pup debt`. Overdue is `listOverdueLedgerEntries`'s rule, the one `pup
 * status` marks by; a `files` column that does not parse names no file.
 */
export function readDebtSheet(db: Database, repoPath: string, now: number): DebtSheetEntry[] {
  const pid = projectId(repoPath);
  const overdue = new Set(listOverdueLedgerEntries(db, pid, new Date(now)).map((e) => e.id));
  return listLedgerEntries(db, pid).map((entry) => {
    const filed = Date.parse(toIsoUtc(entry.created_at));
    return {
      id: oneLine(String(entry.id)),
      description: oneLine(entry.description),
      reason: oneLine(entry.reason),
      acceptedBy: oneLine(entry.accepted_by),
      reviewBy: oneLine(entry.review_by),
      files: [...new Set(asStringArray(parseJsonOr<unknown>(entry.files, [])).map(oneLine))],
      ageDays: Number.isNaN(filed) ? 0 : Math.max(0, Math.floor((now - filed) / DAY_MS)),
      overdue: overdue.has(entry.id),
    };
  });
}

/**
 * What to pay down next: each file weighs the sum of its open entries, an
 * entry counting 1 when fresh and one more every `WEIGHT_DOUBLING_DAYS` it has
 * been held, so a file carrying old debt rises above one carrying the same
 * count of new. Heaviest first; a tie goes to the file with more entries, then
 * to the path, so the order is stable.
 */
export function payDownRanking(entries: DebtSheetEntry[]): RankedFile[] {
  const byFile = new Map<string, DebtSheetEntry[]>();
  for (const entry of entries) {
    for (const file of entry.files.length > 0 ? entry.files : [NO_FILE]) {
      const held = byFile.get(file);
      if (held) held.push(entry);
      else byFile.set(file, [entry]);
    }
  }
  return [...byFile]
    .map(([file, held]) => ({
      file,
      weight: held.reduce((sum, entry) => sum + 1 + entry.ageDays / WEIGHT_DOUBLING_DAYS, 0),
      entries: [...held].sort((a, b) => b.ageDays - a.ageDays),
    }))
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        b.entries.length - a.entries.length ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
    );
}

/**
 * The Debt sheet: how much is open and of what kind and age, the files
 * carrying the most, then one table of every open entry with why it was
 * accepted, until when and by whom, filtered by text and kind and paged in
 * the browser. The table opens in pay-down order: the entries of the file
 * `payDownRanking` puts first, oldest first, then the next file's.
 */
export function renderDebtSheet(entries: DebtSheetEntry[]): string {
  if (entries.length === 0) {
    return section('Open debt', hint('No open debt — nothing to pay down.'));
  }
  const overdue = entries.filter((entry) => entry.overdue).length;
  // Reduced, not spread: a spread of a large ledger overflows the call stack.
  const oldest = entries.reduce((max, entry) => Math.max(max, entry.ageDays), 0);
  const ranked = payDownRanking(entries);
  return [
    section(
      'Open debt',
      `<p class="lead">${escapeHtml(
        `${entries.length} open ${entries.length === 1 ? 'entry' : 'entries'}, ${overdue} overdue, the oldest held ${days(oldest)}.`,
      )}</p>` +
        barChart(
          countBy(
            entries,
            kindOf,
            KINDS.map((kind) => kind.label),
          ),
          {
            title: 'By kind',
            layout: 'rows',
          },
        ) +
        barChart(
          countBy(
            entries,
            ageOf,
            AGES.map((age) => age.label),
          ),
          { title: 'By age' },
        ),
    ),
    section('Files carrying the most', topFiles(ranked)),
    section('Open entries', ledgerTable(payDownOrder(ranked))),
  ].join('\n');
}

/** Each entry once, where the heaviest file it names puts it on the pay-down ranking. */
function payDownOrder(ranked: RankedFile[]): DebtSheetEntry[] {
  return [...new Set(ranked.flatMap((file) => file.entries))];
}

/** `other` has no prefix, so every entry finds a kind, and an age band likewise. */
function kindOf(entry: DebtSheetEntry): string {
  return KINDS.find((kind) => !kind.prefix || entry.description.startsWith(kind.prefix))
    ?.label as string;
}

function ageOf(entry: DebtSheetEntry): string {
  return AGES.find((age) => entry.ageDays < age.underDays)?.label as string;
}

/** One bar per label, in the labels' order, zero where nothing falls. */
function countBy(
  entries: DebtSheetEntry[],
  keyOf: (entry: DebtSheetEntry) => string,
  labels: string[],
): ChartDatum[] {
  return labels.map((label) => ({
    label,
    value: entries.filter((entry) => keyOf(entry) === label).length,
  }));
}

/** The files with the most open entries, by count alone; the table's pay-down order is where age weighs. */
function topFiles(ranked: RankedFile[]): string {
  const named = ranked
    .filter((file) => file.file !== NO_FILE)
    .sort((a, b) => b.entries.length - a.entries.length || (a.file < b.file ? -1 : 1))
    .slice(0, TOP_FILES);
  if (named.length === 0) return hint('No open entry names a file.');
  return barChart(
    named.map((file) => ({ label: file.file, value: file.entries.length })),
    { title: `Top ${TOP_FILES} files by open entries`, layout: 'rows' },
  );
}

function days(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

function ledgerTable(entries: DebtSheetEntry[]): string {
  return (
    '<table class="moves"><thead><tr><th>Entry</th><th>Files</th><th>Accepted</th><th></th></tr></thead>' +
    `<tbody>${entries.map(entryRow).join('')}</tbody></table>`
  );
}

function entryRow(entry: DebtSheetEntry): string {
  return (
    `<tr><td><span class="sid">#${escapeHtml(entry.id)}</span> ${escapeHtml(entry.description)}` +
    `${entry.overdue ? ' <span class="state state-blocked">overdue</span>' : ''}` +
    `<div class="fact">${escapeHtml(`reason: ${entry.reason}`)}</div></td>` +
    `<td>${filesCell(entry.files)}</td>` +
    `<td class="fact">${escapeHtml(`review by ${entry.reviewBy}, accepted by ${entry.acceptedBy}, held ${days(entry.ageDays)}`)}</td>` +
    `<td>${closeButton(entry)}</td></tr>`
  );
}

function filesCell(files: string[]): string {
  if (files.length === 0) return `<span class="hint">${escapeHtml(NO_FILE)}</span>`;
  const code = (some: string[]): string =>
    some.map((file) => `<code>${escapeHtml(file)}</code>`).join(' ');
  const rest = files.slice(FILES_SHOWN);
  return (
    code(files.slice(0, FILES_SHOWN)) +
    (rest.length === 0
      ? ''
      : `<details><summary>${rest.length} more</summary>${code(rest)}</details>`)
  );
}

/** `pup debt close <id>`, which the page asks to confirm before it runs (decision 91). */
function closeButton(entry: DebtSheetEntry): string {
  return actionButton('debt-close', { id: entry.id }, `Close #${entry.id}`);
}
