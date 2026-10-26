import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import {
  type BaselineHistoryRow,
  baselineHistoryAsOf,
  listRecentBaselineHistory,
} from './baseline-history.repository.js';
import { briefDestination, readBrief } from './brief.service.js';
import { barChart, type ChartDatum, sparkline } from './chart.utils.js';
import {
  buildDashboardSnapshot,
  debtFigures,
  needsYou,
  PR_URL,
  prFixRounds,
  routeLabel,
} from './dashboard.service.js';
import { countLedgerEntriesSince, listLedgerEntries } from './ledger.repository.js';
import { projectId } from './paths.utils.js';
import { displayText, parseJsonOr, toIsoUtc } from './report-data.utils.js';
import { getProject } from './session.repository.js';
import type {
  DashboardBaseline,
  DashboardNeed,
  DashboardSession,
  DashboardSnapshot,
} from './types/dashboard.types.js';
import type { DebtBaseline, ProjectBaseline } from './types/init.types.js';
import { DAY_MS, escapeHtml, hint, section } from './web-dashboard-sheet.utils.js';

const WEEK_MS = 7 * DAY_MS;
const MERGE_WEEKS = 8;
/** Captures a figure tile's sparkline draws, newest last. */
const TREND_CAPTURES = 8;

/** One open ledger entry as the page lists it, every field already through `sanitizeReason`. */
interface WebDebtEntry {
  id: string;
  description: string;
}

/** One figure tile: what it counts, the figure, how it moved over a week, and its captures. */
interface FigureTile {
  label: string;
  figure: string;
  change: string;
  trend: ChartDatum[];
  format: (value: number) => string;
}

/** What one render of the Overview reads (decision 98). */
interface OverviewView {
  snapshot: DashboardSnapshot;
  needs: DashboardNeed[];
  openDebt: WebDebtEntry[];
  /** Fix rounds re-gated per session with an open PR, keyed by session id (decision 86). */
  fixRounds: Map<string, number>;
  /** The brief's Destination, or the one line that says why there is none. */
  goal: { text: string } | { hint: string };
  tiles: FigureTile[];
  tasks: { done: number; inFlight: number; planned: number };
  merges: ChartDatum[];
}

/** The store's reading for one render of the Overview. */
export function readOverview(db: Database, repoPath: string, now: number): OverviewView {
  const pid = projectId(repoPath);
  const snapshot = buildDashboardSnapshot(db, repoPath, now);
  const fixRounds = new Map(
    snapshot.sessions
      .filter((session) => session.openPr !== undefined && session.isMintedId)
      .map((session) => [session.id, prFixRounds(db, session.id)]),
  );
  return {
    snapshot,
    needs: needsYou(snapshot),
    // Read off the store like the snapshot's overdue entries, and scrubbed the
    // same way, so an id here matches the one the snapshot marks overdue.
    openDebt: listLedgerEntries(db, pid).map((entry) => ({
      id: sanitizeReason(String(entry.id)),
      description: sanitizeReason(entry.description),
    })),
    fixRounds,
    goal: readGoal(repoPath),
    tiles: figureTiles(db, pid, snapshot, now),
    tasks: taskCounts(snapshot),
    merges: mergesPerWeek(db, now),
  };
}

/**
 * The brief's Destination as the page's lead. `readBrief` has stripped control
 * characters but kept the layout a Markdown document is written in, so the
 * page is left the direction marks, which `displayText` replaces, and the
 * escaping, and keeps the line breaks. A brief over its cap, or not a regular
 * file, is the operator's to fix, said in its place rather than failing the
 * sheet.
 */
function readGoal(repoPath: string): OverviewView['goal'] {
  let brief: string | undefined;
  try {
    brief = readBrief(repoPath);
  } catch (error) {
    return { hint: sanitizeReason((error as Error).message) };
  }
  const destination = brief === undefined ? undefined : briefDestination(brief);
  return destination === undefined
    ? { hint: 'No goal yet — `pup brief edit` writes the Destination.' }
    : { text: displayText(destination) };
}

const pct = (ratio: number): string => `${Math.round(ratio * 1000) / 10}%`;

/** The baseline figures a tile can show, in the order the tiles stand. */
const METRICS: {
  key: keyof Omit<DashboardBaseline, 'capturedAt'>;
  label: string;
  format: (value: number) => string;
  /** How a week's movement prints: counts as counts, the ratio in percentage points. */
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

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** The stored debt baseline as `pup audit` last wrote it, for the rule its duplication was counted under. */
function storedDebt(db: Database, pid: string): DebtBaseline | undefined {
  const stored = getProject(db, pid)?.baseline;
  return stored ? parseJsonOr<Partial<ProjectBaseline>>(stored, {}).debt : undefined;
}

/** A capture's debt column, null when nothing measured debt then. */
function captureDebt(row: BaselineHistoryRow): DebtBaseline | undefined {
  return row.debt === null ? undefined : parseJsonOr<DebtBaseline | undefined>(row.debt, undefined);
}

/**
 * The four figure tiles: open debt as `pup debt` counts it, and the three
 * baseline figures as `pup audit` stores them and `pup status` prints them,
 * off the snapshot's baseline; every capture is read through the same
 * `debtFigures`. A week's change compares
 * with the newest capture at least seven days old in `baseline_history`; a
 * duplication count taken under another rule is not compared, as `pup audit`
 * does not compare it (decision 39). The ledger keeps no closing time, so open
 * debt says what was filed in the week.
 */
function figureTiles(
  db: Database,
  pid: string,
  snapshot: DashboardSnapshot,
  now: number,
): FigureTile[] {
  const current = storedDebt(db, pid);
  const figures: Omit<DashboardBaseline, 'capturedAt'> = snapshot.baseline ?? {};
  const pastRow = baselineHistoryAsOf(db, pid, new Date(now - WEEK_MS));
  const pastDebt = pastRow && captureDebt(pastRow);
  const past = debtFigures(pastDebt);
  const captures = listRecentBaselineHistory(db, pid, TREND_CAPTURES).map((row) => ({
    at: toIsoUtc(sanitizeReason(row.captured_at)).slice(5, 10),
    figures: debtFigures(captureDebt(row)),
  }));
  const filed = countLedgerEntriesSince(db, pid, new Date(now - WEEK_MS));
  return [
    {
      label: 'open debt',
      figure: String(snapshot.openDebtCount),
      change: `${filed} filed in 7 days`,
      trend: [],
      format: String,
    },
    ...METRICS.map((metric) => {
      const value = figures[metric.key];
      const before = past[metric.key];
      const comparable =
        metric.key !== 'duplicatedLines' || pastDebt?.duplicationRule === current?.duplicationRule;
      const change =
        value === undefined
          ? 'not measured — `pup init` measures it'
          : pastRow === undefined
            ? 'no capture 7 days back'
            : before === undefined || !comparable
              ? 'not comparable with 7 days back'
              : value === before
                ? 'no change in 7 days'
                : `${metric.change(value - before)} in 7 days`;
      return {
        label: metric.label,
        figure: value === undefined ? '—' : metric.format(value),
        change,
        trend: captures.flatMap((capture) => {
          const figure = capture.figures[metric.key];
          return figure === undefined ? [] : [{ label: capture.at, value: figure }];
        }),
        format: metric.format,
      };
    }),
  ];
}

/**
 * Tasks by where they stand: done once a session of theirs merged, in flight
 * while one is live, planned while nothing claims them — the backlog the
 * Planned section lists.
 */
function taskCounts(snapshot: DashboardSnapshot): OverviewView['tasks'] {
  const done = new Set(snapshot.sessions.filter((s) => s.state === 'merged').map((s) => s.taskId));
  const inFlight = new Set(
    snapshot.sessions
      .filter((s) => s.state !== 'merged' && s.state !== 'killed' && !done.has(s.taskId))
      .map((s) => s.taskId),
  );
  return { done: done.size, inFlight: inFlight.size, planned: snapshot.backlog.length };
}

/**
 * Sessions merged per week over the last eight, each counted at its first
 * `merge` event: a fix round's re-gate records another, and is not new work.
 * The weeks end with today, in UTC, so the buckets move once a day and an
 * unchanged store renders the same board in between.
 *
 * One grouped query rather than each session's events, since it runs on every
 * poll; the store has no events query of this shape, and this is its only
 * reader. A session whose first merge is older than the window is left out
 * there, not after the read.
 */
function mergesPerWeek(db: Database, now: number): ChartDatum[] {
  const end = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  const counts = new Array<number>(MERGE_WEEKS).fill(0);
  const firstMerges = db
    .prepare(
      `SELECT MIN(created_at) AS at FROM events WHERE type = 'merge'
       GROUP BY session_id HAVING MIN(created_at) >= datetime(?)`,
    )
    .all(new Date(end - MERGE_WEEKS * WEEK_MS).toISOString()) as { at: string }[];
  for (const { at } of firstMerges) {
    const week = Math.floor((end - Date.parse(toIsoUtc(at))) / WEEK_MS);
    const slot = MERGE_WEEKS - 1 - week;
    if (week >= 0 && week < MERGE_WEEKS) counts[slot] = (counts[slot] ?? 0) + 1;
  }
  return counts.map((value, i) => ({
    label: new Date(end - (MERGE_WEEKS - i) * WEEK_MS).toISOString().slice(5, 10),
    value,
  }));
}

/** Escaped text, or a link when it is a pull request's url and nothing else (decisions 83, 91). */
function textOrPrLink(text: string): string {
  if (!PR_URL.test(text)) return `<code>${escapeHtml(text)}</code>`;
  // `noreferrer`: the page's own url carries the run token.
  return `<a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

/** The order the sessions' states are listed in: what has stopped first, finished work last. */
const STATE_ORDER = ['blocked', 'running', 'awaiting-review', 'queued', 'rejected'];
const UNMINTED_LABEL = '(unminted session id)';

/**
 * The Overview: the goal and the figures first, then the live sections `pup
 * status` prints. Nothing in it is time-relative beyond what the snapshot
 * holds and the day the weeks end on, so an unchanged store renders the same
 * string and the stream stays quiet. `debtHref` is the Debt sheet's url.
 */
export function renderOverview(view: OverviewView, debtHref: string): string {
  return [
    goalSection(view.goal),
    figuresSection(view.tiles, debtHref),
    deliverySection(view),
    needsSection(view.needs),
    conductorSection(view.snapshot),
    sessionsSection(view),
    pullRequestsSection(view),
    plannedSection(view.snapshot),
  ].join('\n');
}

function goalSection(goal: OverviewView['goal']): string {
  return section(
    'Goal',
    'text' in goal ? `<p class="brief">${escapeHtml(goal.text)}</p>` : hint(goal.hint),
  );
}

function figuresSection(tiles: FigureTile[], debtHref: string): string {
  const cells = tiles.map(
    (tile) =>
      `<div class="tile"><div class="k">${escapeHtml(tile.label)}</div>` +
      `<div class="v">${escapeHtml(tile.figure)}</div><div class="d">${escapeHtml(tile.change)}</div>` +
      (tile.trend.length > 1
        ? sparkline(tile.trend, { title: `${tile.label} by capture`, format: tile.format })
        : '') +
      '</div>',
  );
  return section(
    'Figures',
    `<div class="tiles">${cells.join('')}</div>` +
      `<p class="more"><a href="${escapeHtml(debtHref)}">Debt sheet: what to pay down next →</a></p>`,
  );
}

function deliverySection(view: OverviewView): string {
  const { done, inFlight, planned } = view.tasks;
  const tasks =
    done + inFlight + planned === 0
      ? hint('No task yet — `pup plan` adds one.')
      : barChart(
          [
            { label: 'done', value: done },
            { label: 'in flight', value: inFlight },
            { label: 'planned', value: planned },
          ],
          { title: 'Tasks', layout: 'rows' },
        );
  const merges = view.merges.some((week) => week.value > 0)
    ? barChart(view.merges, { title: 'Merges per week, week starting' })
    : hint(`No merge in the last ${MERGE_WEEKS} weeks.`);
  return section('Delivery', `${tasks}${merges}`);
}

function needsSection(needs: DashboardNeed[]): string {
  if (needs.length === 0) return section('Needs you', hint('Nothing waits on you.'));
  const items = needs.map(
    (need) =>
      `<li class="need need-${escapeHtml(need.kind)}"><span class="sid">${escapeHtml(need.label)}</span> ` +
      `<span class="reason">${escapeHtml(need.reason)}</span>` +
      `<div class="answer">${textOrPrLink(need.answer)}</div></li>`,
  );
  return section('Needs you', `<ul class="rows">${items.join('')}</ul>`);
}

function conductorSection(snapshot: DashboardSnapshot): string {
  const { conductor } = snapshot;
  const body = conductor.running
    ? `<p>running <span class="hint">attach:</span> <code>${escapeHtml(conductor.attachCommand)}</code></p>`
    : hint('not running — `pup conductor start` starts it');
  return section('Conductor', body);
}

function sessionsSection(view: OverviewView): string {
  const live = view.snapshot.sessions.filter((s) => s.state !== 'merged' && s.state !== 'killed');
  if (live.length === 0) return section('Sessions', hint('Nothing running.'));
  const states = [
    ...STATE_ORDER.filter((state) => live.some((s) => s.state === state)),
    ...new Set(live.map((s) => s.state).filter((state) => !STATE_ORDER.includes(state))),
  ];
  const groups = states.map((state) => {
    const rows = live.filter((s) => s.state === state).map((s) => sessionRow(s, view.openDebt));
    return `<h3 class="state-group">${escapeHtml(state)} <span class="hint">${rows.length}</span></h3><ul class="rows">${rows.join('')}</ul>`;
  });
  return section('Sessions', groups.join(''));
}

function sessionRow(session: DashboardSession, openDebt: WebDebtEntry[]): string {
  const facts = [
    session.question === undefined ? '' : `question: ${session.question}`,
    activityText(session),
    routeLabel(session),
    session.rejectCount > 0 ? `${session.rejectCount} rejections` : '',
    session.contextTokens === undefined ? '' : `ctx ~${Math.round(session.contextTokens / 1000)}k`,
    steerText(session),
    gateText(session),
  ].filter(Boolean);
  return (
    `<li class="session"><div class="meta"><span class="sid">${escapeHtml(labelOf(session))}</span>` +
    `<span class="branch">${escapeHtml(session.branch)}</span></div>` +
    `<div class="goal">${escapeHtml(session.goal || '(no goal recorded)')}</div>` +
    facts.map((fact) => `<div class="fact">${escapeHtml(fact)}</div>`).join('') +
    debtOf(session, openDebt) +
    '</li>'
  );
}

function labelOf(session: DashboardSession): string {
  return session.isMintedId ? session.id : UNMINTED_LABEL;
}

function activityText(session: DashboardSession): string {
  if (session.stalledAgeMs !== undefined) return 'stalled — see Needs you';
  if (session.activity?.kind === 'awaiting-input') {
    const detail = sanitizeReason(session.activity.detail ?? '');
    return `waiting on input${detail ? ` (${detail})` : ''}`;
  }
  if (session.activity?.kind === 'idle') return 'idle (turn ended, no done signal)';
  if (session.activity?.kind === 'background') return 'working on a background shell';
  return '';
}

function steerText(session: DashboardSession): string {
  const steer = session.lastSteer;
  if (!steer) return '';
  return `last steer: ${steer.kind ?? 'sent'}${steer.by ? ` by ${steer.by}` : ''} at ${steer.at}`;
}

function gateText(session: DashboardSession): string {
  const gate = session.lastGate;
  if (!gate) return '';
  const verdict = gate.passed
    ? 'passed'
    : `failed${gate.failedStage ? ` at ${gate.failedStage}` : ''}`;
  return `last gate: ${verdict} at ${gate.at}`;
}

/**
 * The open entries this session filed: every flag description the gate files
 * ends with ` session <id>` (decision 86). An id outside the minted shape is
 * matched against nothing, like the commands it gets none of.
 */
function debtOf(session: DashboardSession, openDebt: WebDebtEntry[]): string {
  if (!session.isMintedId) return '';
  const own = openDebt.filter((entry) => entry.description.endsWith(` session ${session.id}`));
  return own
    .map(
      (entry) =>
        `<div class="fact debt">debt #${escapeHtml(entry.id)}: ${escapeHtml(entry.description)}</div>`,
    )
    .join('');
}

function pullRequestsSection(view: OverviewView): string {
  const open = view.snapshot.sessions.filter((s) => s.openPr !== undefined);
  if (open.length === 0) return section('Open pull requests', hint('No PR waits to land.'));
  const rows = open.map((session) => {
    const url = session.openPr?.url;
    const link =
      url === undefined
        ? `<code>${escapeHtml('(PR url outside the pull-request shape; inspect the store)')}</code>`
        : textOrPrLink(url);
    return (
      `<li class="session"><div class="meta"><span class="sid">${escapeHtml(labelOf(session))}</span>${link}</div>` +
      `<div class="goal">${escapeHtml(session.goal || '(no goal recorded)')}</div>` +
      `<div class="fact">${escapeHtml(reviewState(session, view.fixRounds.get(session.id)))}</div>` +
      debtOf(session, view.openDebt) +
      '</li>'
    );
  });
  return section('Open pull requests', `<ul class="rows">${rows.join('')}</ul>`);
}

/**
 * The PR's CI review state as the store knows it: how many fix rounds were
 * re-gated, and the newest gate's verdict, which on a refused re-gate is what
 * says the PR still vouches for the earlier pin (decision 86). What CI itself
 * said is on the PR until `pup fix` reads the bot's threads (decision 90).
 */
function reviewState(session: DashboardSession, rounds: number | undefined): string {
  const regated =
    rounds === undefined
      ? 'fix rounds unknown'
      : rounds === 0
        ? 'gated once, no fix round re-gated yet'
        : `re-gated after ${rounds} fix ${rounds === 1 ? 'round' : 'rounds'}`;
  const gate = gateText(session);
  return `CI review: ${regated}${gate ? `; ${gate}` : ''}`;
}

function plannedSection(snapshot: DashboardSnapshot): string {
  if (snapshot.backlog.length === 0) return section('Planned', hint('Nothing planned.'));
  const rows = snapshot.backlog.map(
    (task) =>
      `<li class="session"><div class="meta"><span class="sid">${escapeHtml(task.id)}</span>` +
      `${task.origin === 'human' ? '' : `<span class="branch">from ${escapeHtml(task.origin)}</span>`}</div>` +
      `<div class="goal">${escapeHtml(task.goal || '(no goal recorded)')}</div></li>`,
  );
  return section('Planned', `<ul class="rows">${rows.join('')}</ul>`);
}
