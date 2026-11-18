import type { Database } from 'better-sqlite3';

import { listDecisionRecords } from './decision-record.repository.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { asStringArray, parseJsonOr, toIsoUtc } from './report-data.utils.js';
import {
  browsable,
  escapeHtml,
  hint,
  oneLine,
  section,
  UNMINTED_LABEL,
} from './web-dashboard-sheet.utils.js';

/** One decision record as the sheet reads it, every string through `oneLine`. */
interface DecisionSheetRecord {
  id: number;
  /** The session id, or `UNMINTED_LABEL` for one outside the minted shape. */
  session: string;
  /** `YYYY-MM-DD` UTC, the day it is grouped under; `NO_DAY` when the stored time does not parse. */
  day: string;
  /** `, HH:MM UTC`; empty when the stored time does not parse. */
  time: string;
  /** Each a line of the stored text, as `pup log` prints it. */
  summary: string[];
  alternatives: string[];
  files: string[];
}

/** Records the sheet opens with, and adds per press of its control. */
const PAGE_RECORDS = 20;
const NO_DAY = '(no date recorded)';

/** Multi-line prose as `pup log` prints it: each line scrubbed on its own, blank ones dropped. */
function lines(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .map(oneLine)
    .filter((line) => line !== '');
}

/** The Decisions sheet's reading: every decision record, newest first like `pup log` (the store is the project's own). */
export function readDecisionsSheet(db: Database): DecisionSheetRecord[] {
  return listDecisionRecords(db).map((row) => {
    const at = new Date(toIsoUtc(row.created_at));
    const dated = !Number.isNaN(at.getTime());
    return {
      id: row.id,
      session: SESSION_ID_PATTERN.test(row.session_id) ? row.session_id : UNMINTED_LABEL,
      day: dated ? at.toISOString().slice(0, 10) : NO_DAY,
      time: dated ? `, ${at.toISOString().slice(11, 16)} UTC` : '',
      summary: lines(row.summary),
      alternatives: lines(row.alternatives),
      files: [...new Set(asStringArray(parseJsonOr<unknown>(row.files, [])).map(oneLine))].filter(
        (file) => file !== '',
      ),
    };
  });
}

/**
 * The Decisions sheet: the newest records under the day each was made, more
 * on each press, and a search over all of them, run in the browser over the
 * rows the board already holds.
 */
export function renderDecisionsSheet(records: DecisionSheetRecord[]): string {
  if (records.length === 0) {
    return section('Decisions', hint('No decision recorded yet — each merge records one.'));
  }
  return section(
    'Decisions',
    `<p class="lead">${escapeHtml(
      `${records.length} ${records.length === 1 ? 'decision' : 'decisions'}, newest first; the search reads every one.`,
    )}</p>` +
      browsable(
        {
          name: 'decisions',
          size: PAGE_RECORDS,
          paging: 'more',
          search: 'Search summaries, alternatives, files and sessions',
        },
        records.map((record) => ({ html: (attrs) => decisionRow(record, attrs) })),
        (rows) => byDay(records, rows),
      ),
  );
}

/** The rows under a heading per day, in the records' order; a day none of whose rows shows is hidden. */
function byDay(records: DecisionSheetRecord[], rows: { html: string; shown: boolean }[]): string {
  const days = new Map<string, { html: string; shown: boolean }[]>();
  records.forEach((record, i) => {
    const row = rows[i];
    if (row) days.set(record.day, [...(days.get(record.day) ?? []), row]);
  });
  return [...days]
    .map(
      ([day, held]) =>
        `<div data-group${held.some((row) => row.shown) ? '' : ' hidden'}>` +
        `<h3 class="state-group">${escapeHtml(day)}</h3>` +
        `<ul class="rows">${held.map((row) => row.html).join('')}</ul></div>`,
    )
    .join('');
}

function decisionRow(record: DecisionSheetRecord, attrs: string): string {
  const alternatives = record.alternatives.map((line, i) =>
    i === 0 ? `alternatives: ${line}` : line,
  );
  const files = record.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(' ');
  return (
    `<li class="decision"${attrs}><div class="meta"><span class="sid">#${record.id}</span> ` +
    `${escapeHtml(`${record.session}${record.time}`)}</div>` +
    record.summary.map((line) => `<div class="desc">${escapeHtml(line)}</div>`).join('') +
    alternatives.map((line) => `<div class="fact">${escapeHtml(line)}</div>`).join('') +
    (files === '' ? '' : `<div class="fact">${files}</div>`) +
    '</li>'
  );
}
