import { lstatSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { detectAdapters } from '../adapters/adapter.registry.js';
import { sanitizeReason } from '../adapters/capability.utils.js';
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
import { maxSessions } from './conductor.service.js';
import { windowFailureOf } from './dashboard.service.js';
import {
  assertNoArmedGitDrivers,
  assertNoWorktreeConfig,
  checkoutPinned,
  runGit,
  verifiedWorktreeGitEnv,
  WorktreeRepointedError,
  worktreeGitEnv,
} from './git-diff.client.js';
import { filesWorthANotice, scopeConflicts } from './overlap.service.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { type ProjectPaths, projectId, projectPaths } from './paths.utils.js';
import {
  compileProfile,
  peerJoinedMessage,
  snapshotUserConfigHash,
  writeCompiledProfile,
} from './profile-compiler.service.js';
import { asStringArray } from './report-data.utils.js';
import {
  asTier,
  type ClimbReason,
  climbFrom,
  fixRoundFailure,
  routeFor,
  taskTier,
} from './routing.utils.js';
import {
  appendEvent,
  claimingSession,
  currentFixRound,
  decodeEvent,
  ensureProject,
  getSession,
  getTask,
  insertSession,
  insertTask,
  listEvents,
  listSessions,
  listTaskSessions,
  readTaskSpec,
  type SessionRoute,
  type SessionRow,
  taskSpecForDisplay,
  transitionSession,
  transitionSessionAlong,
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
import { FIX_ROUND_EDGE, holdingStates, isTerminal } from './session-state.utils.js';
import { assertPlannableSpec } from './task-spec.utils.js';
import {
  availableMemoryBytes,
  MIN_AVAILABLE_MEMORY_BYTES,
  sessionTestCommand,
} from './test-slot.service.js';
import type { ScopeConflict } from './types/overlap.types.js';
import type { CompiledProfile, SessionId, TaskSpec } from './types/profile.types.js';
import type {
  LaunchTaskRequest,
  NewSessionRequest,
  PlanTaskRequest,
  RouteOverride,
  SessionPeer,
} from './types/session-lifecycle.types.js';

/**
 * `--over-cap`: the operator's word that one more session may go past the cap
 * (decision 96). Only the operator's: a launch the conductor makes ignores it.
 */
interface CapOverride {
  overCap?: boolean;
}

/** A launch refused because the project already has as many live sessions as its cap. */
export class SessionCapReachedError extends Error {
  constructor(live: number, cap: number) {
    super(
      `${live} sessions are live, at this project's cap of ${cap} (\`pup conductor start ` +
        '--max-sessions` sets it); nothing was launched. Wait for one to finish, or, as the ' +
        'operator, pass --over-cap to `pup launch` or `pup new`.',
    );
    this.name = 'SessionCapReachedError';
  }
}

/** A launch refused because the machine has too little memory available for another window. */
export class LowMemoryError extends Error {
  constructor(available: number) {
    super(
      `Only ${gigabytes(available)} GB of memory is available, under the ` +
        `${gigabytes(MIN_AVAILABLE_MEMORY_BYTES)} GB a launch needs; nothing was launched. ` +
        'Wait for a session or a test run to finish, then launch again.',
    );
    this.name = 'LowMemoryError';
  }
}

function gigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/**
 * Refuse a launch past the project's session cap or into a machine short of
 * memory (decision 96). Asked before anything is built, and before `pup new`
 * writes its task, so a refusal leaves nothing behind. `--over-cap` lifts the
 * cap for the operator alone and never the memory floor: memory is the
 * machine's limit, the cap only the operator's choice of one.
 */
function assertRoomToLaunch(
  db: Database,
  repoPath: string,
  req: CapOverride & Pick<LaunchTaskRequest, 'overlapVia' | 'overrideVia'>,
): void {
  const byOperator = req.overlapVia !== 'conductor' && req.overrideVia !== 'conductor';
  if (!(req.overCap && byOperator)) {
    const live = listSessions(db, holdingStates()).length;
    const cap = maxSessions(repoPath);
    if (live >= cap) throw new SessionCapReachedError(live, cap);
  }
  const available = availableMemoryBytes();
  if (available < MIN_AVAILABLE_MEMORY_BYTES) throw new LowMemoryError(available);
}

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
export function launchTask(db: Database, req: LaunchTaskRequest & CapOverride): string {
  const pid = projectId(req.repoPath);
  const row = getTask(db, req.taskId);
  if (!row) throw new UnknownTaskError(req.taskId);
  // Relaunching a claimed task would mint a second session with a fresh
  // reject_count, stepping over the cap that parked the first one as blocked
  // (decision 7). Only a killed session leaves its task launchable again.
  const claimedBy = claimingSession(db, row.id);
  if (claimedBy) throw new TaskAlreadyClaimedError(row.id, claimedBy);
  assertRoomToLaunch(db, req.repoPath, req);
  // Validated before the conflict check, the first thing to read the stored
  // spec's globs: a row written before `pup plan add` validated would otherwise
  // reach `scopedPaths` with no `scopeIn` and throw a bare TypeError.
  const task = readTaskSpec(db, row.id);
  // Before `git worktree add`, which checks out every file in HEAD and runs a
  // smudge filter on each one with the operator's environment. The shared
  // config and `info/attributes` arm it, `.git/**` is untracked, and the
  // driver name is chosen by whoever wrote it, so there is nothing to disarm
  // — only a refusal (decision 50). Per-worktree config is refused here too:
  // the launch's own check would refuse it only once the worktree and the row
  // exist, and they then block a retry (decision 101).
  assertNoWorktreeConfig(req.repoPath);
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
  const sessionId = startSession(
    db,
    { ...req, task },
    route,
    overlapsWorthANotice(db, conflicts).map(peerOf),
  );
  recordOverlaps(db, sessionId, conflicts, req.overlapVia ?? 'operator');
  return sessionId;
}

/**
 * Record the live sessions `sessionId` shares files with, and introduce it to
 * each (decision 99): after a launch's kickoff, and after a fix round's, whose
 * worker edits the same files again (decision 90).
 */
export function recordOverlaps(
  db: Database,
  sessionId: string,
  conflicts: ScopeConflict[],
  via: 'operator' | 'conductor',
): void {
  if (conflicts.length === 0) return;
  appendEvent(db, sessionId, 'scope_overlap', {
    via,
    accepted: conflicts.map((conflict) => ({ session: conflict.sessionId, files: conflict.files })),
  });
  introduceToPeers(db, sessionId, conflicts);
}

/** A live session sharing files, as the worker launched beside it is told of it. */
function peerOf(conflict: ScopeConflict): SessionPeer {
  return { name: windowLabel({ sessionId: conflict.sessionId }), files: conflict.files };
}

/**
 * The overlaps two workers are told of, on either side: with a running peer,
 * over files other than the append-only decisions log (decision 104). A
 * kickoff's `## Peers` asks its worker to message each peer it lists, which
 * wakes an idle one as surely as a steer, so the kickoff lists only these.
 * A peer in any other state is reached by the gate's fresh-base stage and a
 * fix round's own introduction when it next works. Two appends to the log
 * conflict whatever their workers agree: the first to land sends the other
 * the main-landed notice, log included, while it runs, and the gate's
 * fresh-base stage meets it otherwise. The state is read at each call.
 */
function overlapsWorthANotice(db: Database, conflicts: ScopeConflict[]): ScopeConflict[] {
  return conflicts.flatMap(({ sessionId, files }) => {
    const shared = filesWorthANotice(files);
    return shared.length > 0 && getSession(db, sessionId)?.state === 'running'
      ? [{ sessionId, files: shared }]
      : [];
  });
}

/**
 * Steer each running session sharing files with the one just launched, once,
 * with the newcomer's name and what they share (decision 99). After the
 * kickoff landed, so a peer that messages straight away reaches a window
 * that has read its task. Best effort: a peer whose window refuses the paste
 * is not a reason to undo a launch that worked, and the newcomer's kickoff
 * already names it, so either side can open the conversation.
 */
function introduceToPeers(db: Database, newcomer: string, conflicts: ScopeConflict[]): void {
  const name = windowLabel({ sessionId: newcomer });
  for (const { sessionId, files } of overlapsWorthANotice(db, conflicts)) {
    try {
      steerSession(db, sessionId, peerJoinedMessage({ name, files }), {
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
export function createSession(db: Database, req: NewSessionRequest & CapOverride): string {
  // Asked before the row is written, not only inside `launchTask`: a refusal
  // costs an operator nothing on `pup launch`, where the task already existed,
  // but here it would leave the spec they just abandoned sitting in the
  // backlog — unclaimed, attributed to them, and listed as planned work until
  // someone notices and drops it (decision 50).
  assertNoWorktreeConfig(req.repoPath);
  assertNoArmedGitDrivers(req.repoPath);
  assertRoomToLaunch(db, req.repoPath, req);
  planTask(db, req);
  return launchTask(db, { ...req, taskId: req.task.id });
}

/**
 * The project's test command, which the session's test guard refuses beside
 * the runners it always does (decision 96). Best effort, as the knowledge
 * slice is: an adapter that fails to load costs the guard one pattern, never
 * the launch.
 */
function testCommandFor(repoPath: string): ReturnType<typeof sessionTestCommand> {
  try {
    return sessionTestCommand(repoPath);
  } catch {
    return undefined;
  }
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
  return sessionWindowRoute(
    db,
    session,
    () => windowFailureOf(db, paths, session, Date.now()),
    override,
    true,
  );
}

/**
 * The route a CI fix round's window runs on (decision 90): the rung of the
 * window before it, since a reviewer's finding is no failure, and one higher
 * only when one of `openThreads`, the threads the round is handed, was handed
 * to the round before it too (decision 92), with an override kept or named as
 * on a respawn. The conductor runs `pup fix` too, and an override it names
 * never lifts a top-rung refusal, as on its launches.
 */
export function fixRoundRoute(
  db: Database,
  session: SessionRow,
  openThreads: readonly string[],
  override: RouteOverride,
  overrideVia: 'operator' | 'conductor',
): SessionRoute {
  return sessionWindowRoute(
    db,
    session,
    () => fixRoundFailure(listEvents(db, session.id).map(decodeEvent), openThreads),
    override,
    overrideVia === 'operator',
  );
}

/**
 * What a session's next window runs on, climbed from the one it replaces as
 * `failureOf` says. An override the session was launched or respawned with
 * stays its model and effort, the rung still climbing under it, unless new ones
 * are named; only a named one the operator chose lifts the top-rung refusal.
 */
function sessionWindowRoute(
  db: Database,
  session: SessionRow,
  failureOf: () => ClimbReason | 'blocked' | undefined,
  override: RouteOverride,
  isOperator: boolean,
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
    failureOf,
    named ? override : kept,
    named && isOperator,
  );
}

/**
 * What a session's profile is compiled from besides its task: the base layer
 * and the user config. A role is the launch caller's to pass, and only an API
 * caller does: the task row keeps its name alone, which nothing resolves back.
 */
export type ProfileSource = Pick<LaunchTaskRequest, 'repoPath' | 'base' | 'claudeUserDir'>;

/** A compiled profile and the codegraph binary it was compiled for, if any. */
export interface SessionCompile {
  compiled: CompiledProfile;
  binary: string | undefined;
}

/**
 * Compile a session's profile for its compiled dir, without writing it: the
 * launch's compile, and the fix round's (decision 90).
 */
function compileSessionProfile(
  source: ProfileSource & Pick<LaunchTaskRequest, 'role'>,
  task: TaskSpec,
  session: Pick<SessionRow, 'id' | 'worktree_path'>,
  paths: ProjectPaths,
  peers: SessionPeer[],
): SessionCompile {
  const compiledDir = paths.compiledDir(session.id);
  const userConfigHash = snapshotUserConfigHash(source.claudeUserDir);
  mkdirSync(compiledDir, { recursive: true });
  // Before the compile, because the answer shapes the compiled files and the
  // hash is recorded over them: which binary serves the graph is part of the
  // session's environment, not a runtime detail (decision 51).
  const binary = codegraphBinary(source.repoPath);
  const compiled = compileProfile({
    base: source.base,
    role: source.role,
    task,
    sessionId: session.id as SessionId,
    // The compiler reads the project brief through this (decision 57); the
    // worktree is not it, and may not exist yet at this point anyway.
    repoPath: source.repoPath,
    worktreePath: session.worktree_path,
    eventsFile: paths.eventsFile(session.id),
    userConfigHash,
    outDir: compiledDir,
    codegraphBinary: binary,
    peers,
    testCommand: testCommandFor(source.repoPath),
  });
  return { compiled, binary };
}

/**
 * A fix round's profile, compiled afresh from the task spec as a launch
 * compiles it, with the knowledge slice and the peers worth a notice as of
 * now, and every overlap returned for `recordOverlaps` once the kickoff lands
 * (decision 90). The
 * compiled dir under the store is one the conductor's shell can write
 * (decision 47), so a round never relaunches from what it holds. A merged
 * session is not live, so a round adds a window as a launch does, and meets the
 * same cap and memory floor first, with no `--over-cap` (decision 96).
 */
export function recompileSessionProfile(
  db: Database,
  source: ProfileSource,
  session: SessionRow,
  paths: ProjectPaths,
): SessionCompile & { conflicts: ScopeConflict[] } {
  assertRoomToLaunch(db, source.repoPath, {});
  const task = readTaskSpec(db, session.task_id);
  task.knowledgeSlice = knowledgeSliceFor(
    db,
    source.repoPath,
    projectId(source.repoPath),
    task.scopeIn,
  );
  const conflicts = scopeConflicts(db, source.repoPath, task.scopeIn, task.scopeOut);
  return {
    ...compileSessionProfile(
      source,
      task,
      session,
      paths,
      overlapsWorthANotice(db, conflicts).map(peerOf),
    ),
    conflicts,
  };
}

/**
 * Write a compile into the session's compiled dir and prepare its code graph
 * on the worktree, which must exist by now, so the window opens on a graph of
 * its own branch (decision 51). The MCP config is offered only from this
 * compile's binary, never from an `mcp.json` found on disk. The indexer's git
 * is pinned to the dirs pup trusts, once the pointers are checked (decision
 * 101); a check that fails costs the graph, and the window's own check then
 * refuses the launch.
 */
export function writeSessionProfile(
  { compiled, binary }: SessionCompile,
  repoPath: string,
  worktreePath: string,
  compiledDir: string,
): { settingsPath: string; mcpConfigPath: string | undefined } {
  writeCompiledProfile(compiled, compiledDir);
  return {
    settingsPath: join(compiledDir, 'settings.json'),
    mcpConfigPath: prepareGraph(binary, repoPath, worktreePath, () =>
      verifiedWorktreeGitEnv(repoPath, worktreePath),
    )
      ? join(compiledDir, 'mcp.json')
      : undefined,
  };
}

/**
 * Undo a `worktree add` whose pinned checkout threw: a rewritten `commondir`,
 * a full disk, an interrupt. Left behind, the worktree and branch would refuse
 * the retry, which mints the same id (decision 40). No git runs in the
 * worktree: the directory goes first, so the prune drops its registration,
 * which is then checked gone, since the prune keeps a locked one and says
 * nothing, and the branch goes only while it still holds the commit the add
 * cut it at.
 * Returns what it undid, as the advice the refusal closes with: a rewritten
 * pointer's own asks for a `worktree repair`, which no longer fits once the
 * worktree is gone. Swallowed: a cleanup failure must not replace the refusal.
 */
function dropUncheckedWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  head: string,
): string {
  try {
    rmSync(worktreePath, { recursive: true, force: true });
    runGit(repoPath, ['worktree', 'prune']);
    if (lstatSync(worktreeGitEnv(repoPath, worktreePath).GIT_DIR, { throwIfNoEntry: false })) {
      throw new Error('the prune kept the admin dir');
    }
    runGit(repoPath, ['update-ref', '--no-deref', '-d', `refs/heads/${branch}`, head]);
    return (
      `The launch's new worktree and its branch ${sanitizeReason(branch)} were removed, so ` +
      'nothing needs restoring: retry the launch once the cause is cleared'
    );
  } catch {
    return (
      `The launch could not remove its new worktree ${sanitizeReason(worktreePath)} and ` +
      `branch ${sanitizeReason(branch)}: remove both, then retry the launch`
    );
  }
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
  const compile = compileSessionProfile(
    req,
    req.task,
    { id: sessionId, worktree_path: worktreePath },
    paths,
    peers,
  );
  const { compiled } = compile;
  // `--no-checkout`: the add's own checkout would read the admin dir's
  // `commondir` before any check of it (decision 101).
  const head = runGit(req.repoPath, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  runGit(req.repoPath, ['worktree', 'add', '--no-checkout', '-b', branch, worktreePath, head]);
  try {
    checkoutPinned(req.repoPath, worktreePath, head);
  } catch (error) {
    const undone = dropUncheckedWorktree(req.repoPath, worktreePath, branch, head);
    if (error instanceof WorktreeRepointedError) {
      throw new WorktreeRepointedError(error.worktreePath, error.problem, undone);
    }
    if (error instanceof Error) error.message += ` ${undone}.`;
    throw error;
  }
  const { settingsPath, mcpConfigPath } = writeSessionProfile(
    compile,
    req.repoPath,
    worktreePath,
    compiledDir,
  );

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
    repoPath: req.repoPath,
    worktreePath,
    settingsPath,
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

/**
 * Stop a session's window and end it as `killed`, its task back in the
 * backlog (decision 40), or, in a CI fix round, back to `merged` (decision
 * 90): the round's work is abandoned, but the PR it was for is still open, so
 * the session stays landable by `pup land` and in the inbox, its task claimed.
 * Returns the state the session ended in.
 */
export function killSession(db: Database, sessionId: string): 'killed' | 'merged' {
  const row = requireSession(db, sessionId);
  // The pane too, not the name alone: a rename from inside the session would
  // leave the name pointing at nothing while the window ran on.
  killTmux(sessionId, row.tmux_target);
  if (!isTerminal(row.state) && currentFixRound(db, sessionId) !== undefined) {
    // The pane is dead now: a row back in `merged` that kept it would hand a
    // steer or a later kill whatever window holds that id next.
    db.transaction(() => {
      transitionSessionAlong(
        db,
        sessionId,
        { from: row.state, to: FIX_ROUND_EDGE.from },
        { kind: 'fix-round-killed' },
      );
      db.prepare('UPDATE sessions SET tmux_target = NULL WHERE id = ?').run(sessionId);
    })();
    return FIX_ROUND_EDGE.from;
  }
  transitionSession(db, sessionId, 'killed');
  return 'killed';
}

/**
 * How to clear a fix round's surviving worktree, which no git may run inside
 * (decision 90). A command is named only for a minted id: the id is read from
 * the store, and a path built from anything else is no command to hand out.
 */
export function worktreeCleanup(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return 'its row is not minted, so no command is named here; inspect the store';
  }
  const dir = `.worktrees/${sessionId}`;
  return (
    `remove it with \`rm -r ${dir}\` then \`git worktree prune\` from the main checkout ` +
    '(do not run git inside it)'
  );
}

/** What `pup kill` and `pup ui` say when a kill ended a fix round, not the session. */
export function killedFixRoundMessage(sessionId: string): string {
  const id = sanitizeReason(sessionId);
  return (
    `Killed ${id}'s fix round; it is merged again, its PR open for \`pup land\`. Before another ` +
    `\`pup fix\`, its worktree must go: ${worktreeCleanup(sessionId)}. Reset its branch to the ` +
    "PR's head if it carries the round's commits."
  );
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
