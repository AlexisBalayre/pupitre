import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import { barChart, type ChartDatum } from './chart.utils.js';
import { runGit } from './git-diff.client.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { projectId } from './paths.utils.js';
import { asStringArray, displayText, toIsoUtc } from './report-data.utils.js';
import { scopedPaths } from './scope-audit.utils.js';
import {
  decodeEvent,
  type EventRow,
  listBacklogTasks,
  taskSpecForDisplay,
} from './session.repository.js';
import { holdingStates } from './session-state.utils.js';
import {
  DAY_MS,
  escapeHtml,
  hint,
  listSection,
  section,
  textOrPrLink,
  UNMINTED_LABEL,
} from './web-dashboard-sheet.utils.js';

const WEEK_MS = 7 * DAY_MS;
const GATE_WEEKS = 8;
/** Shared files an overlap names before it says how many more there are. */
const OVERLAP_FILES_SHOWN = 3;

/** A live session sharing tracked files with a backlog task, under the gate's own scope rule. */
interface TaskOverlap {
  session: string;
  files: string[];
}

/** One backlog task, every string through `sanitizeReason` and `displayText`. */
interface BacklogTask {
  id: string;
  /** The goal's first sentence. */
  goal: string;
  scope: string[];
  scopeOut: string[];
  overlaps: TaskOverlap[];
}

/** One session that reached a PR, its counts read off its events. */
interface PrSession {
  session: string;
  prUrl: string;
  /** Gate runs that left a report: the first gate, each rejection, each re-gate. */
  gates: number;
  failed: number;
  /** Every steer but the kickoff, which launched it. */
  steers: number;
  respawns: number;
  /** Gate runs after its first `merge` event, on the PR's new head (decision 86). */
  regates: number;
  mergedAt: number;
  /** From launch to its first `merge` event, in ms; NaN when a time does not parse. */
  toMerge: number;
  /** From launch to its first `landed` event, in ms; undefined until `pup land`. */
  toLanded: number | undefined;
}

interface TasksView {
  backlog: BacklogTask[];
  /** Why the overlaps could not be read, when they could not. */
  overlapError?: string;
  sessions: PrSession[];
  /** Each week's share of gate runs that passed, NaN in a week with none. */
  passRate: ChartDatum[];
  runs: { total: number; passed: number };
  /** Gate runs that failed, by each stage that failed or flagged them. */
  failures: ChartDatum[];
}

/** What a session's events add up to, as the read meets them in order. */
interface Tally {
  launchedAt: string;
  gates: number;
  failed: number;
  steers: number;
  respawns: number;
  regates: number;
  mergedAt?: string;
  prUrl?: string;
  landedAt?: string;
}

/** Text from the store, safe to print as one line once escaped (decisions 29, 98). */
const storeText = (text: string): string => displayText(sanitizeReason(text));

const sessionLabel = (id: string): string => (SESSION_ID_PATTERN.test(id) ? id : UNMINTED_LABEL);

/**
 * A goal's first sentence: up to the first `.`, `!` or `?` followed by a blank
 * or the end, the whole goal when there is none. Read off the scrubbed line,
 * so a sentence never spans what was a line break, and found by a scan that
 * cannot backtrack.
 */
export function firstSentence(goal: string): string {
  const end = /[.!?](?=\s|$)/.exec(goal);
  return end === null ? goal : goal.slice(0, end.index + 1);
}

/**
 * The Tasks sheet's reading (decision 166): the backlog in store order with
 * the live sessions each task would share files with; each session that
 * reached a PR with what its events count; and the gate runs of the last
 * eight weeks, by week and by failing stage.
 */
export function readTasksSheet(db: Database, repoPath: string, now: number): TasksView {
  const pid = projectId(repoPath);
  const backlog = listBacklogTasks(db, pid).map((row) => {
    const spec = taskSpecForDisplay(row);
    return {
      id: storeText(row.id),
      goal: firstSentence(storeText(typeof spec.goal === 'string' ? spec.goal : '')),
      scopeIn: asStringArray(spec.scopeIn),
      scopeOut: asStringArray(spec.scopeOut),
    };
  });
  const { overlaps, error } = backlogOverlaps(db, repoPath, pid, backlog);
  const tallies = new Map<string, Tally>();
  const end = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  const weeks = Array.from({ length: GATE_WEEKS }, () => ({ runs: 0, passed: 0 }));
  const failures = new Map<string, number>();

  // One read in insertion order: a re-gate is a gate run after the first
  // merge, and the first merge and land are the first ones met.
  const rows = db
    .prepare(
      `SELECT e.session_id, e.type, e.payload, e.created_at, s.created_at AS launched_at
       FROM events e JOIN sessions s ON s.id = e.session_id JOIN tasks t ON t.id = s.task_id
       WHERE t.project_id = ? AND e.type IN ('gate_result', 'steer', 'respawn', 'merge', 'landed')
       ORDER BY e.id`,
    )
    .all(pid) as (Pick<EventRow, 'type' | 'payload' | 'created_at'> & {
    session_id: string;
    launched_at: string;
  })[];
  for (const row of rows) {
    const tally = tallies.get(row.session_id) ?? {
      launchedAt: row.launched_at,
      gates: 0,
      failed: 0,
      steers: 0,
      respawns: 0,
      regates: 0,
    };
    tallies.set(row.session_id, tally);
    const event = decodeEvent(row);
    if (event.type === 'gate_result') {
      // A bare transition, or a block after a rejection, is not a gate run.
      if (!event.report) continue;
      const { passed, stages } = event.report;
      tally.gates += 1;
      if (!passed) tally.failed += 1;
      if (tally.mergedAt !== undefined) tally.regates += 1;
      const week = Math.floor((end - Date.parse(toIsoUtc(row.created_at))) / WEEK_MS);
      const bucket = weeks[GATE_WEEKS - 1 - week];
      if (bucket === undefined) continue;
      bucket.runs += 1;
      if (passed) bucket.passed += 1;
      else {
        const stopped = stages.filter((s) => s.status === 'fail' || s.status === 'flagged');
        for (const stage of new Set(stopped.map((s) => storeText(s.stage)))) {
          failures.set(stage, (failures.get(stage) ?? 0) + 1);
        }
      }
    } else if (event.type === 'steer') {
      if (event.kind !== 'kickoff') tally.steers += 1;
    } else if (event.type === 'merge') {
      tally.mergedAt ??= row.created_at;
      tally.prUrl ??= event.prUrl;
    } else if (row.type === 'respawn') {
      tally.respawns += 1;
    } else if (row.type === 'landed') {
      tally.landedAt ??= row.created_at;
    }
  }

  return {
    backlog: backlog.map(({ id, goal, scopeIn, scopeOut }, i) => ({
      id,
      goal,
      scope: scopeIn.map(storeText),
      scopeOut: scopeOut.map(storeText),
      overlaps: overlaps[i] ?? [],
    })),
    ...(error === undefined ? {} : { overlapError: error }),
    sessions: prSessions(tallies),
    passRate: weeks.map(({ runs, passed }, i) => ({
      label: new Date(end - (GATE_WEEKS - i) * WEEK_MS).toISOString().slice(5, 10),
      value: runs === 0 ? Number.NaN : passed / runs,
    })),
    runs: weeks.reduce(
      (sum, week) => ({ total: sum.total + week.runs, passed: sum.passed + week.passed }),
      { total: 0, passed: 0 },
    ),
    failures: [...failures]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)),
  };
}

/** Every session whose merge opened a PR, the newest merge first. */
function prSessions(tallies: Map<string, Tally>): PrSession[] {
  const at = (time: string): number => Date.parse(toIsoUtc(time));
  return [...tallies]
    .flatMap(([id, tally]): PrSession[] => {
      if (tally.mergedAt === undefined || tally.prUrl === undefined) return [];
      const launched = at(tally.launchedAt);
      return [
        {
          session: sessionLabel(id),
          prUrl: storeText(tally.prUrl),
          gates: tally.gates,
          failed: tally.failed,
          steers: tally.steers,
          respawns: tally.respawns,
          regates: tally.regates,
          mergedAt: at(tally.mergedAt),
          toMerge: at(tally.mergedAt) - launched,
          toLanded: tally.landedAt === undefined ? undefined : at(tally.landedAt) - launched,
        },
      ];
    })
    .reverse()
    .sort((a, b) => (b.mergedAt || 0) - (a.mergedAt || 0));
}

/**
 * The live sessions each backlog task would share tracked files with, read as
 * a launch reads them (`scopeConflicts`, decision 99): each scope resolved
 * against the tracked files by the gate's own rule. One `git ls-files` per
 * render, and none when there is nothing to compare; a listing git refuses
 * is said once in place of every task's overlaps.
 */
function backlogOverlaps(
  db: Database,
  repoPath: string,
  pid: string,
  backlog: { scopeIn: string[]; scopeOut: string[] }[],
): { overlaps: TaskOverlap[][]; error?: string } {
  const states = holdingStates();
  const live = (
    db
      .prepare(
        `SELECT s.id, t.spec FROM sessions s JOIN tasks t ON t.id = s.task_id
         WHERE t.project_id = ? AND s.state IN (${states.map(() => '?').join(', ')})
         ORDER BY s.created_at, s.rowid`,
      )
      .all(pid, ...states) as { id: string; spec: string }[]
  ).map((row) => {
    const spec = taskSpecForDisplay(row);
    return {
      session: sessionLabel(row.id),
      scopeIn: asStringArray(spec.scopeIn),
      scopeOut: asStringArray(spec.scopeOut),
    };
  });
  if (backlog.length === 0 || live.length === 0) return { overlaps: [] };
  let tracked: string[];
  try {
    tracked = runGit(repoPath, ['ls-files', '-z']).split('\0').filter(Boolean);
  } catch {
    return { overlaps: [], error: 'Overlaps not read: git could not list the tracked files.' };
  }
  const held = live.map(({ session, scopeIn, scopeOut }) => ({
    session,
    files: new Set(scopedPaths(tracked, scopeIn, scopeOut)),
  }));
  return {
    overlaps: backlog.map(({ scopeIn, scopeOut }) => {
      const own = scopedPaths(tracked, scopeIn, scopeOut);
      return held.flatMap(({ session, files }) => {
        const shared = own.filter((file) => files.has(file)).map(storeText);
        return shared.length === 0 ? [] : [{ session, files: shared }];
      });
    }),
  };
}

const pct = (ratio: number): string =>
  Number.isFinite(ratio) ? `${Math.round(ratio * 1000) / 10}%` : 'no run';

/** A span of time in the two largest units that say it: `45m`, `3h 12m`, `2d 4h`. */
function elapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const minutes = Math.floor(ms / 60_000);
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor(minutes / 60) % 24, minutes % 60];
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * The Tasks sheet (decision 166): how the gate has gone over the last eight
 * weeks, the backlog with whom each task would share files, then every session
 * that reached a PR with its gate runs, steers, respawns, re-gates and times.
 */
export function renderTasksSheet(view: TasksView): string {
  return [
    gateSection(view),
    backlogSection(view),
    listSection(
      'Sessions that reached a PR',
      view.sessions,
      'No session has reached a PR yet.',
      sessionTable,
    ),
  ].join('\n');
}

function gateSection({ passRate, runs, failures }: TasksView): string {
  if (runs.total === 0) {
    return section('Gate runs', hint(`No gate run in the last ${GATE_WEEKS} weeks.`));
  }
  return section(
    'Gate runs',
    `<p class="lead">${escapeHtml(
      `Gate runs in the last ${GATE_WEEKS} weeks: ${runs.total}, ${runs.passed} passed.`,
    )}</p>` +
      barChart(passRate, { title: 'Gate pass rate per week, week starting', format: pct }) +
      (failures.length === 0
        ? hint(`No gate run failed at a stage in the last ${GATE_WEEKS} weeks.`)
        : barChart(failures, { title: 'Gate failures per stage', layout: 'rows' })),
  );
}

function backlogSection({ backlog, overlapError }: TasksView): string {
  return listSection('Backlog', backlog, 'Nothing planned — `pup plan` adds a task.', (tasks) => {
    const rows = tasks.map(
      (task) =>
        `<li class="task"><div class="meta"><span class="sid">${escapeHtml(task.id)}</span></div>` +
        `<div class="goal">${escapeHtml(task.goal || '(no goal recorded)')}</div>` +
        `<div class="fact">scope: ${globs(task.scope)}${task.scopeOut.length === 0 ? '' : ` · not ${globs(task.scopeOut)}`}</div>` +
        (overlapError === undefined
          ? `<div class="fact">${escapeHtml(overlapText(task))}</div>`
          : '') +
        '</li>',
    );
    return (
      (overlapError === undefined ? '' : hint(overlapError)) +
      `<ul class="rows">${rows.join('')}</ul>`
    );
  });
}

const globs = (list: string[]): string =>
  list.map((glob) => `<code>${escapeHtml(glob)}</code>`).join(' ');

function overlapText({ overlaps }: BacklogTask): string {
  if (overlaps.length === 0) return 'no overlap with a live session';
  return `overlaps ${overlaps
    .map(({ session, files }) => {
      const more = files.length - OVERLAP_FILES_SHOWN;
      const named = files.slice(0, OVERLAP_FILES_SHOWN).join(', ');
      return `${session} on ${named}${more > 0 ? ` and ${more} more` : ''}`;
    })
    .join('; ')}`;
}

function sessionTable(sessions: PrSession[]): string {
  const rows = sessions.map(
    (s) =>
      `<tr><td><span class="sid">${escapeHtml(s.session)}</span></td><td>${textOrPrLink(s.prUrl)}</td>` +
      `<td>${s.gates} (${s.failed} failed)</td><td>${s.steers}</td><td>${s.respawns}</td><td>${s.regates}</td>` +
      `<td>${escapeHtml(elapsed(s.toMerge))}</td>` +
      `<td>${escapeHtml(s.toLanded === undefined ? 'not landed' : elapsed(s.toLanded))}</td></tr>`,
  );
  return (
    '<table class="moves"><thead><tr><th>Session</th><th>PR</th><th>Gate runs</th><th>Steers</th>' +
    '<th>Respawns</th><th>Re-gates</th><th>Launch to merge</th><th>Launch to landed</th></tr></thead>' +
    `<tbody>${rows.join('')}</tbody></table>`
  );
}
