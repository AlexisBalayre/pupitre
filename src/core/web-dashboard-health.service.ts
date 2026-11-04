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
import type { SessionEvent } from './types/session-event.types.js';
import {
  escapeHtml,
  GATE_METRICS,
  hint,
  listSection,
  section,
  textOrPrLink,
  UNMINTED_LABEL,
} from './web-dashboard-sheet.utils.js';

type Figures = Omit<DashboardBaseline, 'capturedAt'>;
type MetricKey = keyof Figures;
type Metric = (typeof GATE_METRICS)[number];

/** One `baseline_history` capture as the Health sheet reads it. */
interface HealthCapture {
  at: number;
  /** Printed from `at`, so no store text reaches the page through it. */
  label: string;
  figures: Figures;
  /** The rule each figure was counted under: only duplication has one (decision 39). */
  rules: Partial<Record<MetricKey, string | undefined>>;
}

/** A session's first merge, the one that landed its work. */
interface HealthMerge {
  /** When its work reached the target: the merge, or for a pull request its first `landed` event. */
  at: number;
  label: string;
  /** The session id, or `UNMINTED_LABEL` for one outside the minted shape. */
  session: string;
  /** Through `sanitizeReason` and `displayText`, empty for a local merge; a link only in a PR url's shape. */
  prUrl: string;
}

interface HealthView {
  captures: HealthCapture[];
  merges: HealthMerge[];
}

/** A capture that measured a metric, and the one it compares with, if any. */
interface Point {
  capture: HealthCapture;
  value: number;
  previous: Point | undefined;
}

/** One metric's points, keyed by the capture that measured them. */
interface Series {
  metric: Metric;
  points: Map<HealthCapture, Point>;
}

/** One metric's change at a capture. */
interface Move {
  metric: Metric;
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
  /** The sessions whose merge is placed after the earliest `since` and at or before the capture. */
  merged: HealthMerge[];
}

const TOP_MOVES = 10;

/** A store time as the page prints it, minutes and no seconds, in UTC. */
function timeLabel(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Every capture oldest first, and every session's first merge, the one that
 * landed it: a fix round's re-gate records another (decision 98). A `--pr`
 * merge's event is written when the gate opens the PR; its work reaches the
 * target, and the audit's next snapshot, only at `pup land`, so it is placed
 * at its first `landed` event, and left out until it has one. A capture or
 * merge whose time does not parse has no place on the axis and is left out.
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
        rules: { duplicatedLines: debt?.duplicationRule },
      },
    ];
  });
  // An empty `landed_at` parses to no time, like a torn one.
  const rows = db
    .prepare(
      `SELECT m.session_id, m.type, m.payload, m.created_at,
         COALESCE((SELECT l.created_at FROM events l WHERE l.type = 'landed'
           AND l.session_id = m.session_id ORDER BY l.id LIMIT 1), '') AS landed_at
       FROM events m WHERE m.id IN
         (SELECT MIN(id) FROM events WHERE type = 'merge' AND session_id IS NOT NULL GROUP BY session_id)
       ORDER BY m.id`,
    )
    .all() as (Pick<EventRow, 'type' | 'payload' | 'created_at'> & {
    session_id: string;
    landed_at: string;
  })[];
  const merges = rows.flatMap((row) => {
    // Every row is a merge, by the query.
    const { prUrl } = decodeEvent(row) as Extract<SessionEvent, { type: 'merge' }>;
    const at = Date.parse(toIsoUtc(prUrl === undefined ? row.created_at : row.landed_at));
    if (Number.isNaN(at)) return [];
    return [
      {
        at,
        label: timeLabel(at),
        session: SESSION_ID_PATTERN.test(row.session_id) ? row.session_id : UNMINTED_LABEL,
        prUrl: displayText(sanitizeReason(prUrl ?? '')),
      },
    ];
  });
  // Stable, so two merges at one instant keep the order they were recorded in.
  return { captures, merges: merges.sort((a, b) => a.at - b.at) };
}

/**
 * A metric's points: each capture that measured it compares with the newest
 * earlier one that did, so a gap hides no change, and with none when that one
 * counted it under another rule (decision 39).
 */
function series(captures: HealthCapture[], metric: Metric): Series {
  const points = new Map<HealthCapture, Point>();
  let last: Point | undefined;
  for (const capture of captures) {
    const value = capture.figures[metric.key];
    if (value === undefined) continue;
    const previous =
      last?.capture.rules[metric.key] === capture.rules[metric.key] ? last : undefined;
    last = { capture, value, previous };
    points.set(capture, last);
  }
  return { metric, points };
}

/**
 * Each capture's moves: every figure that differs from the one it compares
 * with. A move's size is its change over the larger of its two values, so a
 * count and a ratio rank on one scale, and a figure leaving zero counts in full.
 */
function movements(view: HealthView, lines: Series[]): Movement[] {
  return (
    view.captures
      .map((capture) => {
        const moves = lines.flatMap(({ metric, points }): Move[] => {
          const point = points.get(capture);
          return point?.previous === undefined || point.previous.value === point.value
            ? []
            : [
                {
                  metric,
                  before: point.previous.value,
                  after: point.value,
                  since: point.previous.capture.at,
                },
              ];
        });
        const since = moves.reduce((earliest, move) => Math.min(earliest, move.since), capture.at);
        return {
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
          merged: view.merges.filter((merge) => merge.at > since && merge.at <= capture.at),
        };
      })
      .filter((movement) => movement.moves.length > 0)
      // Newest first, then a stable sort by size: a tie goes to the newer capture.
      .reverse()
      .sort((a, b) => b.size - a.size)
  );
}

/**
 * The Health sheet (decision 98): one line per gate metric across every
 * capture, each session's merge marked on the time axis, the captures that
 * moved a metric most with the sessions merged since the capture before, and
 * every merge with its pull request. Nothing in it is relative to now, so an
 * unchanged store renders the same board.
 */
export function renderHealthSheet(view: HealthView): string {
  const lines = GATE_METRICS.map((metric) => series(view.captures, metric));
  return [
    metricsSection(view, lines),
    listSection(
      'Snapshots that moved most',
      movements(view, lines).slice(0, TOP_MOVES),
      'No snapshot has moved a metric yet.',
      movesTable,
    ),
    listSection('Merges', view.merges, 'No merge yet.', mergeList),
  ].join('\n');
}

function mergeMarker(merge: HealthMerge): TimeMarker {
  return {
    at: merge.at,
    label: `${merge.session} merged ${merge.label} ${merge.prUrl}`.trimEnd(),
    ...(PR_URL.test(merge.prUrl) ? { href: merge.prUrl } : {}),
  };
}

function metricsSection({ captures, merges }: HealthView, lines: Series[]): string {
  const markers = merges.map(mergeMarker);
  return listSection(
    'Gate metrics',
    captures,
    'No snapshot yet — `pup init` captures the first.',
    () =>
      `<p class="lead">${escapeHtml(
        `Snapshots: ${captures.length}, from ${captures[0]?.label} to ${captures.at(-1)?.label} UTC. ` +
          `Merges, each a dashed rule naming its session: ${merges.length}.`,
      )}</p>` +
      lines
        .map(({ metric, points }) => {
          if (points.size === 0) return hint(`${metric.label}: not measured in any snapshot.`);
          // A capture with nothing to compare with starts a line of its own.
          const data = captures.map((capture): TimeDatum => {
            const point = points.get(capture);
            return {
              at: capture.at,
              label: capture.label,
              value: point?.value,
              breakBefore: point?.previous === undefined,
            };
          });
          return timeLineChart(data, markers, {
            title: `${metric.label} by snapshot`,
            format: metric.format,
          });
        })
        .join(''),
  );
}

function movesTable(moves: Movement[]): string {
  const rows = moves.map((movement) => {
    const changes = movement.moves.map(
      ({ metric, before, after }) =>
        `${metric.label} ${metric.format(before)} → ${metric.format(after)} (${metric.change(after - before)})`,
    );
    return (
      `<tr><td>${escapeHtml(movement.capture.label)}</td>` +
      `<td>${changes.map((change) => `<div>${escapeHtml(change)}</div>`).join('')}</td>` +
      `<td>${mergedCell(movement.merged)}</td></tr>`
    );
  });
  return (
    `<table class="moves"><thead><tr><th>Snapshot (UTC)</th><th>Moved</th><th>Merged since the snapshot before</th></tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table>`
  );
}

/** Every session merged in a move's window, the newest first, each with its PR. */
function mergedCell(merged: HealthMerge[]): string {
  if (merged.length === 0) return hint('no pup merge between the two snapshots');
  return [...merged]
    .reverse()
    .map((merge) => `<div>${sessionLine(merge)}</div>`)
    .join('');
}

function sessionLine(merge: HealthMerge): string {
  return (
    `<span class="sid">${escapeHtml(merge.session)}</span>` +
    (merge.prUrl === '' ? '' : ` ${textOrPrLink(merge.prUrl)}`)
  );
}

function mergeList(merges: HealthMerge[]): string {
  const rows = merges.map(
    (merge) =>
      `<li class="session"><div class="meta">${sessionLine(merge)}</div>` +
      `<div class="fact">${escapeHtml(`merged ${merge.label} UTC`)}</div></li>`,
  );
  return `<details><summary>${escapeHtml(`${merges.length} merged, oldest first`)}</summary><ul class="rows">${rows.join('')}</ul></details>`;
}
