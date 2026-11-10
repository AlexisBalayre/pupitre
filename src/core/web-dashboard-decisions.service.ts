import type { Database } from 'better-sqlite3';

import { barChart, type TreemapGroup, treemap } from './chart.utils.js';
import { listDecisionRecords } from './decision-record.repository.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { asStringArray, parseJsonOr, toIsoUtc } from './report-data.utils.js';
import {
  MAP_ROOT,
  MERGE_WINDOW_DAYS,
  type ModuleMap,
  moduleOf,
  readModuleMap,
} from './web-dashboard-module-map.service.js';
import { escapeHtml, hint, oneLine, section, UNMINTED_LABEL } from './web-dashboard-sheet.utils.js';

/** One decision record as the sheet reads it, every string through `oneLine`. */
interface DecisionSheetRecord {
  id: number;
  /** The session id, or `UNMINTED_LABEL` for one outside the minted shape. */
  session: string;
  /** `, YYYY-MM-DD HH:MM UTC`; empty when the stored time does not parse. */
  when: string;
  /** Each a line of the stored text, as `pup log` prints it. */
  summary: string[];
  alternatives: string[];
  files: string[];
  /** The directory most of its files sit in: its place on the timeline. */
  module: string;
}

interface DecisionsView {
  records: DecisionSheetRecord[];
  map: ModuleMap;
}

const TOP_MODULES = 10;
const NO_FILE = '(no file named)';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Multi-line prose as `pup log` prints it: each line scrubbed on its own, blank ones dropped. */
function lines(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .map(oneLine)
    .filter((line) => line !== '');
}

/** The directory most of a record's files sit in, a tie to the first by path. */
function topModule(files: string[]): string {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(moduleOf(file), (counts.get(moduleOf(file)) ?? 0) + 1);
  let top = NO_FILE;
  let most = 0;
  for (const module of [...counts.keys()].sort()) {
    const n = counts.get(module) ?? 0;
    if (n > most) [top, most] = [module, n];
  }
  return top;
}

/**
 * The Decisions sheet's reading (decision 167): every decision record, newest first like
 * `pup log` (the store is the project's own), and the module map of the checkout's `src/`.
 */
export function readDecisionsSheet(db: Database, repoPath: string, now: number): DecisionsView {
  const records = listDecisionRecords(db).map((row) => {
    const at = new Date(toIsoUtc(row.created_at));
    const files = [
      ...new Set(asStringArray(parseJsonOr<unknown>(row.files, [])).map(oneLine)),
    ].filter((file) => file !== '');
    return {
      id: row.id,
      session: SESSION_ID_PATTERN.test(row.session_id) ? row.session_id : UNMINTED_LABEL,
      when: Number.isNaN(at.getTime())
        ? ''
        : `, ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      summary: lines(row.summary),
      alternatives: lines(row.alternatives),
      files,
      module: topModule(files),
    };
  });
  return { records, map: readModuleMap(db, repoPath, now) };
}

/** The Decisions sheet: the records' timeline by module, then the module map, where fragile areas stand out. */
export function renderDecisionsSheet(view: DecisionsView): string {
  return [timelineSection(view.records), mapSection(view.map)].join('\n');
}

function timelineSection(records: DecisionSheetRecord[]): string {
  if (records.length === 0) {
    return section('Decisions', hint('No decision recorded yet — each merge records one.'));
  }
  // Modules by their newest record, each with its records newest first.
  const groups = new Map<string, DecisionSheetRecord[]>();
  for (const record of records) {
    groups.set(record.module, [...(groups.get(record.module) ?? []), record]);
  }
  const ranked = [...groups.keys()]
    .sort()
    .map((module) => ({ label: module, value: groups.get(module)?.length ?? 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_MODULES);
  return section(
    'Decisions',
    `<p class="lead">${escapeHtml(
      `${plural(records.length, 'decision', 'decisions')} across ${plural(groups.size, 'module', 'modules')}, each under the directory most of its files sit in, newest first.`,
    )}</p>` +
      barChart(ranked, { title: `Decisions by module, top ${TOP_MODULES}`, layout: 'rows' }) +
      [...groups]
        .map(
          ([module, held]) =>
            `<h3 class="state-group">${escapeHtml(`${module} — ${held.length}`)}</h3>` +
            `<ul class="rows">${held.map(decisionRow).join('')}</ul>`,
        )
        .join(''),
  );
}

function decisionRow(record: DecisionSheetRecord): string {
  const alternatives = record.alternatives.map((line, i) =>
    i === 0 ? `alternatives: ${line}` : line,
  );
  const files = record.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(' ');
  return (
    `<li class="decision"><div class="meta"><span class="sid">#${record.id}</span> ` +
    `${escapeHtml(`${record.session}${record.when}`)}</div>` +
    record.summary.map((line) => `<div class="desc">${escapeHtml(line)}</div>`).join('') +
    alternatives.map((line) => `<div class="fact">${escapeHtml(line)}</div>`).join('') +
    (files === '' ? '' : `<div class="fact">${files}</div>`) +
    '</li>'
  );
}

function mapSection(map: ModuleMap): string {
  const title = `Module map of ${MAP_ROOT}/`;
  const unread = `${plural(map.unread, 'file', 'files')} not read (not a plain file, unreadable, or over 1 MiB).`;
  const notes =
    (map.unread > 0 ? hint(unread) : '') +
    (map.capped
      ? hint('The walk stopped at its cap; files past the last one shown are left out.')
      : '');
  const total = map.files.reduce((sum, file) => sum + file.lines, 0);
  if (total === 0) return section(title, hint(`No source under ${MAP_ROOT}/ to map.`) + notes);
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
      notes,
  );
}
