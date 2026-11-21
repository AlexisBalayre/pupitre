import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import { LADDERS } from '../claude/constants/model-ladder.constants.js';
import { ConfigDirRefusedError } from '../claude/errors/session-runtime.errors.js';
import {
  attachCommand,
  claudeUserDir,
  conductorName,
  transcriptDir,
} from '../claude/session-runtime.service.js';
import { latestContextTokens } from '../claude/transcript.service.js';
import { conductorBlock, isConductorRunning, openConductorQuestion } from './conductor.service.js';
import { PR_URL } from './constants/dashboard.constants.js';
import { COMMIT_SHA } from './constants/merge-gate.constants.js';
import { SESSION_ID_PATTERN } from './constants/paths.constants.js';
import { eventDetail } from './dashboard-events.utils.js';
import type { ClimbReason } from './enums/climb-reason.enums.js';
import { EventType } from './enums/event-type.enums.js';
import { GateStageStatus } from './enums/gate-stage-status.enums.js';
import { InterruptSignal } from './enums/interrupt-signal.enums.js';
import { MergeStatus } from './enums/merge-status.enums.js';
import { SessionActivityKind } from './enums/session-activity-kind.enums.js';
import { runGit } from './git-diff.client.js';
import { listLedgerEntries, listOverdueLedgerEntries } from './ledger.repository.js';
import { getWatcherBeat, listOverlaps } from './overlap.repository.js';
import { WATCH_STALE_AFTER_MS } from './overlap.service.js';
import { projectId, projectPaths } from './paths.utils.js';
import {
  MAX_AUTO_COMPACT_WINDOW_TOKENS,
  MIN_AUTO_COMPACT_WINDOW_TOKENS,
} from './project-config.config.js';
import { asStringArray, displayStages, parseJsonOr, toIsoUtc } from './report-data.utils.js';
import {
  asTier,
  climbFrom,
  FINDING_CLASSES,
  fixRoundWindow,
  taskTier,
  windowFailure,
} from './routing.utils.js';
import {
  decodeEvent,
  getProject,
  listBacklogTasks,
  listEvents,
  listSessions,
  listTasks,
  openQuestion,
  taskSpecForDisplay,
} from './session.repository.js';
import {
  classifySessionActivity,
  formatStaleAge,
  isSessionStalled,
} from './session-activity.utils.js';
import { taskRescopes } from './task-rescope.service.js';
import type {
  CiReviewLookup,
  DashboardBaseline,
  DashboardDeadTurn,
  DashboardEvent,
  DashboardGate,
  DashboardNeed,
  DashboardQuestion,
  DashboardRoute,
  DashboardSession,
  DashboardSnapshot,
  DashboardSteer,
  FleetSummary,
  StalledSession,
} from './types/dashboard.types.js';
import type { DebtBaseline, ProjectBaseline } from './types/init.types.js';
import type { ProjectPaths } from './types/paths.types.js';
import type {
  EventRow,
  QuestionEvent,
  SessionRow,
  SessionState,
  TaskRow,
} from './types/session.types.js';
import type { SessionEvent } from './types/session-event.types.js';

/**
 * One reading of the project for every surface that shows it: `pup status`
 * prints from this, and `pup ui` draws from it. Built in one place because the
 * two must never disagree about what is running — the terminal list and the
 * dashboard reading the same store through different queries is how a session
 * ends up STALLED on one and fine on the other.
 *
 * `now` is passed in rather than read here so a test can put the clock where it
 * needs it; the stall rule and the radar's staleness are both ages.
 */
export function buildDashboardSnapshot(
  db: Database,
  repoPath: string,
  now: number,
): DashboardSnapshot {
  const pid = projectId(repoPath);
  const paths = projectPaths(repoPath);
  const tasks = new Map(listTasks(db, pid).map((task) => [task.id, task]));
  const stalls = new Map(findStalledSessions(db, repoPath, now).map((stall) => [stall.id, stall]));
  const isLanded = landedShaLookup(repoPath);
  const claudeDir = windowsClaudeDir(repoPath);
  const rows = listSessions(db);
  // Oldest first, so each task maps to its newest session: the one a relaunch climbs from.
  const newestOfTask = new Map(rows.map((row) => [row.task_id, row.id]));
  const sessions = rows.map((row) => {
    const task = tasks.get(row.task_id);
    const newest = newestOfTask.get(row.task_id) === row.id;
    return dashboardSession(
      db,
      row,
      task,
      eventsFileOf(paths, row.id),
      settingsFileOf(paths, row.id),
      stalls.get(row.id),
      isLanded,
      newest ? topRungFailure(db, paths, row, task, now) : undefined,
      claudeDir,
      (newestFirst) => committedFixRound(newestFirst, row, repoPath, now),
    );
  });
  const beat = getWatcherBeat(db, pid);
  const baseline = baselineOf(db, pid);
  const conductorRunning = isConductorRunning(repoPath);
  // Like a session's: a question only the running conductor can be answered
  // on, and only one its run sealed, the one `pup answer conductor` relays.
  const conductorAsked = conductorRunning
    ? dashboardQuestion(openConductorQuestion(db, repoPath))
    : undefined;
  const blocked = conductorRunning ? conductorBlock(repoPath, now) : undefined;
  return {
    projectId: pid,
    repoPath,
    ...(baseline ? { baseline } : {}),
    conductor: {
      running: conductorRunning,
      name: conductorName(pid),
      attachCommand: attachCommand({ conductorOf: pid }),
      ...(conductorAsked ? { question: conductorAsked } : {}),
      ...(blocked ? { blocked } : {}),
    },
    // `listSessions` returns oldest first and `sort` is stable, so the tie
    // between two sessions that both need a human stays in creation order.
    sessions: sessions.sort((a, b) => sortRank(b) - sortRank(a)),
    backlog: listBacklogTasks(db, pid).map((task) => {
      const spec = taskSpecForDisplay(task);
      return {
        // The store is not always the caller's own since the fleet views
        // (decisions 60, 61), and `pup ui` draws the backlog and the radar,
        // which the fleet `pup status` does not (the ledger it draws too,
        // unsanitized until now): every id is scrubbed like the session row's.
        id: sanitizeReason(task.id),
        goal: goalHeadline(spec.goal),
        scope: asStringArray(spec.scopeIn).map(sanitizeReason),
        acceptance: asStringArray(spec.acceptance).map(sanitizeReason),
        origin: sanitizeReason(task.origin),
      };
    }),
    overdueDebt: listOverdueLedgerEntries(db, pid, new Date(now)).map((entry) => ({
      // Integer by the schema pup lays down, but a planted store can have
      // created `ledger_entries` with a TEXT id first, so affinity is no pin.
      id: sanitizeReason(String(entry.id)),
      description: sanitizeReason(entry.description),
      reviewBy: sanitizeReason(entry.review_by),
    })),
    openDebtCount: listLedgerEntries(db, pid).length,
    overlaps: listOverlaps(db).map((pair) => ({
      sessionA: sanitizeReason(pair.sessionA),
      sessionB: sanitizeReason(pair.sessionB),
      files: pair.files.map(sanitizeReason),
    })),
    radarStale: !beat || now - beat.getTime() > WATCH_STALE_AFTER_MS,
  };
}

/**
 * A project folded to what the operator has to act on (decision 60): the
 * sessions the needs-you inbox names, in its order (decision 83), beside the
 * counts. Awaiting-input is not among them, because a permission ask answers
 * itself or turns into a stall within minutes, and the fleet is read across
 * projects rather than watched.
 */
export function fleetSummary(snapshot: DashboardSnapshot): FleetSummary {
  const count = (state: DashboardSession['state']): number =>
    snapshot.sessions.filter((session) => session.state === state).length;
  return {
    needsYou: needsYou(snapshot),
    running: count('running'),
    planned: snapshot.backlog.length,
    merged: count('merged'),
  };
}

/**
 * How many stored events a session row carries: enough for the detail pane to
 * say what happened to the session last, and the part of its history an
 * operator deciding what to do next reads. `pup report` is where the rest is.
 */
const RECENT_EVENT_COUNT = 5;

/**
 * The events file a session row names, or nothing when its id fails
 * `SESSION_ID_PATTERN`. Both readers here sweep every row of every registered
 * store, so a bad id must cost the sweep nothing: the row reads as one with no
 * events file — no activity, never stalled, no filesystem touched — and still
 * renders, id sanitized, for the operator who has to clean it up (decision 66).
 */
function eventsFileOf(paths: ProjectPaths, sessionId: string): string | undefined {
  return SESSION_ID_PATTERN.test(sessionId) ? paths.eventsFile(sessionId) : undefined;
}

/** The settings a session's window was compiled with, for a minted id only, like its events file. */
function settingsFileOf(paths: ProjectPaths, sessionId: string): string | undefined {
  return SESSION_ID_PATTERN.test(sessionId)
    ? join(paths.compiledDir(sessionId), 'settings.json')
    : undefined;
}

/**
 * The config dir this project's windows write their transcripts under
 * (decision 106), or nothing when the one `--session-env` names is refused:
 * no window can have opened on it, and a dir another user could swap is not
 * one to read from either.
 */
function windowsClaudeDir(repoPath: string): string | undefined {
  try {
    return claudeUserDir(repoPath);
  } catch (error) {
    if (error instanceof ConfigDirRefusedError) return undefined;
    throw error;
  }
}

/**
 * The transcript directory a session row names, or nothing when it is not pup's own.
 *
 * `sessions.transcript_path` is stamped at launch as `transcriptDir(worktree,
 * claudeDir)`,
 * but it is read back out of a store the sessions write and every registered
 * store is swept here, so the column is checked against the derivation rather
 * than followed: a row that does not match reads as one with no transcript —
 * context unknown, no directory listed, no file opened — exactly as a row whose
 * column is null already does. `worktree_path` is session-writable too, so this
 * is only a guard because `transcriptDir` munges every non-alphanumeric
 * character away: whatever the column holds, the derivation is one segment
 * directly under `<claudeDir>/projects` — except for the empty string, which
 * `join` drops, leaving the projects root itself, so it is refused before the
 * derivation is taken (decision 67).
 */
function transcriptDirOf(
  worktreePath: string,
  transcriptPath: string | null,
  claudeDir: string | undefined,
): string | undefined {
  if (!worktreePath || claudeDir === undefined) return undefined;
  const expected = transcriptDir(worktreePath, claudeDir);
  return transcriptPath === expected ? expected : undefined;
}

/**
 * Running sessions whose events file has gone quiet past `STALLED_AFTER_MS`
 * (decision 35). Lives beside the snapshot that reports it because `pup watch`
 * asks the same question on its own sweep, where there is no snapshot to build.
 */
export function findStalledSessions(db: Database, repoPath: string, now: number): StalledSession[] {
  const paths = projectPaths(repoPath);
  const stalled: StalledSession[] = [];
  for (const row of listSessions(db, ['running'])) {
    const eventsFile = eventsFileOf(paths, row.id);
    if (!eventsFile || !existsSync(eventsFile)) continue;
    const mtimeMs = statSync(eventsFile).mtimeMs;
    const ageMs = now - mtimeMs;
    if (isSessionStalled(ageMs))
      stalled.push({ id: row.id, ageMs, stalledAt: new Date(mtimeMs).toISOString() });
  }
  return stalled;
}

/**
 * What a session's newest window ran into, which decides the climb at its next
 * relaunch or respawn (decision 92): the failures its events record since the
 * window opened, or a stall when its events file had been quiet past the stall
 * bar (decision 35) by the time the window ended, at its kill or, for one still
 * up, `now`. Like the stall rule, only a window that was running then can have
 * stalled; one killed while awaiting review had only finished. A CI fix
 * round's retry reads its events with `fixRoundFailure` as `read`: that kill is
 * a `running` -> `merged` edge, not a `killed` session, and stalls the same.
 */
export function windowFailureOf(
  db: Database,
  paths: ProjectPaths,
  session: SessionRow,
  now: number,
  read: (
    events: SessionEvent[],
    stalledAtEnd: boolean,
  ) => ClimbReason | 'blocked' | undefined = windowFailure,
): ClimbReason | 'blocked' | undefined {
  const rows = listEvents(db, session.id);
  const events = rows.map(decodeEvent);
  return read(events, windowStalled(paths, session, rows, events, now));
}

/**
 * Whether the session's newest window was stalled when it ended: at `now` for
 * one still running, at the kill for a killed session or a fix round killed
 * back to `merged`, when that kill came after the newest respawn. The events
 * file is per session, not per window: until the new window's first hook, its
 * mtime is the last window's, so the newest respawn bounds it.
 */
function windowStalled(
  paths: ProjectPaths,
  session: SessionRow,
  rows: EventRow[],
  events: SessionEvent[],
  now: number,
): boolean {
  let windowFrom = events
    .map((event) => event.type === 'other' && event.eventType)
    .lastIndexOf(EventType.Respawn);
  let endedAt = now;
  let running = session.state === 'running';
  if (session.state === 'killed') {
    const at = events
      .map((event) => event.type === 'gate_result' && event.to)
      .lastIndexOf('killed');
    const kill = events[at];
    endedAt = Date.parse(toIsoUtc(rows[at]?.created_at ?? ''));
    running = kill?.type === 'gate_result' && kill.from === 'running';
  } else if (session.state === 'merged') {
    // The window `fixRoundFailure` scores, ended by the first kill back to
    // `merged` before another round is handed: a later undone retry's kill is
    // not its end.
    const round = fixRoundWindow(events);
    windowFrom = round.openedAt < 0 ? -1 : round.scoredFrom;
    const at = events.findIndex(
      (event, i) =>
        i > windowFrom &&
        event.type === 'gate_result' &&
        event.from === 'running' &&
        event.to === 'merged',
    );
    const handedAt = events.findIndex(
      (event, i) =>
        i > windowFrom && event.type === 'other' && event.eventType === EventType.FixRound,
    );
    running = windowFrom >= 0 && at >= 0 && (handedAt < 0 || at < handedAt);
    endedAt = Date.parse(toIsoUtc(rows[at]?.created_at ?? ''));
  }
  const windowStart =
    windowFrom < 0 ? 0 : Date.parse(toIsoUtc(rows[windowFrom]?.created_at ?? '')) || 0;
  const eventsFile = eventsFileOf(paths, session.id);
  return (
    running &&
    eventsFile !== undefined &&
    existsSync(eventsFile) &&
    isSessionStalled(endedAt - Math.max(statSync(eventsFile).mtimeMs, windowStart))
  );
}

/**
 * What a killed session's window ran into on the top rung of its task's
 * ladder, when the session is the newest of a task still in the store and not
 * dropped: the task's relaunch would be refused (decision 92), so it waits on
 * the operator. A dropped task has no relaunch to refuse (decision 147).
 */
function topRungFailure(
  db: Database,
  paths: ProjectPaths,
  row: SessionRow,
  task: TaskRow | undefined,
  now: number,
): ClimbReason | undefined {
  if (row.state !== 'killed' || !task || task.dropped_at !== null) return undefined;
  const tier = taskTier(task.tier, asStringArray(taskSpecForDisplay(task).scopeIn));
  return climbFrom(tier, row, windowFailureOf(db, paths, row, now)).topReached;
}

/**
 * The route a session row records, scrubbed for the screen, or nothing when
 * the session launched before routing or its columns do not read back as a
 * tier and a rung.
 */
function dashboardRoute(
  row: SessionRow,
  topReached: string | undefined,
): DashboardRoute | undefined {
  const tier = asTier(row.tier);
  if (!tier || !Number.isSafeInteger(row.rung) || row.model === null || row.effort === null) {
    return undefined;
  }
  const rungs = LADDERS[tier].length;
  return {
    tier,
    model: sanitizeReason(row.model),
    effort: sanitizeReason(row.effort),
    rung: Math.min(Math.max(row.rung as number, 0), rungs - 1) + 1,
    rungs,
    ...(row.rung_reason === null ? {} : { reason: sanitizeReason(row.rung_reason) }),
    override: row.route_override === 1,
    ...(topReached === undefined ? {} : { topReached }),
  };
}

/**
 * A session's route in one line, for `pup status`, `pup ui` and the web
 * dashboard alike: model and effort, the rung out of the ladder's, and why it
 * last climbed (decision 92), then who started the fix round the session is
 * in and the finding that took it past the top rung, if one did (decision 202).
 */
export function routeLabel(session: DashboardSession): string {
  const route = session.route;
  const round = session.fixRound;
  const roundText = round
    ? `fix round by the ${round.startedBy}` +
      (round.finding ? `, past the top rung for a ${round.finding} finding` : '')
    : '';
  if (!route) return roundText;
  const climbed = route.reason ? ` after ${route.reason}` : '';
  const override = route.override ? ' (override)' : '';
  const rung = `${route.model} ${route.effort}, rung ${route.rung}/${route.rungs}${climbed}${override}`;
  return roundText ? `${rung}; ${roundText}` : rung;
}

/**
 * One terminal-safe line of a task's goal. Goals are multi-line prose an agent
 * or the operator wrote, so only the first line is a headline, and only after
 * decision 29's sanitizing. Fitting it to a column is the reader's job: the
 * width belongs to the surface, not to the reading.
 */
export function goalHeadline(goal: string | undefined): string {
  return sanitizeReason((goal ?? '').split('\n')[0] ?? '');
}

/**
 * How far up the list a session sorts: an open question first, since it idles
 * a worker that waits on the operator's one keystroke (decision 93), then a
 * session that has stopped for good. Deliberately narrower than `needsHuman`,
 * which also counts awaiting-input — hoisting a five-second permission ask
 * above a blocked session would bury the row the operator actually has to act on.
 */
function sortRank(session: DashboardSession): number {
  if (session.question !== undefined) return 2;
  return session.state === 'blocked' || session.stalledAgeMs !== undefined ? 1 : 0;
}

/**
 * The inbox's order (decision 83): what only the operator can answer, by what
 * leaving it costs — a question idles a worker that has said why, a block or a
 * stall one that has stopped, a review and an open PR only hold finished work
 * back. A conductor out of reach comes right after the questions: while it
 * sits there no worker's notice lands, so every finished session waits on it
 * (decision 168).
 */
const NEED_ORDER: DashboardNeed['kind'][] = [
  'question',
  'conductor',
  'blocked',
  'top-rung',
  'stalled',
  'awaiting-review',
  'fix-committed',
  'pr-open',
];

/** `N open thread(s)`, as the inbox, `pup fix` and the round's kickoff count them. */
export function openThreadCount(count: number): string {
  return `${count} open thread${count === 1 ? '' : 's'}`;
}

/**
 * The needs-you inbox (decision 83), read off a snapshot like `fleetSummary`
 * so `pup status`, the fleet view and the conductor that reads `pup status`
 * cannot disagree about which kind of need waits on the operator, nor in what
 * order. One line per session, its first reason in `NEED_ORDER`; within a
 * kind, the snapshot's own row order. `ciReview` is GitHub's answer for an
 * open PR, asked only by `pup status`, the one reader that may wait on gh, so
 * the CI line appears there alone; without it, or without an answer, an open
 * PR keeps its plain line. While the project's conductor runs, a session
 * awaiting review is the conductor's to gate, not the operator's, unless its
 * gate was refused: accepting flagged debt takes a human (decision 102).
 */
export function needsYou(snapshot: DashboardSnapshot, ciReview?: CiReviewLookup): DashboardNeed[] {
  const gating = snapshot.conductor.running;
  const asked = snapshot.conductor.question;
  // The conductor's own question leads its kind: it holds the whole fleet.
  const conductor: DashboardNeed[] = asked
    ? [
        {
          kind: 'question',
          sessionId: CONDUCTOR_TARGET,
          label: CONDUCTOR_TARGET,
          reason: questionReason(asked),
          answer: answerCommand(CONDUCTOR_TARGET, asked),
          ...questionNeed(asked),
        },
      ]
    : [];
  // A finished fix round holds the merge lock's next turn, so the longest
  // waiting goes first; every other kind keeps the snapshot's row order.
  // `sort` is stable, every other row weighs 0, and a row with a committed fix
  // round has no other line (see `committedFixRound`).
  const waited = (session: DashboardSession): number => session.fixCommitted?.ageMs ?? 0;
  const sessionNeeds = [...snapshot.sessions]
    .sort((a, b) => waited(b) - waited(a))
    .flatMap((session) => needOf(session, gating, ciReview) ?? []);
  const needs = [...conductor, ...conductorNeed(snapshot.conductor), ...sessionNeeds];
  return NEED_ORDER.flatMap((kind) => needs.filter((need) => need.kind === kind));
}

/**
 * The conductor no tell reaches (decision 168), answered with the attach line:
 * the draft may be the operator's own and the overlay takes keys as choices,
 * so pup sends nothing and only the operator, attached, can clear either.
 */
function conductorNeed(conductor: DashboardSnapshot['conductor']): DashboardNeed[] {
  const { blocked } = conductor;
  if (!blocked) return [];
  const fix = blocked.reason === 'unsent draft' ? 'send or clear it' : 'return it to its prompt';
  return [
    {
      kind: 'conductor',
      sessionId: conductor.name,
      label: 'conductor',
      reason: `blocked: ${blocked.reason} (${formatStaleAge(blocked.ageMs)}), no notice reaches it; ${fix}`,
      answer: conductor.attachCommand,
    },
  ];
}

/**
 * Symbols a stored text could pass off as the inbox's own `→`: every arrow
 * and emoji is a non-ASCII math or other symbol. ASCII `+ < = > | ~` stay,
 * since a question about code needs them and `+` turned into `-` would say
 * the opposite.
 */
const SYMBOLS = /(?![\0-\x7F])[\p{Sm}\p{So}]/gu;
const UNMINTED_ID = '(session id outside the minted shape; inspect the store)';

/** What `pup answer` takes for the conductor's question, and how the inbox labels it. */
export const CONDUCTOR_TARGET = 'conductor';

/** The question as the inbox reads it, its event id first: the id an answer names. */
function questionReason(question: DashboardQuestion): string {
  return `question #${question.id}: ${question.text.replace(SYMBOLS, '-')}`;
}

/**
 * The command that answers a question (decision 93): a number with options,
 * words always, each bound to the question read by its event id.
 */
function answerCommand(target: string, question: DashboardQuestion): string {
  const answer = (reply: string): string =>
    `pup answer ${target} ${reply} --question ${question.id}`;
  const words = answer('"..."');
  return question.options.length > 0 ? `${answer('<n>')}, or ${words}` : words;
}

/**
 * A question line's event id, for an answer to name, and its options for the
 * inbox to number, their arrows not the line's (decision 29).
 */
function questionNeed(
  question: DashboardQuestion,
): Pick<DashboardNeed, 'questionId' | 'options' | 'recommended'> {
  if (question.options.length === 0) return { questionId: question.id };
  const { recommended } = question;
  return {
    questionId: question.id,
    options: question.options.map((option) => option.replace(SYMBOLS, '-')),
    ...(recommended === undefined ? {} : { recommended }),
  };
}

/** The lines that ask for a merge, which the operator judges against the gated scope. */
const MERGE_KINDS: DashboardNeed['kind'][] = ['awaiting-review', 'fix-committed', 'pr-open'];

function needOf(
  session: DashboardSession,
  gating: boolean,
  ciReview?: CiReviewLookup,
): DashboardNeed | undefined {
  const { id } = session;
  const widened = widenedClause(session.rescoped);
  const need = (kind: DashboardNeed['kind'], reason: string, answer: string): DashboardNeed => ({
    kind,
    sessionId: id,
    label: session.isMintedId ? id : UNMINTED_ID,
    // The merge is the operator's to judge against the scope it was gated
    // on, which is wider than the plan they approved (decision 188).
    reason: MERGE_KINDS.includes(kind) ? `${reason}${widened}` : reason,
    answer,
  });
  // The answer is what the conductor acts on, and the session row is
  // session-writable: an id outside the minted shape neither prints nor gets
  // a command built around it, and a question's arrows are not the line's
  // (decision 29).
  const command = (text: string): string => (session.isMintedId ? text : UNMINTED_ID);
  if (session.question !== undefined) {
    const asked = session.question;
    return {
      ...need('question', questionReason(asked), command(answerCommand(id, asked))),
      ...questionNeed(asked),
    };
  }
  if (session.state === 'blocked') {
    return need(
      'blocked',
      `blocked (${session.rejectCount} rejections)`,
      command(`pup unblock ${id}`),
    );
  }
  const topReached = session.route?.topReached;
  if (topReached !== undefined && session.route) {
    // The task id is session-writable too, and the answer is a command.
    const task = SESSION_ID_PATTERN.test(session.taskId) ? session.taskId : undefined;
    return need(
      'top-rung',
      `top rung: ${topReached} on ${session.route.model} ${session.route.effort}`,
      task
        ? command(`re-plan ${task}, or pup launch ${task} --model <model> --effort <effort>`)
        : '(task id outside the minted shape; inspect the store)',
    );
  }
  if (session.stalledAgeMs !== undefined) {
    return need(
      'stalled',
      stallReason(session, session.stalledAgeMs),
      command(`pup steer ${id} "..."`),
    );
  }
  // A stage that failed refused the gate before any debt was weighed, such as
  // a taken ADR number (decision 146): only the session's fix gets it through.
  const failedStage = session.gateRefused ? session.lastGate?.failedStage : undefined;
  if (session.state === 'awaiting-review' && failedStage !== undefined) {
    return need(
      'awaiting-review',
      `gate refused: ${failedStage} failed`,
      command(`pup steer ${id} "..."`),
    );
  }
  if (session.state === 'awaiting-review' && session.gateRefused) {
    return need(
      'awaiting-review',
      'gate refused on flagged debt',
      command(
        `pup merge ${id} --pr --accept-debt "<reason>" --review-by "<condition>", ` +
          `or pup steer ${id} "..."`,
      ),
    );
  }
  // Shown while the conductor runs too: a conductor that compacted has lost
  // the round, and the merge lock sits idle until someone re-gates it. The
  // worker's own summary stays out: the conductor acts on this line, and a
  // scrub leaves another session's command readable (`pup review` shows it).
  if (session.fixCommitted !== undefined) {
    return need(
      'fix-committed',
      `fix committed ${formatStaleAge(session.fixCommitted.ageMs)} ago, awaiting re-gate`,
      command(`pup merge ${id} --pr`),
    );
  }
  if (session.state === 'awaiting-review' && !gating) {
    return need(
      'awaiting-review',
      'awaiting review',
      command(`pup review ${id} then pup merge ${id} --pr`),
    );
  }
  if (session.openPr !== undefined) {
    const { url } = session.openPr;
    // Asked only where the answer can be acted on: `pup fix` takes a minted id
    // and gh a pull-request url.
    const review = url !== undefined && session.isMintedId ? ciReview?.(session) : undefined;
    if (review !== undefined && review.openThreads > 0) {
      return need(
        'pr-open',
        `CI review left ${openThreadCount(review.openThreads)} on its head`,
        command(`pup fix ${id}`),
      );
    }
    return need(
      'pr-open',
      review === undefined
        ? 'PR opened, not landed'
        : 'CI review status reads clean on its head (any repo workflow can set it): ' +
            'read the PR, then your merge click',
      url ?? '(PR url outside the pull-request shape; inspect the store)',
    );
  }
  return undefined;
}

/** The inbox shows this many of the globs a rescope added, then counts the rest. */
const WIDENED_GLOBS_SHOWN = 3;

/**
 * What a merge line adds for a claim widened after launch; empty for none. The
 * globs come off session-writable events, so their arrows are not the line's
 * (decision 29).
 */
function widenedClause(rescoped: string[] | undefined): string {
  if (rescoped === undefined || rescoped.length === 0) return '';
  const shown = rescoped
    .slice(0, WIDENED_GLOBS_SHOWN)
    .map((glob) => `+${glob.replace(SYMBOLS, '-')}`);
  const rest = rescoped.length - shown.length;
  return `; scope widened after launch: ${shown.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

/**
 * A stall in the words the session row gives it, so the inbox and the table
 * below it never describe one stall two ways (decision 52): the age, or what
 * the watchdog did about a dead turn (addendum to decision 35).
 */
function stallReason(session: DashboardSession, stalledAgeMs: number): string {
  const died = session.deadTurn;
  if (!died) return `STALLED (${formatStaleAge(stalledAgeMs)})`;
  const at = new Date(died.at).toTimeString().slice(0, 5);
  return died.refusal
    ? `TURN DIED (API error) — resume refused at ${at}, needs a human`
    : `TURN DIED (API error) — resumed by watch at ${at}`;
}

/**
 * A target git can read as a branch name and nothing else — no leading `-`, no
 * `..` or `@{`, none of `^ ~ : ? * [ =` or a backslash, no blank, control or format
 * character — what `assertTargetName` refuses at the gate, checked here
 * without git because the name is about to be handed to git.
 */
const PLAIN_BRANCH = /^(?!-)(?!.*\.\.)(?!.*@\{)[^\s~^:?*[\\=\p{Cc}\p{Cf}]+$/u;
/** The render loop is behind this call: a deep or planted history must not hold it. */
const LANDED_CHECK_TIMEOUT_MS = 2_000;
/**
 * Every transport git ships, pinned off for the walk: `protocol.allow` alone is
 * only the fallback, and a local `protocol.<name>.allow` overrides it.
 */
const NO_TRANSPORT = ['ext', 'fd', 'file', 'git', 'http', 'https', 'ssh'].flatMap((name) => [
  '-c',
  `protocol.${name}.allow=never`,
]);
/**
 * What git answered about a (repo, target, sha), kept across snapshots: an
 * ancestor stays one, so `landed` is final; `open` holds until the target's
 * tip moves, since only a new commit on it can change the answer. A timeout
 * is neither and is asked again.
 */
const LANDING_CACHE = new Map<string, { landed: true } | { landed: false; tip: string }>();
/**
 * Cleared whole once it holds this many answers: a `pup ui` that runs for days
 * over a fleet must not grow it without bound, and re-asking a few thousand
 * walks once is cheaper than evicting by age.
 */
const LANDING_CACHE_LIMIT = 4_096;

/**
 * Whether the target branch of this checkout already holds the commit a merge
 * pinned: the one thing the snapshot asks git, because the store cannot know
 * what the operator's pull did (decision 83). One `rev-list --missing=print`
 * per open PR, which walks without fetching what it meets and names what it
 * lacks. The shared config can name a promisor remote whose fetch would run a
 * planted command with pup's environment (decision 82's reasoning, outside the
 * gate), so the walk runs with every transport pinned off and
 * `GIT_NO_LAZY_FETCH` set, and the tip is read under the same pins without
 * peeling, since peeling parses the object. The answers are cached across
 * snapshots so the work follows the PRs
 * still open, not the refreshes. A merge recorded before the sha was kept
 * (decision 80) predates every PR still open and counts as landed. Everything
 * else fails toward "still open": a target or sha outside its shape is not
 * asked about, and a missing object, a timeout and a repo with no such branch
 * all keep the PR listed.
 */
function landedShaLookup(
  repoPath: string,
): (target: string | undefined, sha: string | undefined) => boolean {
  const tips = new Map<string, string | undefined>();
  const tipOf = (target: string): string | undefined => {
    if (!tips.has(target)) {
      try {
        tips.set(
          target,
          runGit(
            repoPath,
            [...NO_TRANSPORT, 'rev-parse', '--verify', '--quiet', `refs/heads/${target}`],
            {
              env: { GIT_NO_LAZY_FETCH: '1' },
              stdio: ['ignore', 'pipe', 'ignore'],
              timeout: LANDED_CHECK_TIMEOUT_MS,
            },
          ).trim(),
        );
      } catch {
        tips.set(target, undefined);
      }
    }
    return tips.get(target);
  };
  return (target, sha) => {
    if (sha === undefined) return true;
    if (target === undefined || !PLAIN_BRANCH.test(target) || !COMMIT_SHA.test(sha)) return false;
    const tip = tipOf(target);
    if (tip === undefined) return false;
    const key = `${repoPath}\0${target}\0${sha}`;
    const known = LANDING_CACHE.get(key);
    if (known?.landed) return true;
    if (known && known.tip === tip) return false;
    const answer = ancestry(repoPath, sha, target);
    if (LANDING_CACHE.size >= LANDING_CACHE_LIMIT) LANDING_CACHE.clear();
    if (answer === 'landed') LANDING_CACHE.set(key, { landed: true });
    if (answer === 'open') LANDING_CACHE.set(key, { landed: false, tip });
    return answer === 'landed';
  };
}

/**
 * Empty output means every commit from `sha` is reachable from the target; a
 * commit past the target prints its oid, and a missing one, the pinned commit
 * itself once gc pruned it, prints `?<oid>` rather than reading as reached.
 */
function ancestry(repoPath: string, sha: string, target: string): 'landed' | 'open' | 'unknown' {
  try {
    const past = runGit(
      repoPath,
      [
        ...NO_TRANSPORT,
        'rev-list',
        '--missing=print',
        '--max-count=1',
        sha,
        `^refs/heads/${target}`,
      ],
      {
        env: { GIT_NO_LAZY_FETCH: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: LANDED_CHECK_TIMEOUT_MS,
      },
    );
    return past.trim() === '' ? 'landed' : 'open';
  } catch (error) {
    const timedOut =
      error instanceof Error && 'signal' in error && error.signal === InterruptSignal.Sigterm;
    return timedOut ? 'unknown' : 'open';
  }
}

/**
 * Whether a session branch holds a commit the PR's pinned head does not: the
 * fix round committed and the PR has yet to be re-gated onto it. The same
 * walk as `ancestry`, under the same pins and timeout, the other way round;
 * asked only for awaiting-review sessions whose last fix round ended, so it
 * is not cached. A branch or sha outside its shape, a missing branch or
 * object and a timeout all read as not past: the session keeps the line it
 * had before.
 */
function isBranchPast(repoPath: string, branch: string, sha: string): boolean {
  if (!PLAIN_BRANCH.test(branch) || !COMMIT_SHA.test(sha)) return false;
  try {
    const past = runGit(
      repoPath,
      [...NO_TRANSPORT, 'rev-list', '--max-count=1', `refs/heads/${branch}`, `^${sha}`, '--'],
      {
        env: { GIT_NO_LAZY_FETCH: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: LANDED_CHECK_TIMEOUT_MS,
      },
    );
    return past.trim() !== '';
  } catch {
    return false;
  }
}

/**
 * A file in the session's store directory, its events file or its compiled
 * settings, read as one the session may have replaced (decision 194): no link
 * followed, no fifo blocked on, a regular file with one link only. Undefined
 * when it is absent or is none of those, so one session's planted link costs
 * its row the activity and not the whole project. Any other failure throws as
 * before, and the fleet view lists the project as unreadable.
 */
function readSessionFile(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    return stat.isFile() && stat.nlink === 1 ? readFileSync(fd, 'utf8') : undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * The tokens Claude Code keeps free under `autoCompactWindow`, so a window
 * compacts at the window less this (decision 200, probed on Claude Code 2.1.327).
 */
const AUTOCOMPACT_BUFFER_TOKENS = 33_000;

/**
 * Where a session's window compacts: the `autoCompactWindow` its compiled
 * settings carry, less Claude Code's buffer (decision 200). Undefined for a
 * session compiled before that decision, and for settings that are not JSON or
 * carry a window Claude Code would not take: the file is in a store the
 * sessions can write, so its value is checked rather than printed as found.
 */
function compactionPoint(settingsFile: string): number | undefined {
  const text = readSessionFile(settingsFile);
  if (text === undefined) return undefined;
  let window: unknown;
  try {
    window = (JSON.parse(text) as { autoCompactWindow?: unknown } | null)?.autoCompactWindow;
  } catch {
    return undefined;
  }
  return typeof window === 'number' &&
    Number.isInteger(window) &&
    window >= MIN_AUTO_COMPACT_WINDOW_TOKENS &&
    window <= MAX_AUTO_COMPACT_WINDOW_TOKENS
    ? window - AUTOCOMPACT_BUFFER_TOKENS
    : undefined;
}

function dashboardSession(
  db: Database,
  row: SessionRow,
  task: TaskRow | undefined,
  eventsFile: string | undefined,
  settingsFile: string | undefined,
  stall: StalledSession | undefined,
  isLanded: (target: string | undefined, sha: string | undefined) => boolean,
  topReached: string | undefined,
  claudeDir: string | undefined,
  fixRoundOf: (newestFirst: EventRow[]) => DashboardSession['fixCommitted'],
): DashboardSession {
  const spec = taskSpecForDisplay(task);
  // Decision 2: hook events, never pane contents. Nothing to classify for a
  // session that is not running, or has yet to fire a hook.
  const eventsText =
    row.state === 'running' && eventsFile !== undefined ? readSessionFile(eventsFile) : undefined;
  const activity = eventsText === undefined ? undefined : classifySessionActivity(eventsText);
  const stalledAgeMs = stall?.ageMs;
  // Only a running session has a context window to fill; a merged one's last
  // transcript is history, and reading it is I/O per row for nothing.
  const transcripts = transcriptDirOf(row.worktree_path, row.transcript_path, claudeDir);
  const contextTokens =
    row.state === 'running' && transcripts ? latestContextTokens(transcripts) : undefined;
  const compactAtTokens =
    contextTokens !== undefined && settingsFile !== undefined
      ? compactionPoint(settingsFile)
      : undefined;
  // Newest first, so `find` returns the latest matching event.
  const events = listEvents(db, row.id).reverse();
  const lastSteer = newestSteer(events);
  // A running session's, or one awaiting review that asked since it reported
  // done, while merging main or fixing what a reviewer sent back. Only those:
  // the inbox lists a session once, under a question first, so an older one
  // must not hide a refused gate or an unblock. Any other state fails closed.
  const asked = ['running', 'awaiting-review'].includes(row.state)
    ? dashboardQuestion(openQuestion(db, row.id))
    : undefined;
  const doneId = events.find((event) => event.type === EventType.SessionDone)?.id ?? Infinity;
  const question =
    row.state === 'awaiting-review' && asked !== undefined && asked.id < doneId ? undefined : asked;
  const pr = row.state === 'merged' ? openPullRequest(events) : undefined;
  const openPr = pr && !isLanded(pr.target, pr.sha) ? { url: pr.url } : undefined;
  const lastGate = newestGate(events);
  const gateRefused = row.state === 'awaiting-review' && newestGateRefused(events);
  // A refused gate's line comes first, and the inbox sorts on this alone.
  const fixCommitted =
    row.state === 'awaiting-review' && !gateRefused ? fixRoundOf(events) : undefined;
  // Only for the stall the session is in now: an hour-old resume belongs to a
  // stall the session has worked its way out of since.
  const deadTurn = stall && newestDeadTurn(events, stall.stalledAt);
  const route = dashboardRoute(row, topReached);
  const fixRound = ['running', 'awaiting-review'].includes(row.state)
    ? roundStarter(events)
    : undefined;
  const rescoped = taskRescopes(db, row.task_id).flatMap((rescope) => rescope.added);
  return {
    // The store is session-writable and, since the fleet view (decision 60),
    // not always the caller's own: all three print as stored, and no CHECK
    // constraint holds `state` to its type, so it is scrubbed like the others.
    id: sanitizeReason(row.id),
    // `conductor` is `pup answer`'s name for the conductor's question (decision
    // 93): a row by that name would print a command that answers the conductor.
    isMintedId: SESSION_ID_PATTERN.test(row.id) && row.id !== CONDUCTOR_TARGET,
    state: sanitizeReason(row.state) as SessionState,
    branch: sanitizeReason(row.branch),
    taskId: row.task_id,
    goal: goalHeadline(spec.goal),
    // The task row is the only record of who asked for the work. It outlives
    // the session, so the join misses only on a store someone has edited by
    // hand — which is a row to render, not a reason to drop the session.
    origin: sanitizeReason(task?.origin ?? 'unknown'),
    scope: asStringArray(spec.scopeIn).map(sanitizeReason),
    ...(rescoped.length > 0 ? { rescoped: rescoped.map(sanitizeReason) } : {}),
    acceptance: asStringArray(spec.acceptance).map(sanitizeReason),
    rejectCount: row.reject_count,
    ...(activity ? { activity } : {}),
    ...(stalledAgeMs === undefined ? {} : { stalledAgeMs }),
    ...(deadTurn ? { deadTurn } : {}),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(compactAtTokens === undefined ? {} : { compactAtTokens }),
    ...(lastSteer ? { lastSteer } : {}),
    ...(question === undefined ? {} : { question }),
    ...(openPr === undefined ? {} : { openPr }),
    ...(fixCommitted === undefined ? {} : { fixCommitted }),
    ...(lastGate ? { lastGate } : {}),
    ...(gateRefused ? { gateRefused } : {}),
    ...(route ? { route } : {}),
    ...(fixRound === undefined ? {} : { fixRound }),
    recentEvents: events.slice(0, RECENT_EVENT_COUNT).reverse().map(dashboardEvent),
    // An open question idles the worker as surely as a block (decision 93).
    needsHuman:
      question !== undefined ||
      row.state === 'blocked' ||
      stalledAgeMs !== undefined ||
      activity?.kind === SessionActivityKind.AwaitingInput,
  };
}

/**
 * The newest dead turn the watchdog recorded against this stall, or nothing —
 * no record, or a record from a stall the session has since worked out of
 * (addendum to decision 35). Read here, off events the store already holds,
 * rather than from the watchdog: the pane the watcher captured is evidence it
 * did not keep, so this is the store telling both surfaces what recovery did,
 * not a second reading of the session. Newest wins, because one stall can be
 * resumed more than once through an outage.
 */
function newestDeadTurn(newestFirst: EventRow[], stalledAt: string): DashboardDeadTurn | undefined {
  for (const row of newestFirst) {
    const event = decodeEvent(row);
    if (event.type !== 'turn_died' || event.stalledAt !== stalledAt) continue;
    return {
      // Sanitized again on the way out, like every other stored text on a row:
      // the error line is the session's own pane (decision 29).
      reason: event.reason === undefined ? '' : sanitizeReason(event.reason),
      at: toIsoUtc(row.created_at),
      ...(event.refusal === undefined ? {} : { refusal: sanitizeReason(event.refusal) }),
    };
  }
  return undefined;
}

/**
 * An open question as the readers print it (decisions 76, 93), or nothing for
 * one whose text scrubs away. Session-written text bound for the operator's
 * terminal, the options too (decision 29); a recommendation that names no
 * option is dropped rather than marking nothing.
 */
function dashboardQuestion(asked: QuestionEvent | undefined): DashboardQuestion | undefined {
  const text = asked?.text === undefined ? '' : sanitizeReason(asked.text);
  if (!asked || !text) return undefined;
  const options = asked.options.map(sanitizeReason);
  const { recommended } = asked;
  const isRecommendedInRange =
    recommended !== undefined && recommended >= 1 && recommended <= options.length;
  return { id: asked.id, text, options, ...(isRecommendedInRange ? { recommended } : {}) };
}

/**
 * The PR the newest merge opened, with the commit it pinned, unless a `landed`
 * or `retired` event came after it (decision 83); `pup retire` closes out a PR
 * closed unmerged. Only the newest merge counts: a session
 * merged twice is described by the merge that stands. A merge with no PR is a
 * local fast-forward, already on the target, so nothing is open. `pup land`
 * writes `landed` once GitHub merged the PR and main holds the pinned sha
 * (decision 84), which also covers a target this checkout has not pulled.
 */
function openPullRequest(
  newestFirst: EventRow[],
): { url: string | undefined; sha: string | undefined; target: string | undefined } | undefined {
  for (const row of newestFirst) {
    if (row.type === EventType.Landed || row.type === EventType.Retired) return undefined;
    const event = decodeEvent(row);
    if (event.type !== 'merge') continue;
    if (event.prUrl === undefined) return undefined;
    // Read back out of a session-writable store and printed as the thing to
    // act on, so a url that is not a pull request's is withheld, not scrubbed:
    // a scrub leaves shell syntax in place (decisions 29, 83).
    const url = sanitizeReason(event.prUrl);
    return { url: PR_URL.test(url) ? url : undefined, sha: event.sha, target: event.target };
  }
  return undefined;
}

/**
 * The CI fix round an awaiting-review session finished and nobody re-gated
 * (decision 90): the newest `fix_round` with a `session_done` after it, no
 * `steer` since that `session_done` (a steer hands the worker more to do, and
 * leaves the state awaiting-review), and no `merge`, `landed` or `retired`
 * since the round, on a PR still open whose pinned head
 * the branch has moved past. Its age runs from the newest such `session_done`,
 * the store's end of the round, so a worktree's clock has no say. A pin or
 * branch outside its shape, and any git failure, read as not past.
 */
function committedFixRound(
  newestFirst: EventRow[],
  session: SessionRow,
  repoPath: string,
  now: number,
): DashboardSession['fixCommitted'] {
  const marks = [EventType.FixRound, EventType.Merge, EventType.Landed, EventType.Retired];
  const at = newestFirst.findIndex((row) => marks.includes(row.type));
  const done = newestFirst
    .slice(0, at)
    .find((row) => row.type === EventType.SessionDone || row.type === EventType.Steer);
  const pin = openPullRequest(newestFirst)?.sha ?? '';
  const isOpenRound =
    newestFirst[at]?.type === EventType.FixRound && done?.type === EventType.SessionDone;
  if (!isOpenRound || !isBranchPast(repoPath, session.branch, pin)) return undefined;
  const endedAt = Date.parse(toIsoUtc(done.created_at));
  return Number.isFinite(endedAt) ? { ageMs: Math.max(0, now - endedAt) } : undefined;
}

/**
 * Who started the CI fix round a session is in, and the finding the conductor
 * named to take it past the top rung (decision 202): read off the newest of its
 * `fix_round`, `merge`, `landed` and `retired` events, when that is a
 * `fix_round`. The store is session-writable, so only a starter and a class
 * pup writes are read back; a round from before that decision recorded none.
 */
function roundStarter(newestFirst: EventRow[]): DashboardSession['fixRound'] {
  const marks = [EventType.FixRound, EventType.Merge, EventType.Landed, EventType.Retired];
  const row = newestFirst.find((event) => marks.includes(event.type));
  if (row?.type !== EventType.FixRound) return undefined;
  const event = decodeEvent(row);
  if (event.type !== 'other') return undefined;
  const { startedBy, finding } = event.fields;
  if (startedBy !== 'operator' && startedBy !== 'conductor') return undefined;
  const named = FINDING_CLASSES.find((known) => known === finding);
  return { startedBy, ...(named === undefined ? {} : { finding: named }) };
}

/**
 * How many fix rounds the open PR of a merged session was re-gated after
 * (decision 86): every `merge` event carrying a PR since the last `landed`
 * one, less the merge that opened it. The store's half of the PR's CI review
 * state; what the bot said is on the PR, which this does not ask GitHub about.
 */
export function prFixRounds(db: Database, sessionId: string): number {
  let merges = 0;
  for (const row of listEvents(db, sessionId).reverse()) {
    if (row.type === EventType.Landed) break;
    const event = decodeEvent(row);
    if (event.type !== 'merge') continue;
    if (event.prUrl === undefined) break;
    merges += 1;
  }
  return Math.max(0, merges - 1);
}

function newestSteer(newestFirst: EventRow[]): DashboardSteer | undefined {
  for (const row of newestFirst) {
    const event = decodeEvent(row);
    if (event.type !== 'steer') continue;
    return {
      ...(event.kind === undefined ? {} : { kind: sanitizeReason(event.kind) }),
      ...(event.by === undefined ? {} : { by: sanitizeReason(event.by) }),
      at: toIsoUtc(row.created_at),
    };
  }
  return undefined;
}

/**
 * Every state transition logs a `gate_result`; only a real gate run carries a
 * report payload, and the ones without it say nothing about passing (same
 * filter as review.service's `lastGateReport`).
 */
function newestGate(newestFirst: EventRow[]): DashboardGate | undefined {
  for (const row of newestFirst) {
    const gate = gateOf(decodeEvent(row), row.created_at);
    if (gate) return gate;
  }
  return undefined;
}

/**
 * Whether the gate's refusal still stands (decision 102): it left the session
 * in awaiting-review, and only a human can accept the debt it flagged. A steer
 * answers it, as it answers a question, and a `session_done` after it is new
 * work to gate; neither moves the state, so neither logs a transition. Any
 * newer `gate_result`, not only a newer report, means the refusal is history.
 */
function newestGateRefused(newestFirst: EventRow[]): boolean {
  for (const row of newestFirst) {
    const event = decodeEvent(row);
    if (event.type === 'steer' || event.type === 'session_done') return false;
    if (event.type === 'gate_result') return event.outcome === MergeStatus.Refused;
  }
  return false;
}

/**
 * The gate run a `gate_result` event reports, or nothing for a bare transition
 * or any other event. The stages go through the report pages' scrub and then
 * decision 29's terminal sanitizing, because a stage detail is a failing test's
 * own output.
 */
function gateOf(event: SessionEvent, createdAt: string): DashboardGate | undefined {
  if (event.type !== 'gate_result' || !event.report) return undefined;
  const stages = displayStages(event.report.stages).map(({ stage, status, detail }) => ({
    stage: sanitizeReason(stage),
    status: sanitizeReason(status),
    ...(detail === null ? {} : { detail: sanitizeReason(detail) }),
  }));
  const failed = stages.find((stage) => stage.status === GateStageStatus.Fail);
  return {
    passed: event.report.passed,
    ...(failed ? { failedStage: failed.stage } : {}),
    stages,
    at: toIsoUtc(createdAt),
  };
}

function dashboardEvent(row: EventRow): DashboardEvent {
  const event = decodeEvent(row);
  const detail = eventDetail(event, gateOf(event, row.created_at));
  return {
    type: sanitizeReason(row.type),
    at: toIsoUtc(row.created_at),
    ...(detail ? { detail } : {}),
  };
}

/**
 * The stored baseline, or nothing. A baseline with no capture time is not a
 * baseline a reader can date, so it degrades to absent rather than to a row
 * claiming figures from no particular moment.
 */
function baselineOf(db: Database, pid: string): DashboardBaseline | undefined {
  const stored = getProject(db, pid)?.baseline;
  if (!stored) return undefined;
  const baseline = parseJsonOr<Partial<ProjectBaseline>>(stored, {});
  if (typeof baseline.capturedAt !== 'string') return undefined;
  return { capturedAt: toIsoUtc(baseline.capturedAt), ...debtFigures(baseline.debt) };
}

/**
 * The figures a stored debt baseline holds, each only when it is a finite
 * number (JSON's `1e999` parses to Infinity), or for unused exports an array: the one reading of a baseline's numbers, so the dashboard's sheets
 * and `pup status` cannot count a capture two ways (decision 98).
 */
export function debtFigures(
  debt: Partial<DebtBaseline> | undefined,
): Omit<DashboardBaseline, 'capturedAt'> {
  return {
    ...(Number.isFinite(debt?.coverageRatio) ? { coverageRatio: debt?.coverageRatio } : {}),
    ...(Number.isFinite(debt?.duplicatedLines) ? { duplicatedLines: debt?.duplicatedLines } : {}),
    ...(Array.isArray(debt?.deadExports) ? { deadExports: debt.deadExports.length } : {}),
  };
}

/**
 * Why the gate parked this session, read back out of the store: the `reason` on
 * the newest `gate_result` that moved it to `blocked` — the reject cap of
 * decision 7, or the re-steer refusal decision 45's addendum records. Newest
 * wins and an older block is never consulted, so a session parked twice is
 * described by the parking that is current. Undefined when the transition
 * carried no reason, which is every block older than those two reasons.
 *
 * Not on the snapshot, and deliberately: it is read when an operator asks to
 * lift a block, not on every two-second redraw of every row. Both surfaces that
 * ask — `pup unblock` and the dashboard's `u` — ask through this, so neither
 * can describe a parking the other would describe differently.
 */
export function blockedReason(db: Database, sessionId: string): string | undefined {
  for (const event of listEvents(db, sessionId).reverse().map(decodeEvent)) {
    if (event.type !== 'gate_result' || event.to !== 'blocked') continue;
    // Sanitized like every other stored text a reader prints: the reason quotes
    // a steer refusal, and the report that refused to land is the session's own
    // output (decision 29).
    return event.reason === undefined ? undefined : sanitizeReason(event.reason);
  }
  return undefined;
}
