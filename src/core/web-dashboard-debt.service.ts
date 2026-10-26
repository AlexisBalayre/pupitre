import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import { barChart, type ChartDatum } from './chart.utils.js';
import { listLedgerEntries, listOverdueLedgerEntries } from './ledger.repository.js';
import { projectId } from './paths.utils.js';
import { asStringArray, parseJsonOr, toIsoUtc } from './report-data.utils.js';
import { DAY_MS, escapeHtml, hint, section } from './web-dashboard-sheet.utils.js';

/** One open ledger entry as the Debt sheet reads it, every string already through `sanitizeReason`. */
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

/** A file on the pay-down list: its open entries, oldest first, and what they weigh together. */
interface RankedFile {
  file: string;
  weight: number;
  entries: DebtSheetEntry[];
}

const TOP_FILES = 10;
const PAY_DOWN_FILES = 5;
/** An entry this many days old weighs twice a fresh one on the pay-down list. */
const WEIGHT_DOUBLING_DAYS = 30;
/** Where the pay-down list puts an entry that names no file, so it is not left off. */
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
      id: sanitizeReason(String(entry.id)),
      description: sanitizeReason(entry.description),
      reason: sanitizeReason(entry.reason),
      acceptedBy: sanitizeReason(entry.accepted_by),
      reviewBy: sanitizeReason(entry.review_by),
      files: [...new Set(asStringArray(parseJsonOr<unknown>(entry.files, [])).map(sanitizeReason))],
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
      byFile.set(file, [...(byFile.get(file) ?? []), entry]);
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
 * The Debt sheet: how much is open and of what kind and age, where it sits,
 * and the files to pay down first, each entry with why it was accepted, until
 * when and by whom. The whole ledger follows, folded, for the entries the
 * ranking leaves below its cut.
 */
export function renderDebtSheet(entries: DebtSheetEntry[]): string {
  if (entries.length === 0) {
    return section('Open debt', hint('No open debt — nothing to pay down.'));
  }
  const overdue = entries.filter((entry) => entry.overdue).length;
  const oldest = Math.max(...entries.map((entry) => entry.ageDays));
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
    section('Pay down next', payDownList(ranked.slice(0, PAY_DOWN_FILES))),
    section('All open entries', ledgerList(entries)),
  ].join('\n');
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

/** The files with the most open entries, by count alone; the pay-down list is where age weighs. */
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

function payDownList(ranked: RankedFile[]): string {
  const rows = ranked.map(
    (file) =>
      `<li class="entry"><div class="meta">${file.file === NO_FILE ? `<span class="hint">${escapeHtml(NO_FILE)}</span>` : `<code>${escapeHtml(file.file)}</code>`}` +
      `<span class="hint">${escapeHtml(`weight ${Math.round(file.weight * 10) / 10}, ${file.entries.length} open`)}</span></div>` +
      file.entries.map(entryLines).join('') +
      '</li>',
  );
  return `<ol class="paydown">${rows.join('')}</ol>`;
}

function entryLines(entry: DebtSheetEntry): string {
  return (
    `<div class="desc"><span class="sid">#${escapeHtml(entry.id)}</span> ${escapeHtml(entry.description)}` +
    `${entry.overdue ? ' <span class="state state-blocked">overdue</span>' : ''}</div>` +
    `<div class="fact">${escapeHtml(`reason: ${entry.reason}`)}</div>` +
    `<div class="fact">${escapeHtml(`review by ${entry.reviewBy}, accepted by ${entry.acceptedBy}, held ${days(entry.ageDays)}`)}</div>`
  );
}

function ledgerList(entries: DebtSheetEntry[]): string {
  const rows = entries.map(
    (entry) =>
      `<li class="entry${entry.overdue ? ' overdue' : ''}"><div class="meta"><span class="sid">#${escapeHtml(entry.id)}</span>` +
      `${entry.overdue ? '<span class="state state-blocked">overdue</span>' : ''}</div>` +
      `<div class="desc">${escapeHtml(entry.description)}</div>` +
      `<div class="fact">accepted by ${escapeHtml(entry.acceptedBy)}, review by ${escapeHtml(entry.reviewBy)}</div></li>`,
  );
  return `<details><summary>${escapeHtml(`${entries.length} open, oldest first`)}</summary><ul class="rows">${rows.join('')}</ul></details>`;
}
