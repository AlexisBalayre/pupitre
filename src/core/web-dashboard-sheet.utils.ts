import { sanitizeReason } from '../adapters/capability.utils.js';
import { PR_URL } from './constants/dashboard.constants.js';
import { displayText } from './report-data.utils.js';
import type { DashboardBaseline } from './types/dashboard.types.js';

/**
 * Every store-read string reaches the page through this (decision 91): the
 * snapshot already scrubbed what a terminal obeys (decision 29), and markup is
 * the browser's equivalent. Quotes too, since the PR url lands in an attribute.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A string on one line with no control character (decision 29) and no direction mark, which could disguise a path. */
export function oneLine(text: string): string {
  return displayText(sanitizeReason(text));
}

export function section(title: string, body: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

/** The one line a section shows in place of a chart or a list with nothing in it. */
export function hint(text: string): string {
  return `<p class="hint">${escapeHtml(text)}</p>`;
}

/** A section drawn from its items, or its one-line hint when there are none. */
export function listSection<T>(
  title: string,
  items: T[],
  empty: string,
  render: (items: T[]) => string,
): string {
  return section(title, items.length === 0 ? hint(empty) : render(items));
}

/** Escaped text, or a link when it is a pull request's url and nothing else (decisions 83, 91). */
export function textOrPrLink(text: string): string {
  if (!PR_URL.test(text)) return `<code>${escapeHtml(text)}</code>`;
  // `noreferrer`: the page's own url carries the run token.
  return `<a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

/**
 * How a long list shows a part of itself: `pages` steps through pages of its
 * size, `more` adds that many rows per press, `all` opens every row at once.
 */
type Paging = 'pages' | 'more' | 'all';

/** What a list's filters ask for and where its paging stands, as the page keeps it across board swaps. */
export interface ListView {
  text: string;
  kind: string;
  page: number;
  /** Rows a `more` or `all` list shows; its size when fewer. */
  shown: number;
}

/**
 * The rows a list shows: those holding every word of the text filter, in any
 * case, and of the kind filter's kind, then the page or the first `shown` of
 * them. Self-contained, with no import and no type at runtime: the page's
 * script carries its source (`listWindow.toString()`) and runs it over the
 * rows the board already holds, so the server's first render and every filter
 * the browser applies after agree, and no filter asks the server anything.
 */
export function listWindow(
  rows: { text: string; kind: string }[],
  view: ListView,
  size: number,
  paging: Paging,
): { shown: boolean[]; page: number; status: string; atStart: boolean; atEnd: boolean } {
  const words = view.text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  const matching: number[] = [];
  rows.forEach((row, i) => {
    const text = row.text.toLowerCase();
    if (
      (view.kind === '' || row.kind === view.kind) &&
      words.every((word) => text.includes(word))
    ) {
      matching.push(i);
    }
  });
  const pages = Math.max(1, Math.ceil(matching.length / size));
  const page = paging === 'pages' ? Math.min(Math.max(0, view.page), pages - 1) : 0;
  const from = page * size;
  const to = Math.min(
    matching.length,
    paging === 'pages' ? from + size : Math.max(size, view.shown),
  );
  const shown = rows.map(() => false);
  for (const i of matching.slice(from, to)) shown[i] = true;
  const status =
    matching.length === 0
      ? 'none match'
      : paging === 'pages'
        ? `${from + 1}–${to} of ${matching.length}`
        : `${to} of ${matching.length} shown`;
  return { shown, page, status, atStart: page === 0, atEnd: to >= matching.length };
}

/** A list the page filters and pages in the browser, over the rows it already holds. */
interface BrowsableList {
  /** Names the list's view, so its filters and page outlive a board swap. */
  name: string;
  size: number;
  paging: Paging;
  /** The text filter's label; none when the list has no text filter. */
  search?: string;
  /** The kind filter's label and its kinds, in the order it offers them. */
  kinds?: { label: string; values: string[] };
}

/** One row of a browsable list: its kind, and its markup given the attributes that make it a row. */
interface BrowsableRow {
  kind?: string;
  html: (attrs: string) => string;
}

/**
 * A browsable list: its filters, its rows as `body` lays them out, each marked
 * `data-row` and hidden when the first window leaves it out, and its pager.
 * The page's script re-applies the operator's filters and page after each
 * board swap; nothing here is a form, so nothing here can post (decision 91).
 */
export function browsable(
  list: BrowsableList,
  rows: BrowsableRow[],
  body: (rows: { html: string; shown: boolean }[]) => string,
): string {
  const first = listWindow(
    rows.map((row) => ({ text: '', kind: row.kind ?? '' })),
    { text: '', kind: '', page: 0, shown: 0 },
    list.size,
    list.paging,
  );
  const filters =
    (list.search === undefined
      ? ''
      : `<input type="search" data-filter="text" aria-label="${escapeHtml(list.search)}" placeholder="${escapeHtml(list.search)}">`) +
    (list.kinds === undefined
      ? ''
      : `<select data-filter="kind" aria-label="${escapeHtml(list.kinds.label)}"><option value="">every kind</option>` +
        list.kinds.values
          .map((kind) => `<option value="${escapeHtml(kind)}">${escapeHtml(kind)}</option>`)
          .join('') +
        '</select>');
  const step = (by: string, label: string, disabled: boolean): string =>
    `<button type="button" data-step="${by}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
  const status = `<span data-status aria-live="polite">${escapeHtml(first.status)}</span>`;
  const pager =
    list.paging === 'pages'
      ? step('-1', 'Previous', first.atStart) + status + step('1', 'Next', first.atEnd)
      : status +
        (list.paging === 'more'
          ? step(String(list.size), `Show ${list.size} more`, first.atEnd)
          : step('all', `Show all ${rows.length}`, first.atEnd));
  return (
    `<div class="browse" data-list="${escapeHtml(list.name)}" data-page-size="${list.size}" data-paging="${list.paging}">` +
    (filters === '' ? '' : `<div class="filters">${filters}</div>`) +
    body(
      rows.map((row, i) => ({
        html: row.html(
          ` data-row${row.kind === undefined ? '' : ` data-kind="${escapeHtml(row.kind)}"`}${first.shown[i] ? '' : ' hidden'}`,
        ),
        shown: first.shown[i] === true,
      })),
    ) +
    `<div class="pager">${pager}</div></div>`
  );
}

/** How many characters of a goal a card on a sheet shows. */
const CARD_TEXT_CHARS = 100;

/**
 * A card's text cut at the last word boundary within `CARD_TEXT_CHARS`, an
 * ellipsis marking the cut, so no card ends mid-word; a single longer word is
 * cut where the cap falls. Counted in code points, so no surrogate pair splits.
 */
export function clipWords(text: string): string {
  const chars = [...text];
  if (chars.length <= CARD_TEXT_CHARS) return text;
  const head = chars.slice(0, CARD_TEXT_CHARS).join('');
  // A cut falling just before a space keeps the word that ends there.
  const next = chars.slice(CARD_TEXT_CHARS, CARD_TEXT_CHARS + 1).join('');
  const boundary = /\s/.test(next) ? head.length : head.search(/\s\S*$/);
  const kept = boundary > 0 ? head.slice(0, boundary) : head;
  return `${kept.replace(/[\s,;:]+$/, '')}…`;
}

/** What a sheet shows for a session id outside the minted shape, which it never prints. */
export const UNMINTED_LABEL = '(unminted session id)';

const pct = (ratio: number): string => `${Math.round(ratio * 1000) / 10}%`;

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * The gate's baseline figures the sheets chart, in the order they stand: the
 * ones `debtFigures` reads off a capture, as `pup audit` stores them.
 */
export const GATE_METRICS: {
  key: keyof Omit<DashboardBaseline, 'capturedAt'>;
  label: string;
  format: (value: number) => string;
  /** How a movement prints: counts as counts, the ratio in percentage points. */
  change: (delta: number) => string;
}[] = [
  {
    key: 'coverageRatio',
    label: 'coverage',
    format: pct,
    change: (d) => `${signed(Math.round(d * 1000) / 10)} pt`,
  },
  { key: 'deadExports', label: 'unused exports', format: String, change: signed },
  { key: 'duplicatedLines', label: 'duplicated lines', format: String, change: signed },
];

export const DAY_MS = 86_400_000;

/** The sheets the dashboard serves, in the order its bar lists them (decision 98). */
export const SHEETS = ['overview', 'health', 'debt', 'tasks', 'decisions'] as const;
export type SheetName = (typeof SHEETS)[number];
