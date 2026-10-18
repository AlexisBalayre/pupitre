import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { detectAdapters } from '../adapters/adapter.registry.js';
import type { Tier } from '../claude/model-ladder.constants.js';
import {
  interruptPane,
  kickoff,
  killSession as killTmux,
  launchSession,
  type SessionPane,
  SessionPaneMissingError,
  steerPane,
  transcriptDir,
  windowLabel,
} from '../claude/session-runtime.service.js';
import { buildCodeMap, buildKnowledgeSlice } from './code-map.service.js';
import { codegraphBinary, prepareGraph } from './codegraph.client.js';
import { windowFailureOf } from './dashboard.service.js';
import { assertNoArmedGitDrivers, runGit } from './git-diff.client.js';
import { scopeConflicts } from './overlap.service.js';
import { type ProjectPaths, projectId, projectPaths } from './paths.utils.js';
import {
  compileProfile,
  peerJoinedMessage,
  snapshotUserConfigHash,
  writeCompiledProfile,
} from './profile-compiler.service.js';
import { asStringArray } from './report-data.utils.js';
import { asTier, type ClimbReason, climbFrom, routeFor, taskTier } from './routing.utils.js';
import {
  appendEvent,
  claimingSession,
  ensureProject,
  getSession,
  getTask,
  insertSession,
  insertTask,
  listTaskSessions,
  readTaskSpec,
  type SessionRoute,
  type SessionRow,
  taskSpecForDisplay,
  transitionSession,
} from './session.repository.js';
import {
  isRefusedSteer,
  rollBackRefusedLaunch,
  TaskAlreadyClaimedError,
  TerminalSessionError,
  TopRungReachedError,
  UnknownSessionError,
  UnknownTaskError,
} from './session-lifecycle.errors.js';
import { isTerminal } from './session-state.utils.js';
import { assertPlannableSpec } from './task-spec.utils.js';
import type { ScopeConflict } from './types/overlap.types.js';
import type { SessionId, TaskSpec } from './types/profile.types.js';
import type {
  LaunchTaskRequest,
  NewSessionRequest,
  PlanTaskRequest,
  RouteOverride,
  SessionPeer,
} from './types/session-lifecycle.types.js';

/** A short, filesystem- and tmux-safe id derived from the task id and a counter. */
function sessionSlug(taskId: string, existing: number): string {
  const stem = taskId.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 24);
  return existing === 0 ? stem : `${stem}-${existing}`;
}

/**
 * Record intent without acting on it — the backlog entry behind `pup plan`.
 * Deliberately does no git or filesystem work: a planned task is a row and
 * nothing else, so planning cannot half-fail (decision 40).
 */
export function planTask(db: Database, req: PlanTaskRequest): string {
  // Validated where it is written, not only where it is compiled: a backlog row
  // is written by one act and launched by another, possibly days later, and the
  // operator who typed the bad glob is long gone by then (decision 40).
  assertPlannableSpec(req.task);
  const pid = projectId(req.repoPath);
  ensureProject(db, pid, req.repoPath);
  insertTask(db, {
    id: req.task.id,
    projectId: pid,
    spec: JSON.stringify(req.task),
    role: req.role?.name,
    origin: req.origin,
    tier: req.tier,
  });
  return req.task.id;
}

/**
 * Compile a profile, create an isolated worktree, and launch a session for a
 * task the store already holds — `pup launch`, and the second half of `pup new`.
 *
 * The knowledge slice is built here rather than at plan time: the code map moves
 * on between planning a task and launching it, so a slice captured with the
 * intent would describe a repo that no longer exists.
 */
export function launchTask(db: Database, req: LaunchTaskRequest): string {
  const pid = projectId(req.repoPath);
  const row = getTask(db, req.taskId);
  if (!row) throw new UnknownTaskError(req.taskId);
  // Relaunching a claimed task would mint a second session with a fresh
  // reject_count, stepping over the cap that parked the first one as blocked
  // (decision 7). Only a killed session leaves its task launchable again.
  const claimedBy = claimingSession(db, row.id);
  if (claimedBy) throw new TaskAlreadyClaimedError(row.id, claimedBy);
  // Validated before the conflict check, the first thing to read the stored
  // spec's globs: a row written before `pup plan add` validated would otherwise
  // reach `scopedPaths` with no `scopeIn` and throw a bare TypeError.
  const task = readTaskSpec(db, row.id);
  // Before `git worktree add`, which checks out every file in HEAD and runs a
  // smudge filter on each one with the operator's environment. The shared
  // config and `info/attributes` arm it, `.git/**` is untracked, and the
  // driver name is chosen by whoever wrote it, so there is nothing to disarm
  // — only a refusal (decision 50).
  assertNoArmedGitDrivers(req.repoPath);
  // Not a refusal: workers share files and agree between themselves who
  // changes what (decision 99, superseding decision 41's refusal). Measured
  // before the launch because the radar notices two sessions in one file only
  // once both are editing it, too late to introduce them.
  const conflicts = scopeConflicts(db, req.repoPath, task.scopeIn, task.scopeOut);
  // Before anything is built: a task past the top of its ladder is refused
  // before a worktree exists. The tier is the one `--tier` stored, else
  // the one the scope-in implies, and the climb is from the task's newest
  // session, which a relaunch replaces.
  const route = nextWindowRoute(
    { task: row.id },
    taskTier(row.tier, task.scopeIn),
    listTaskSessions(db, row.id).at(-1),
    (previous) => windowFailureOf(db, projectPaths(req.repoPath), previous, Date.now()),
    { model: req.model, effort: req.effort },
    req.overrideVia !== 'conductor',
  );
  task.knowledgeSlice = knowledgeSliceFor(db, req.repoPath, pid, task.scopeIn);
  const sessionId = startSession(db, { ...req, task }, route, conflicts.map(peerOf));
  if (conflicts.length > 0) {
    appendEvent(db, sessionId, 'scope_overlap', {
      via: req.overlapVia ?? 'operator',
      accepted: conflicts.map((conflict) => ({
        session: conflict.sessionId,
        files: conflict.files,
      })),
    });
    introduceToPeers(db, sessionId, conflicts);
  }
  return sessionId;
}

/** A live session sharing files, as the worker launched beside it is told of it. */
function peerOf(conflict: ScopeConflict): SessionPeer {
  return { name: windowLabel({ sessionId: conflict.sessionId }), files: conflict.files };
}

/**
 * Steer each live session sharing files with the one just launched, once,
 * with the newcomer's name and what they share (decision 99). After the
 * kickoff landed, so a peer that messages straight away reaches a window
 * that has read its task. Best effort: a peer whose window refuses the paste
 * is not a reason to undo a launch that worked, and the newcomer's kickoff
 * already names it, so either side can open the conversation.
 */
function introduceToPeers(db: Database, newcomer: string, conflicts: ScopeConflict[]): void {
  const name = windowLabel({ sessionId: newcomer });
  for (const conflict of conflicts) {
    try {
      steerSession(db, conflict.sessionId, peerJoinedMessage({ name, files: conflict.files }), {
        kind: 'peer-joined',
        by: newcomer,
      });
    } catch (error) {
      if (!isRefusedSteer(error) && !(error instanceof TerminalSessionError)) throw error;
    }
  }
}

/**
 * Plan and launch in one step — the assembly line behind `pup new`, unchanged
 * from the operator's side. Returns the created session id.
 */
export function createSession(db: Database, req: NewSessionRequest): string {
  // Asked before the row is written, not only inside `launchTask`: a refusal
  // costs an operator nothing on `pup launch`, where the task already existed,
  // but here it would leave the spec they just abandoned sitting in the
  // backlog — unclaimed, attributed to them, and listed as planned work until
  // someone notices and drops it (decision 50).
  assertNoArmedGitDrivers(req.repoPath);
  planTask(db, req);
  return launchTask(db, { ...req, taskId: req.task.id });
}

/**
 * Best-effort code-map context for the task's scope. A broken or unavailable
 * map must never block a launch, so every failure degrades to no slice.
 */
function knowledgeSliceFor(
  db: Database,
  repoPath: string,
  pid: string,
  scopeIn: string[],
): string | undefined {
  try {
    const [adapter] = detectAdapters(repoPath);
    if (!adapter) return undefined;
    return buildKnowledgeSlice(buildCodeMap(db, pid, repoPath, adapter), scopeIn) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The route a task's next window runs on (decision 92), a relaunch's or a
 * respawn's: the first rung of its tier's ladder with no window before it, the
 * rung that window stood on, or one higher when it ran into a failure, with the
 * reason it climbed. A failure on the top rung climbs nowhere: the window is
 * refused for the operator to decide, and an explicit model or effort the
 * operator names is that decision, recorded as an override; the conductor's
 * `--worker-model` is an override too, but never that decision. A task re-tiered since its last window
 * starts its new ladder from the bottom. `failureOf` is asked only of a window
 * there is.
 */
function nextWindowRoute(
  subject: { task: string } | { session: string },
  tier: Tier,
  previous: SessionRow | undefined,
  failureOf: (previous: SessionRow) => ClimbReason | 'blocked' | undefined,
  override: RouteOverride,
  operatorDecides = true,
): SessionRoute {
  const climb = climbFrom(tier, previous, previous && failureOf(previous));
  const isOverride = override.model !== undefined || override.effort !== undefined;
  if (climb.topReached && !(isOverride && operatorDecides)) {
    throw new TopRungReachedError(subject, tier, climb.topReached);
  }
  const { model, effort } = routeFor(tier, climb.rung, override);
  return { tier, rung: climb.rung, model, effort, reason: climb.reason, override: isOverride };
}

/**
 * The route a respawned session's fresh window runs on (decision 92), climbed
 * from the window it replaces, as a relaunch is from the session before it. An
 * override the session was launched or respawned with stays its model and
 * effort, the rung still climbing under it, unless the operator names new
 * ones. Asked before the old window is killed, so a refusal leaves it running.
 */
export function respawnRoute(
  db: Database,
  paths: ProjectPaths,
  session: SessionRow,
  override: RouteOverride = {},
): SessionRoute {
  const named = override.model !== undefined || override.effort !== undefined;
  const kept =
    session.route_override === 1
      ? { model: session.model ?? undefined, effort: session.effort ?? undefined }
      : {};
  const task = getTask(db, session.task_id);
  const tier =
    asTier(session.tier) ??
    taskTier(task?.tier ?? null, asStringArray(taskSpecForDisplay(task).scopeIn));
  return nextWindowRoute(
    { session: session.id },
    tier,
    session,
    () => windowFailureOf(db, paths, session, Date.now()),
    named ? override : kept,
    named,
  );
}

function startSession(
  db: Database,
  req: LaunchTaskRequest & { task: TaskSpec },
  route: SessionRoute,
  peers: SessionPeer[],
): string {
  const paths = projectPaths(req.repoPath);

  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE task_id = ?').get(req.task.id) as {
      n: number;
    }
  ).n;
  const sessionId = sessionSlug(req.task.id, count) as unknown as string;
  const branch = `pup/${sessionId}`;
  const worktreePath = join(req.repoPath, '.worktrees', sessionId);
  const compiledDir = paths.compiledDir(sessionId);

  // Compile first: it is the only thing that validates the spec, and a spec
  // stored days ago by `pup plan` is not the argv the operator just typed. A
  // throw after `worktree add` would leave an orphan worktree and branch, and
  // every retry would then fail on the existing branch name (decision 40).
  const userConfigHash = snapshotUserConfigHash(req.claudeUserDir);
  mkdirSync(compiledDir, { recursive: true });
  // Before the compile, because the answer shapes the compiled files and the
  // hash is recorded over them: which binary serves the graph is part of the
  // session's environment, not a runtime detail (decision 51).
  const binary = codegraphBinary(req.repoPath);
  const compiled = compileProfile({
    base: req.base,
    role: req.role,
    task: req.task,
    sessionId: sessionId as SessionId,
    // The compiler reads the project brief through this (decision 57); the
    // worktree is not it, and does not exist yet at this point anyway.
    repoPath: req.repoPath,
    worktreePath,
    eventsFile: paths.eventsFile(sessionId),
    userConfigHash,
    outDir: compiledDir,
    codegraphBinary: binary,
    peers,
  });
  runGit(req.repoPath, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  writeCompiledProfile(compiled, compiledDir);
  // After `worktree add`, since the files do not exist before it, and before the
  // launch, so the window opens on a graph of its own branch (decision 51).
  const mcpConfigPath = prepareGraph(binary, req.repoPath, worktreePath)
    ? join(compiledDir, 'mcp.json')
    : undefined;

  insertSession(db, {
    id: sessionId,
    taskId: req.task.id,
    worktreePath,
    branch,
    profileHash: compiled.hash,
    transcriptPath: transcriptDir(worktreePath),
    route,
  });

  const pane = launchSession({
    sessionId,
    worktreePath,
    settingsPath: join(compiledDir, 'settings.json'),
    route: routeFor(route.tier, route.rung, route),
    mcpConfigPath,
  });
  // The pane id, not the session name: every later steer is addressed to it
  // (decision 46), so it is stored before anything is typed into it.
  db.prepare('UPDATE sessions SET tmux_target = ? WHERE id = ?').run(pane.paneId, sessionId);
  transitionSession(db, sessionId, 'running', { profileHash: compiled.hash });

  return deliverKickoff(db, sessionId, pane, compiled.contextMarkdown);
}

/**
 * Deliver the compiled task context as the opening prompt once the UI is
 * ready, or undo the launch. Both ways it can fail land here and nowhere
 * earlier: the task is claimed, the row is `running` and the window is up by
 * the time the first character is typed, so left as they are the task reads as
 * claimed (a re-launch raises TaskAlreadyClaimedError) and the window sits
 * empty, on a bypass-permissions agent that has read none of its task.
 *
 * Killing the session undoes all of it — the window goes, the row is `killed`,
 * and the task returns to the backlog (decision 40) — which is why every front
 * end's retry is a fresh launch of the same task. The two failures differ only
 * in whether there is a refusal to read: a paste that never landed whole says
 * so itself (decision 45), while a window that never showed its input box
 * never said anything, so the rollback line is the whole of it.
 */
function deliverKickoff(
  db: Database,
  sessionId: string,
  pane: SessionPane,
  context: string,
): string {
  let delivered: boolean;
  try {
    delivered = kickoff(pane, context);
  } catch (error) {
    if (!isRefusedSteer(error)) throw error;
    throw rollBackRefusedLaunch(
      () => killSession(db, sessionId),
      `Launch rolled back (session ${sessionId} killed)`,
      error,
    );
  }
  // Recorded before the rollback below, and kept through it: a launch that was
  // undone still leaves on the session it killed the trace of why.
  appendEvent(db, sessionId, 'steer', { kind: 'kickoff', delivered });
  if (!delivered) {
    throw rollBackRefusedLaunch(
      () => killSession(db, sessionId),
      `Session ${sessionId}'s window never became ready, so its context was not delivered ` +
        'and the session was killed',
    );
  }
  return sessionId;
}

/** Mark a session done (run by the agent via `pup session done`). */
export function markSessionDone(db: Database, sessionId: string, summary: string): void {
  appendEvent(db, sessionId, 'session_done', { summary });
  transitionSession(db, sessionId, 'awaiting-review', { summary });
}

/**
 * Record a question a session is blocked on (run by the agent via `pup session
 * ask`, decision 76). The session stays running: the agent ends its turn, and
 * the next steer is the answer — which is also what clears the question from
 * the dashboard.
 */
export function markSessionQuestion(db: Database, sessionId: string, text: string): void {
  appendEvent(db, sessionId, 'question', { text });
}

/**
 * The pane a session's window was opened in, as `launchSession` recorded it.
 * The only way a row's pane reaches the runtime, so a steer, interrupt or
 * kickoff is addressed to the pane pinned at launch and never to the session,
 * whose active pane the agent can move (decision 46). Refuses a row with none
 * recorded — a launch that failed before its update — rather than let a
 * caller fall back to a name.
 */
export function sessionPane(row: SessionRow): SessionPane {
  if (row.tmux_target === null) throw new SessionPaneMissingError(row.id, null, 'unrecorded');
  return { sessionId: row.id, paneId: row.tmux_target };
}

/**
 * How a delivered steer is recorded: what kind of steer it was, and who sent
 * it where the caller can name a sender — a typed steer is not the operator's
 * just because it was typed, and a conductor or session pup can identify is
 * named as one before its word is taken (decisions 44, 47).
 */
type SteerRecord = {
  kind: string;
  by?: string;
};

/**
 * Steer a session by id, into the pane recorded at its launch. The session
 * half of `steerPane`: resolves the row, refuses a session that has stopped or
 * has no pane recorded, and lets the runtime's own refusals (a gone pane, a
 * paste that never landed) through untouched for the caller to print.
 *
 * `record` is the event the delivered steer is written as, and is what the
 * front ends pass instead of appending their own — a steer nobody recorded is
 * a session the report and the last-steer queries show as corrected by
 * nobody. It is optional because the two callers inside core record the
 * outcome of something larger than the paste: the watchdog's resume is written
 * once the sweep knows whether it was refused, and the gate's re-steer only
 * once the session is back to `running`. Nothing is recorded unless the paste
 * landed.
 */
export function steerSession(
  db: Database,
  sessionId: string,
  message: string,
  record?: SteerRecord,
): void {
  steerPane(sessionPane(requireLiveSession(db, sessionId, 'steer')), message);
  if (record) appendEvent(db, sessionId, 'steer', record);
}

/**
 * Record a steer that reached the session over the peer socket, where nothing
 * was typed. A message lands whole and never touches the input box, so it
 * needs no paste — but it needs the record, or the report and last-steer
 * queries would show a session corrected by nobody. `by` names the sender the
 * caller identified (decisions 44, 47).
 */
export function recordSteerMessage(db: Database, sessionId: string, by: string): void {
  requireLiveSession(db, sessionId, 'steer');
  appendEvent(db, sessionId, 'steer', { kind: 'message', by });
}

/**
 * Send Escape to a session's launch pane, optionally steering a message once
 * the UI is back at its input box, and record what landed. The two are one
 * call because their records are one story: an Escape that landed is on record
 * even when the steer behind it is refused. `by` names the sender of that steer
 * where the caller can identify one, as `steerSession`'s record does.
 */
export function interruptSession(
  db: Database,
  sessionId: string,
  message?: string,
  by?: string,
): void {
  const pane = sessionPane(requireLiveSession(db, sessionId, 'interrupt'));
  // Nothing landed yet, so nothing is on record if this refuses.
  interruptPane(pane);
  if (message) {
    try {
      steerPane(pane, message);
    } catch (error) {
      // Escape already landed, so the interrupt is on record; only the steer
      // is refused.
      appendEvent(db, sessionId, 'interrupt', { steered: false });
      throw error;
    }
  }
  appendEvent(db, sessionId, 'interrupt', { steered: Boolean(message) });
  // The message is a real steer — record it as one too, so last-steer queries
  // see it no matter which path delivered it.
  if (message) appendEvent(db, sessionId, 'steer', { kind: 'interrupt', by });
}

export function killSession(db: Database, sessionId: string): void {
  const row = requireSession(db, sessionId);
  // The pane too, not the name alone: a rename from inside the session would
  // leave the name pointing at nothing while the window ran on.
  killTmux(sessionId, row.tmux_target);
  transitionSession(db, sessionId, 'killed');
}

function requireSession(db: Database, sessionId: string): SessionRow {
  const row = getSession(db, sessionId);
  if (!row) throw new UnknownSessionError(sessionId);
  return row;
}

/**
 * The row a steer or an interrupt may act on. A terminal session has nothing
 * to correct: its window is gone or its work is already on the branch, and
 * typing into the pane it left behind reaches whatever holds that id now.
 * Asked in core rather than at each front end, so `pup steer` and the
 * dashboard's `s` refuse the same sessions.
 */
function requireLiveSession(db: Database, sessionId: string, verb: string): SessionRow {
  const row = requireSession(db, sessionId);
  if (isTerminal(row.state)) throw new TerminalSessionError(sessionId, row.state, verb);
  return row;
}
