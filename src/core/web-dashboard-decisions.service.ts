import type { Database } from 'better-sqlite3';
import { SESSION_ID_PATTERN } from './constants/paths.constants.js';
import { listDecisionRecords } from './decision-record.repository.js';
import { asStringArray, parseJsonOr, toIsoUtc } from './report-data.utils.js';
import type { DecisionSheetRecord } from './types/web-dashboard-decisions.types.js';
import { escapeHtml, hint, oneLine, section, UNMINTED_LABEL } from './web-dashboard-sheet.utils.js';

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
      time: dated ? `, ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '',
      summary: lines(row.summary),
      alternatives: lines(row.alternatives),
      files: [...new Set(asStringArray(parseJsonOr<unknown>(row.files, [])).map(oneLine))].filter(
        (file) => file !== '',
      ),
    };
  });
}

/** The Decisions sheet: every record under the day it was made, filtered and paged in the page. */
export function renderDecisionsSheet(records: DecisionSheetRecord[]): string {
  if (records.length === 0) {
    return section('Decisions', hint('No decision recorded yet — each merge records one.'));
  }
  const lead = records.length === 1 ? '1 decision.' : `${records.length} decisions, newest first.`;
  return section('Decisions', `<p class="lead">${escapeHtml(lead)}</p>${byDay(records)}`);
}

/**
 * The records under a heading per day, in their order, marked as one list:
 * the page's filter searches them all and its pager shows a page at a time,
 * the newest first, hiding a day none of whose records show.
 */
function byDay(records: DecisionSheetRecord[]): string {
  const days = new Map<string, DecisionSheetRecord[]>();
  for (const record of records) days.set(record.day, [...(days.get(record.day) ?? []), record]);
  return `<div data-list="decisions">${[...days]
    .map(
      ([day, held]) =>
        `<div data-group><h3 class="state-group">${escapeHtml(day)}</h3>` +
        `<ul class="rows">${held.map(decisionRow).join('')}</ul></div>`,
    )
    .join('')}</div>`;
}

function decisionRow(record: DecisionSheetRecord): string {
  const alternatives = record.alternatives.map((line, i) =>
    i === 0 ? `alternatives: ${line}` : line,
  );
  const files = record.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(' ');
  return (
    `<li class="decision"><div class="meta"><span class="sid">#${record.id}</span> ` +
    `${escapeHtml(`${record.session}${record.time}`)}</div>` +
    record.summary.map((line) => `<div class="desc">${escapeHtml(line)}</div>`).join('') +
    alternatives.map((line) => `<div class="fact">${escapeHtml(line)}</div>`).join('') +
    (files === '' ? '' : `<div class="fact">${files}</div>`) +
    '</li>'
  );
}
