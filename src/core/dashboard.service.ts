import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import { attachCommand, conductorName, transcriptDir } from '../claude/session-runtime.service.js';
import { latestContextTokens } from '../claude/transcript.service.js';
import { isConductorRunning } from './conductor.service.js';
import { eventDetail } from './dashboard-events.utils.js';
import type { SessionState } from './db.client.js';
import { runGit } from './git-diff.client.js';
import { listLedgerEntries, listOverdueLedgerEntries } from './ledger.repository.js';
import { COMMIT_SHA } from './merge-gate.constants.js';
import { getWatcherBeat, listOverlaps } from './overlap.repository.js';
import { WATCH_STALE_AFTER_MS } from './overlap.service.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { type ProjectPaths, projectId, projectPaths } from './paths.utils.js';
import { asStringArray, displayStages, parseJsonOr, toIsoUtc } from './report-data.utils.js';
import {
  decodeEvent,
  type EventRow,
  getProject,
  listBacklogTasks,
  listEvents,
  listSessions,
  listTasks,
  type SessionRow,
  type TaskRow,
  taskSpecForDisplay,
} from './session.repository.js';
import {
  classifySessionActivity,
  formatStaleAge,
  isSessionStalled,
} from './session-activity.utils.js';
import type {
  DashboardBaseline,
  DashboardDeadTurn,
  DashboardEvent,
  DashboardGate,
  DashboardNeed,
  DashboardSession,
  DashboardSnapshot,
  DashboardSteer,
  FleetSummary,
} from './types/dashboard.types.js';
import type { ProjectBaseline } from './types/init.types.js';
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
  const sessions = listSessions(db).map((row) =>
    dashboardSession(
      db,
      row,
      tasks.get(row.task_id),
      eventsFileOf(paths, row.id),
      stalls.get(row.id),
      isLanded,
    ),
  );
  const beat = getWatcherBeat(db, pid);
  const baseline = baselineOf(db, pid);
  return {
    projectId: pid,
    repoPath,
    ...(baseline ? { baseline } : {}),
    conductor: {
      running: isConductorRunning(repoPath),
      name: conductorName(pid),
      attachCommand: attachCommand({ conductorOf: pid }),
    },
    // `listSessions` returns oldest first and `sort` is stable, so the tie
    // between two sessions that both need a human stays in creation order.
    sessions: sessions.sort((a, b) => Number(sortsFirst(b)) - Number(sortsFirst(a))),
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
 * One stall: how long the session has been quiet, and the name of the stall
 * itself. `stalledAt` is the events file's mtime — the clock decision 35 ages a
 * stall by, which stands still for exactly as long as the session does, so it
 * names *this* quiet spell and no other. The turn watchdog stamps its
 * `turn_died` events with it; both readers match against it.
 */
interface StalledSession {
  id: string;
  ageMs: number;
  stalledAt: string;
}

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

/**
 * The transcript directory a session row names, or nothing when it is not pup's own.
 *
 * `sessions.transcript_path` is stamped at launch as `transcriptDir(worktree)`,
 * but it is read back out of a store the sessions write and every registered
 * store is swept here, so the column is checked against the derivation rather
 * than followed: a row that does not match reads as one with no transcript —
 * context unknown, no directory listed, no file opened — exactly as a row whose
 * column is null already does. `worktree_path` is session-writable too, so this
 * is only a guard because `transcriptDir` munges every non-alphanumeric
 * character away: whatever the column holds, the derivation is one segment
 * directly under `~/.claude/projects` — except for the empty string, which
 * `join` drops, leaving the projects root itself, so it is refused before the
 * derivation is taken (decision 67).
 */
function transcriptDirOf(worktreePath: string, transcriptPath: string | null): string | undefined {
  if (!worktreePath) return undefined;
  const expected = transcriptDir(worktreePath);
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
 * One terminal-safe line of a task's goal. Goals are multi-line prose an agent
 * or the operator wrote, so only the first line is a headline, and only after
 * decision 29's sanitizing. Fitting it to a column is the reader's job: the
 * width belongs to the surface, not to the reading.
 */
export function goalHeadline(goal: string | undefined): string {
  return sanitizeReason((goal ?? '').split('\n')[0] ?? '');
}

/**
 * What sorts to the top of the list: a session that has stopped for good.
 * Deliberately narrower than `needsHuman`, which also counts awaiting-input —
 * hoisting a five-second permission ask above a blocked session would bury the
 * row the operator actually has to act on.
 */
function sortsFirst(session: DashboardSession): boolean {
  return session.state === 'blocked' || session.stalledAgeMs !== undefined;
}

/**
 * The inbox's order (decision 83): what only the operator can answer, by what
 * leaving it costs — a question idles a worker that has said why, a block or a
 * stall one that has stopped, a review and an open PR only hold finished work
 * back.
 */
const NEED_ORDER: DashboardNeed['kind'][] = [
  'question',
  'blocked',
  'stalled',
  'awaiting-review',
  'pr-open',
];

/**
 * The needs-you inbox (decision 83), read off a snapshot like `fleetSummary`
 * so `pup status`, the fleet view and the conductor that reads `pup status`
 * cannot disagree about what waits on the operator. One line per session, its
 * first reason in `NEED_ORDER`; within a kind, the snapshot's own row order.
 */
export function needsYou(snapshot: DashboardSnapshot): DashboardNeed[] {
  const needs = snapshot.sessions.flatMap((session) => needOf(session) ?? []);
  return NEED_ORDER.flatMap((kind) => needs.filter((need) => need.kind === kind));
}

/**
 * Symbols a stored text could pass off as the inbox's own `→`: every arrow
 * and emoji is a non-ASCII math or other symbol. ASCII `+ < = > | ~` stay,
 * since a question about code needs them and `+` turned into `-` would say
 * the opposite.
 */
const SYMBOLS = /(?![\0-\x7F])[\p{Sm}\p{So}]/gu;
const UNMINTED_ID = '(session id outside the minted shape; inspect the store)';

function needOf(session: DashboardSession): DashboardNeed | undefined {
  const { id } = session;
  const need = (kind: DashboardNeed['kind'], reason: string, answer: string): DashboardNeed => ({
    kind,
    sessionId: id,
    label: session.isMintedId ? id : UNMINTED_ID,
    reason,
    answer,
  });
  // The answer is what the conductor acts on, and the session row is
  // session-writable: an id outside the minted shape neither prints nor gets
  // a command built around it, and a question's arrows are not the line's
  // (decision 29).
  const command = (text: string): string => (session.isMintedId ? text : UNMINTED_ID);
  if (session.question !== undefined) {
    const asked = session.question.replace(SYMBOLS, '-');
    return need('question', `question: ${asked}`, command(`pup steer ${id} "..."`));
  }
  if (session.state === 'blocked') {
    return need(
      'blocked',
      `blocked (${session.rejectCount} rejections)`,
      command(`pup unblock ${id}`),
    );
  }
  if (session.stalledAgeMs !== undefined) {
    return need(
      'stalled',
      stallReason(session, session.stalledAgeMs),
      command(`pup steer ${id} "..."`),
    );
  }
  if (session.state === 'awaiting-review') {
    return need(
      'awaiting-review',
      'awaiting review',
      command(`pup review ${id} then pup merge ${id} --pr`),
    );
  }
  if (session.openPr !== undefined) {
    return need(
      'pr-open',
      'PR opened, not landed',
      session.openPr.url ?? '(PR url outside the pull-request shape; inspect the store)',
    );
  }
  return undefined;
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
/** A pull request and nothing else: the one url the inbox prints as the answer. */
const PR_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
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
    const timedOut = error instanceof Error && 'signal' in error && error.signal === 'SIGTERM';
    return timedOut ? 'unknown' : 'open';
  }
}

function dashboardSession(
  db: Database,
  row: SessionRow,
  task: TaskRow | undefined,
  eventsFile: string | undefined,
  stall: StalledSession | undefined,
  isLanded: (target: string | undefined, sha: string | undefined) => boolean,
): DashboardSession {
  const spec = taskSpecForDisplay(task);
  // Decision 2: hook events, never pane contents. Nothing to classify for a
  // session that is not running, or has yet to fire a hook.
  const activity =
    row.state === 'running' && eventsFile !== undefined && existsSync(eventsFile)
      ? classifySessionActivity(readFileSync(eventsFile, 'utf8'))
      : undefined;
  const stalledAgeMs = stall?.ageMs;
  // Only a running session has a context window to fill; a merged one's last
  // transcript is history, and reading it is I/O per row for nothing.
  const transcripts = transcriptDirOf(row.worktree_path, row.transcript_path);
  const contextTokens =
    row.state === 'running' && transcripts ? latestContextTokens(transcripts) : undefined;
  // Newest first, so `find` returns the latest matching event.
  const events = listEvents(db, row.id).reverse();
  const lastSteer = newestSteer(events);
  // Like activity: a question is a running session's. Killed or merged, nothing
  // can answer it (steers refuse terminal sessions), so it must not outlive it.
  const question = row.state === 'running' ? openQuestion(events) : undefined;
  const pr = row.state === 'merged' ? openPullRequest(events) : undefined;
  const openPr = pr && !isLanded(pr.target, pr.sha) ? { url: pr.url } : undefined;
  const lastGate = newestGate(events);
  // Only for the stall the session is in now: an hour-old resume belongs to a
  // stall the session has worked its way out of since.
  const deadTurn = stall && newestDeadTurn(events, stall.stalledAt);
  return {
    // The store is session-writable and, since the fleet view (decision 60),
    // not always the caller's own: all three print as stored, and no CHECK
    // constraint holds `state` to its type, so it is scrubbed like the others.
    id: sanitizeReason(row.id),
    isMintedId: SESSION_ID_PATTERN.test(row.id),
    state: sanitizeReason(row.state) as SessionState,
    branch: sanitizeReason(row.branch),
    taskId: row.task_id,
    goal: goalHeadline(spec.goal),
    // The task row is the only record of who asked for the work. It outlives
    // the session, so the join misses only on a store someone has edited by
    // hand — which is a row to render, not a reason to drop the session.
    origin: sanitizeReason(task?.origin ?? 'unknown'),
    scope: asStringArray(spec.scopeIn).map(sanitizeReason),
    acceptance: asStringArray(spec.acceptance).map(sanitizeReason),
    rejectCount: row.reject_count,
    ...(activity ? { activity } : {}),
    ...(stalledAgeMs === undefined ? {} : { stalledAgeMs }),
    ...(deadTurn ? { deadTurn } : {}),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(lastSteer ? { lastSteer } : {}),
    ...(question === undefined ? {} : { question }),
    ...(openPr === undefined ? {} : { openPr }),
    ...(lastGate ? { lastGate } : {}),
    recentEvents: events.slice(0, RECENT_EVENT_COUNT).reverse().map(dashboardEvent),
    needsHuman:
      row.state === 'blocked' || stalledAgeMs !== undefined || activity?.kind === 'awaiting-input',
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
 * The question a session asked with `pup session ask` and nobody has answered
 * yet (decision 76): the newest `question` event, unless a `steer` came after
 * it — a steer is the answer, whoever sent it and however it was delivered.
 * Derived off the store like a stall, so both surfaces read one answer.
 */
function openQuestion(newestFirst: EventRow[]): string | undefined {
  for (const row of newestFirst) {
    const event = decodeEvent(row);
    if (event.type === 'steer') return undefined;
    if (event.type !== 'question') continue;
    // Session-written text bound for the operator's terminal (decision 29).
    return event.text === undefined ? undefined : sanitizeReason(event.text) || undefined;
  }
  return undefined;
}

/**
 * The PR the newest merge opened, with the commit it pinned, unless a `landed`
 * event came after it (decision 83). Only the newest merge counts: a session
 * merged twice is described by the merge that stands. A merge with no PR is a
 * local fast-forward, already on the target, so nothing is open. `pup land`
 * writes `landed` once GitHub merged the PR and main holds the pinned sha
 * (decision 84), which also covers a target this checkout has not pulled.
 */
function openPullRequest(
  newestFirst: EventRow[],
): { url: string | undefined; sha: string | undefined; target: string | undefined } | undefined {
  for (const row of newestFirst) {
    if (row.type === 'landed') return undefined;
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
  const failed = stages.find((stage) => stage.status === 'fail');
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
  const debt = baseline.debt ?? {};
  return {
    capturedAt: toIsoUtc(baseline.capturedAt),
    ...(typeof debt.coverageRatio === 'number' ? { coverageRatio: debt.coverageRatio } : {}),
    ...(typeof debt.duplicatedLines === 'number' ? { duplicatedLines: debt.duplicatedLines } : {}),
    ...(Array.isArray(debt.deadExports) ? { deadExports: debt.deadExports.length } : {}),
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
