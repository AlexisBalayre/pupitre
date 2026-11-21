import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import {
  baselineHistoryAsOf,
  captureDebt,
  listRecentBaselineHistory,
} from './baseline-history.repository.js';
import { briefDestination, readBrief } from './brief.service.js';
import { barChart, sparkline } from './chart.utils.js';
import {
  buildDashboardSnapshot,
  CONDUCTOR_TARGET,
  debtFigures,
  needsYou,
  prFixRounds,
  routeLabel,
} from './dashboard.service.js';
import { countLedgerEntriesSince, listLedgerEntries } from './ledger.repository.js';
import { projectId } from './paths.utils.js';
import { displayText, parseJsonOr, toIsoUtc } from './report-data.utils.js';
import { getProject } from './session.repository.js';
import { launchHolds, launchRoom, launchRoomLines } from './session-cap.service.js';
import type { ChartDatum } from './types/chart.types.js';
import type {
  DashboardBaseline,
  DashboardNeed,
  DashboardSession,
  DashboardSnapshot,
} from './types/dashboard.types.js';
import type { DebtBaseline, ProjectBaseline } from './types/init.types.js';
import type {
  FigureTile,
  MachineLoad,
  OverviewView,
  WebDebtEntry,
} from './types/web-dashboard-overview.types.js';
import type { SheetName } from './types/web-dashboard-sheet.types.js';
import { actionButton, answerForms, textAction } from './web-dashboard-actions.service.js';
import {
  clipWords,
  DAY_MS,
  escapeHtml,
  GATE_METRICS,
  hint,
  section,
  textOrPrLink,
  UNMINTED_LABEL,
} from './web-dashboard-sheet.utils.js';

const WEEK_MS = 7 * DAY_MS;
const MERGE_WEEKS = 8;
/** Captures a figure tile's sparkline draws, newest last. */
const TREND_CAPTURES = 8;
/** Planned tasks the Overview lists; the Tasks sheet lists them all. */
const PLANNED_SHOWN = 3;

/** The store's reading, and the machine's `load`, for one render of the Overview. */
export function readOverview(
  db: Database,
  repoPath: string,
  now: number,
  load: MachineLoad,
): OverviewView {
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
    // same way, so an id here matches the one the snapshot marks overdue. The
    // description also loses its direction marks, as on the Debt sheet: a flag
    // can quote a path the session chose (decision 98).
    openDebt: listLedgerEntries(db, pid).map((entry) => ({
      id: sanitizeReason(String(entry.id)),
      description: displayText(sanitizeReason(entry.description)),
    })),
    fixRounds,
    goal: readGoal(repoPath),
    tiles: figureTiles(db, pid, snapshot, now),
    tasks: taskCounts(snapshot),
    merges: mergesPerWeek(db, now),
    launch: launchVerdict(db, repoPath, load),
  };
}

/**
 * The verdict line `pup status` prints under `Launch:`, every check `pup
 * launch` makes named in it, and the load beside it; a config it cannot read
 * is said in its place, as `pup status` says it (decision 197).
 */
function launchVerdict(db: Database, repoPath: string, load: MachineLoad): string {
  try {
    const [verdict] = launchRoomLines(launchRoom(db, repoPath, load), launchHolds(repoPath));
    return `${verdict}; load ${load.average.toFixed(1)} of ${load.cores} cores`;
  } catch (error) {
    return `Launch: unknown, ${sanitizeReason((error as Error).message)}`;
  }
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

/** The stored debt baseline as `pup audit` last wrote it, for the rule its duplication was counted under. */
function storedDebt(db: Database, pid: string): DebtBaseline | undefined {
  const stored = getProject(db, pid)?.baseline;
  return stored ? parseJsonOr<Partial<ProjectBaseline>>(stored, {}).debt : undefined;
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
    ...GATE_METRICS.map((metric) => {
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

/** The order the sessions' states are listed in: what has stopped first, finished work last. */
const STATE_ORDER = ['blocked', 'running', 'awaiting-review', 'queued', 'rejected'];

/**
 * The Overview, a page to act from: the status strip, what needs the operator
 * with each line's action beside it, the running sessions, the open PRs not
 * already in Needs you, the conductor and the first planned tasks; then the
 * goal, the figures and the delivery charts. Nothing in it is time-relative
 * beyond what the snapshot holds, the day the weeks end on and the load the
 * strip prints, so an unchanged store on a steady machine renders the same
 * string and the stream stays quiet. `hrefOf` is a sheet's url and
 * `sessionHref` a session view's, where that session's actions are; a
 * question is answered here, the conductor told, and a planned task launched
 * (decision 91).
 */
export function renderOverview(
  view: OverviewView,
  hrefOf: (sheet: SheetName) => string,
  sessionHref: (sessionId: string) => string,
): string {
  return [
    statusStrip(view),
    needsSection(view, sessionHref),
    sessionsSection(view, sessionHref),
    pullRequestsSection(view),
    conductorSection(view.snapshot),
    plannedSection(view.snapshot, hrefOf('tasks')),
    goalSection(view.goal),
    figuresSection(view.tiles, hrefOf('debt')),
    deliverySection(view),
  ].join('\n');
}

/** The sessions with a PR open, by id. */
function openPrs(view: OverviewView): Map<string, DashboardSession> {
  return new Map(
    view.snapshot.sessions.filter((s) => s.openPr !== undefined).map((s) => [s.id, s]),
  );
}

/**
 * The session a PR's Needs you line is about. Only a merged session has a PR
 * open, and a merged session has no other line, so every open PR has this one.
 */
function prSessionOf(
  need: DashboardNeed,
  prs: Map<string, DashboardSession>,
): DashboardSession | undefined {
  return need.kind === 'pr-open' ? prs.get(need.sessionId) : undefined;
}

/** The counts the page leads with, and the launch verdict `pup status` prints. */
function statusStrip(view: OverviewView): string {
  const { sessions } = view.snapshot;
  const count = (n: number, label: string): string =>
    `<li><span class="v">${n}</span> ${escapeHtml(label)}</li>`;
  return (
    '<section class="strip"><ul>' +
    count(sessions.filter((s) => s.state === 'running').length, 'running') +
    count(sessions.filter((s) => s.state === 'awaiting-review').length, 'awaiting review') +
    count(view.needs.length, 'need you') +
    count(openPrs(view).size, 'open PRs') +
    `<li class="launch">${escapeHtml(view.launch)}</li></ul></section>`
  );
}

function goalSection(goal: OverviewView['goal']): string {
  return section(
    'Goal',
    'text' in goal ? `<p class="brief">${escapeHtml(goal.text)}</p>` : hint(goal.hint),
  );
}

/**
 * Each tile's value, its week's change and, from two captures on, its
 * sparkline; the shell hides the sparkline's figure line, and its SVG title
 * keeps every capture as the hover.
 */
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

/**
 * Each line with its answer as text beside its reason, and, for a line about a
 * session or the conductor the store names in the minted shape, the way to act
 * on it: a question's options and an answer in words, and a session's view. A
 * PR's line, whose answer is its link, carries the PR's CI review state and
 * debt too, so Open pull requests only counts them. Only a question that links
 * to its session's view, which holds the whole text, is cut at a word like a
 * card's: the conductor's and an unminted session's have no view, and the
 * reasons pup builds carry the decision-188 widened scope whole.
 */
function needsSection(view: OverviewView, sessionHref: (sessionId: string) => string): string {
  const { needs } = view;
  if (needs.length === 0) return section('Needs you', hint('Nothing waits on you.'));
  const prs = openPrs(view);
  const items = needs.map((need) => {
    const named = need.label === need.sessionId && need.kind !== 'conductor';
    // A question line names the event it shows, which the answer is bound to:
    // without it, no answer form, since one would be refused.
    const answer =
      named && need.kind === 'question' && need.questionId !== undefined
        ? answerForms(need.sessionId, {
            id: need.questionId,
            options: need.options ?? [],
            ...(need.recommended === undefined ? {} : { recommended: need.recommended }),
          })
        : '';
    const open =
      named && need.sessionId !== CONDUCTOR_TARGET
        ? ` ${viewLink(need.sessionId, sessionHref)}`
        : '';
    const pr = prSessionOf(need, prs);
    return (
      `<li class="need need-${escapeHtml(need.kind)}"><span class="sid">${escapeHtml(need.label)}</span>${open} ` +
      `<span class="reason">${escapeHtml(need.kind === 'question' && open !== '' ? clipWords(need.reason) : need.reason)}</span>` +
      `<span class="answer">${textOrPrLink(need.answer)}</span>` +
      (pr === undefined ? '' : prFacts(pr, view)) +
      `${answer}</li>`
    );
  });
  return section('Needs you', `<ul class="rows">${items.join('')}</ul>`);
}

/** What an open PR's line says beyond its link: its CI review state and the debt it filed. */
function prFacts(session: DashboardSession, view: OverviewView): string {
  const review = escapeHtml(reviewState(session, view.fixRounds.get(session.id)));
  return `<div class="fact">${review}</div>${debtOf(session, view.openDebt)}`;
}

function conductorSection(snapshot: DashboardSnapshot): string {
  const { conductor } = snapshot;
  const body = conductor.running
    ? `<div class="inline"><p>running <span class="hint">attach:</span> <code>${escapeHtml(conductor.attachCommand)}</code></p>` +
      `${textAction('tell', {}, 'message', 'a message for the conductor', 'Tell')}</div>`
    : hint('not running — `pup conductor start` starts it');
  return section('Conductor', body);
}

/** The link to a session's view, where its pane, its attach line and its actions are. */
function viewLink(sessionId: string, sessionHref: (sessionId: string) => string): string {
  return `<a href="${escapeHtml(sessionHref(sessionId))}">open</a>`;
}

function sessionsSection(view: OverviewView, sessionHref: (sessionId: string) => string): string {
  const live = view.snapshot.sessions.filter((s) => s.state !== 'merged' && s.state !== 'killed');
  if (live.length === 0) return section('Sessions', hint('Nothing running.'));
  const states = [
    ...STATE_ORDER.filter((state) => live.some((s) => s.state === state)),
    ...new Set(live.map((s) => s.state).filter((state) => !STATE_ORDER.includes(state))),
  ];
  const groups = states.map((state) => {
    const rows = live
      .filter((s) => s.state === state)
      .map((s) => sessionRow(s, view.openDebt, sessionHref));
    return `<h3 class="state-group">${escapeHtml(state)} <span class="hint">${rows.length}</span></h3><ul class="rows">${rows.join('')}</ul>`;
  });
  return section('Sessions', groups.join(''));
}

/** A live session's card: its id and branch, its goal, then its facts on one line and the debt it filed. */
function sessionRow(
  session: DashboardSession,
  openDebt: WebDebtEntry[],
  sessionHref: (sessionId: string) => string,
): string {
  const facts = [
    // The question itself, and its answers, are on the session's Needs you line.
    session.question === undefined ? '' : 'question — see Needs you',
    activityText(session),
    routeLabel(session),
    session.rejectCount > 0 ? `${session.rejectCount} rejections` : '',
    session.contextTokens === undefined ? '' : `ctx ~${Math.round(session.contextTokens / 1000)}k`,
    steerText(session),
    gateText(session),
  ].filter(Boolean);
  return (
    `<li class="session"><div class="meta"><span class="sid">${escapeHtml(labelOf(session))}</span>` +
    `<span class="branch">${escapeHtml(session.branch)}</span>` +
    `${session.isMintedId ? viewLink(session.id, sessionHref) : ''}</div>` +
    goalLine(session.goal) +
    (facts.length === 0 ? '' : `<div class="fact">${escapeHtml(facts.join(' · '))}</div>`) +
    debtOf(session, openDebt) +
    '</li>'
  );
}

/** A card's goal, cut at a word boundary: the whole of it is on the session's view or the Tasks sheet. */
function goalLine(goal: string): string {
  return `<div class="goal">${escapeHtml(clipWords(goal || '(no goal recorded)'))}</div>`;
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

/** How many PRs are open: each has its own Needs you line (see `prSessionOf`), which shows its row. */
function pullRequestsSection(view: OverviewView): string {
  const open = openPrs(view).size;
  return section(
    'Open pull requests',
    hint(open === 0 ? 'No PR waits to land.' : `${open} open, each listed under Needs you.`),
  );
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

/** The count planned and the first few tasks, each with its launch; the rest are the Tasks sheet's. */
function plannedSection(snapshot: DashboardSnapshot, tasksHref: string): string {
  const { backlog } = snapshot;
  if (backlog.length === 0) return section('Planned', hint('Nothing planned.'));
  const rows = backlog
    .slice(0, PLANNED_SHOWN)
    .map(
      (task) =>
        `<li class="session"><div class="meta"><span class="sid">${escapeHtml(task.id)}</span>` +
        `${task.origin === 'human' ? '' : `<span class="branch">from ${escapeHtml(task.origin)}</span>`}</div>` +
        goalLine(task.goal) +
        `${actionButton('launch', { task: task.id }, 'Launch')}</li>`,
    );
  const lead = `<p class="lead">${backlog.length} planned · <a href="${escapeHtml(tasksHref)}">show all on the Tasks sheet →</a></p>`;
  return section('Planned', `${lead}<ul class="rows inline">${rows.join('')}</ul>`);
}
