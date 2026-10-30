import { PR_URL } from './dashboard.service.js';
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

export function section(title: string, body: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

/** The one line a section shows in place of a chart or a list with nothing in it. */
export function hint(text: string): string {
  return `<p class="hint">${escapeHtml(text)}</p>`;
}

/** Escaped text, or a link when it is a pull request's url and nothing else (decisions 83, 91). */
export function textOrPrLink(text: string): string {
  if (!PR_URL.test(text)) return `<code>${escapeHtml(text)}</code>`;
  // `noreferrer`: the page's own url carries the run token.
  return `<a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
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
export const SHEETS = ['overview', 'health', 'debt'] as const;
export type SheetName = (typeof SHEETS)[number];
