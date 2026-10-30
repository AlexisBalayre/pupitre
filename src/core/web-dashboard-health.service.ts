import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import { captureDebt, listBaselineHistory } from './baseline-history.repository.js';
import { type TimeDatum, type TimeMarker, timeLineChart } from './chart.utils.js';
import { debtFigures, PR_URL } from './dashboard.service.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { projectId } from './paths.utils.js';
import { displayText, toIsoUtc } from './report-data.utils.js';
import { decodeEvent, type EventRow } from './session.repository.js';
import type { DashboardBaseline } from './types/dashboard.types.js';
import {
  escapeHtml,
  GATE_METRICS,
  hint,
  section,
  textOrPrLink,
  UNMINTED_LABEL,
} from './web-dashboard-sheet.utils.js';

type Figures = Omit<DashboardBaseline, 'capturedAt'>;
type MetricKey = keyof Figures;

/** One `baseline_history` capture as the Health sheet reads it. */
interface HealthCapture {
  at: number;
  /** Printed from `at`, so no store text reaches the page through it. */
  label: string;
  figures: Figures;
  /** The rule `duplicatedLines` was counted under (decision 39). */
  duplicationRule?: string;
}

/** A session's first merge, the one that landed its work. */
interface HealthMerge {
  at: number;
  label: string;
  /** The session id, or `UNMINTED_LABEL` for one outside the minted shape. */
  session: string;
  /** Through `sanitizeReason` and `displayText`; a link only when it has a PR url's shape. */
  prUrl?: string;
}

interface HealthView {
  captures: HealthCapture[];
  merges: HealthMerge[];
}

/** One metric's change at a capture, against the newest earlier capture that measured it comparably. */
interface Move {
  key: MetricKey;
  before: number;
  after: number;
  /** When the capture it is compared with was taken. */
  since: number;
}

interface Movement {
  capture: HealthCapture;
  moves: Move[];
  /** The largest relative change among its moves. */
  size: number;
  /** The sessions whose first merge falls after the earliest `since` and at or before the capture. */
  merged: HealthMerge[];
}

const TOP_MOVES = 10;
/** Sessions a row of the moves table names before it says how many more merged. */
const NAMED_SESSIONS = 5;

/** A store time as the page prints it, minutes and no seconds, in UTC. */
function timeLabel(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Every capture oldest first, and every session's first merge, the one that
 * landed it: a fix round's re-gate records another (decision 98). A capture
 * whose time does not parse has no place on the axis and is left out.
 */
export function readHealthSheet(db: Database, repoPath: string): HealthView {
  const captures = listBaselineHistory(db, projectId(repoPath)).flatMap((row) => {
    const at = Date.parse(toIsoUtc(row.captured_at));
    if (Number.isNaN(at)) return [];
    const debt = captureDebt(row);
    return [
      {
        at,
        label: timeLabel(at),
        figures: debtFigures(debt),
        ...(typeof debt?.duplicationRule === 'string'
          ? { duplicationRule: debt.duplicationRule }
          : {}),
      },
    ];
  });
  const rows = db
    .prepare(
      `SELECT session_id, type, payload, created_at FROM events WHERE id IN
         (SELECT MIN(id) FROM events WHERE type = 'merge' AND session_id IS NOT NULL GROUP BY session_id)
       ORDER BY created_at, id`,
    )
    .all() as (Pick<EventRow, 'type' | 'payload' | 'created_at'> & { session_id: string })[];
  const merges = rows.flatMap((row) => {
    const at = Date.parse(toIsoUtc(row.created_at));
    if (Number.isNaN(at)) return [];
    const event = decodeEvent(row);
    const prUrl = event.type === 'merge' ? event.prUrl : undefined;
    return [
      {
        at,
        label: timeLabel(at),
        session: SESSION_ID_PATTERN.test(row.session_id) ? row.session_id : UNMINTED_LABEL,
        ...(prUrl !== undefined ? { prUrl: displayText(sanitizeReason(prUrl)) } : {}),
      },
    ];
  });
  return { captures, merges };
}

/**
 * A duplication count is comparable only with one counted under the same rule
 * (decision 39); every other figure always is.
 */
function comparable(key: MetricKey, a: HealthCapture, b: HealthCapture): boolean {
  return key !== 'duplicatedLines' || a.duplicationRule === b.duplicationRule;
}

/**
 * Each capture's moves: every figure that differs from the newest earlier
 * capture that measured it comparably, so a gap in between hides no change.
 * A move's size is its change over the larger of its two values, so a count
 * and a ratio rank on one scale, and a figure leaving zero counts in full.
 */
function movements(captures: HealthCapture[], merges: HealthMerge[]): Movement[] {
  const last = new Map<MetricKey, HealthCapture>();
  const found: Movement[] = [];
  for (const capture of captures) {
    const moves: Move[] = [];
    for (const { key } of GATE_METRICS) {
      const after = capture.figures[key];
      if (after === undefined) continue;
      const previous = last.get(key);
      const before = previous?.figures[key];
      last.set(key, capture);
      if (previous === undefined || before === undefined || before === after) continue;
      if (!comparable(key, previous, capture)) continue;
      moves.push({ key, before, after, since: previous.at });
    }
    if (moves.length === 0) continue;
    const since = moves.reduce((earliest, move) => Math.min(earliest, move.since), capture.at);
    found.push({
      capture,
      moves,
      size: moves.reduce(
        (largest, move) =>
          Math.max(
            largest,
            Math.abs(move.after - move.before) /
              Math.max(Math.abs(move.before), Math.abs(move.after)),
          ),
        0,
      ),
      merged: merges.filter((merge) => merge.at > since && merge.at <= capture.at),
    });
  }
  // Largest first; a tie goes to the newer capture, so the order is stable.
  return found.sort((a, b) => b.size - a.size || b.capture.at - a.capture.at);
}

/**
 * The Health sheet (decision 98): one line per gate metric across every
 * capture, each session's merge marked on the time axis, the captures that
 * moved a metric most with the sessions merged since the capture before, and
 * every merge with its pull request. Nothing in it is relative to now, so an
 * unchanged store renders the same board.
 */
export function renderHealthSheet(view: HealthView): string {
  return [
    metricsSection(view),
    movesSection(movements(view.captures, view.merges).slice(0, TOP_MOVES)),
    mergesSection(view.merges),
  ].join('\n');
}

function mergeMarker(merge: HealthMerge): TimeMarker {
  return {
    at: merge.at,
    label: `${merge.session} merged ${merge.label}${merge.prUrl ? ` — ${merge.prUrl}` : ''}`,
    ...(merge.prUrl !== undefined && PR_URL.test(merge.prUrl) ? { href: merge.prUrl } : {}),
  };
}

function metricsSection({ captures, merges }: HealthView): string {
  if (captures.length === 0) {
    return section('Gate metrics', hint('No snapshot yet — `pup init` captures the first.'));
  }
  const first = captures[0] as HealthCapture;
  const last = captures.at(-1) as HealthCapture;
  const lead = `<p class="lead">${escapeHtml(
    `${captures.length} ${captures.length === 1 ? 'snapshot' : 'snapshots'} from ${first.label} to ${last.label} UTC; ` +
      `the dashed rules are the ${merges.length} ${merges.length === 1 ? 'merge' : 'merges'}, each naming its session.`,
  )}</p>`;
  const markers = merges.map(mergeMarker);
  const charts = GATE_METRICS.map((metric) => {
    if (captures.every((capture) => capture.figures[metric.key] === undefined)) {
      return hint(`${metric.label}: not measured in any snapshot.`);
    }
    // The newest earlier capture that measured it: one counted under another rule breaks the line.
    let before: HealthCapture | undefined;
    const data = captures.map((capture): TimeDatum => {
      const value = capture.figures[metric.key];
      const breaks =
        value !== undefined && before !== undefined && !comparable(metric.key, before, capture);
      if (value !== undefined) before = capture;
      return {
        at: capture.at,
        label: capture.label,
        value,
        ...(breaks ? { breakBefore: true } : {}),
      };
    });
    return timeLineChart(data, markers, {
      title: `${metric.label} by snapshot`,
      format: metric.format,
    });
  });
  return section('Gate metrics', lead + charts.join(''));
}

function movesSection(moves: Movement[]): string {
  if (moves.length === 0) {
    return section('Snapshots that moved most', hint('No snapshot has moved a metric yet.'));
  }
  const rows = moves.map((movement) => {
    const changes = movement.moves.map((move) => {
      const metric = GATE_METRICS.find((m) => m.key === move.key) as (typeof GATE_METRICS)[number];
      return `${metric.label} ${metric.format(move.before)} → ${metric.format(move.after)} (${metric.change(move.after - move.before)})`;
    });
    return (
      `<tr><td>${escapeHtml(movement.capture.label)}</td>` +
      `<td>${changes.map((change) => `<div>${escapeHtml(change)}</div>`).join('')}</td>` +
      `<td>${mergedCell(movement.merged)}</td></tr>`
    );
  });
  return section(
    'Snapshots that moved most',
    `<table class="moves"><thead><tr><th>Snapshot (UTC)</th><th>Moved</th><th>Merged since the snapshot before</th></tr></thead>` +
      `<tbody>${rows.join('')}</tbody></table>`,
  );
}

/** The sessions merged in a move's window, the newest first, each with its PR. */
function mergedCell(merged: HealthMerge[]): string {
  if (merged.length === 0) return hint('no pup merge between the two snapshots');
  const named = [...merged]
    .reverse()
    .slice(0, NAMED_SESSIONS)
    .map((merge) => `<div>${sessionLine(merge)}</div>`);
  const more = merged.length - NAMED_SESSIONS;
  return named.join('') + (more > 0 ? hint(`and ${more} more`) : '');
}

function sessionLine(merge: HealthMerge): string {
  return (
    `<span class="sid">${escapeHtml(merge.session)}</span>` +
    (merge.prUrl === undefined ? '' : ` ${textOrPrLink(merge.prUrl)}`)
  );
}

function mergesSection(merges: HealthMerge[]): string {
  if (merges.length === 0) return section('Merges', hint('No merge yet.'));
  const rows = merges.map(
    (merge) =>
      `<li class="session"><div class="meta">${sessionLine(merge)}</div>` +
      `<div class="fact">${escapeHtml(`merged ${merge.label} UTC`)}</div></li>`,
  );
  return section(
    'Merges',
    `<details><summary>${escapeHtml(`${merges.length} merged, oldest first`)}</summary><ul class="rows">${rows.join('')}</ul></details>`,
  );
}
