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

export const DAY_MS = 86_400_000;

/** The sheets the dashboard serves, in the order its bar lists them (decision 98). */
export const SHEETS = ['overview', 'debt'] as const;
export type SheetName = (typeof SHEETS)[number];
