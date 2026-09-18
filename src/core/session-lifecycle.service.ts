import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { detectAdapters } from '../adapters/adapter.registry.js';
import {
  interruptPane,
  kickoff,
  killSession as killTmux,
  launchSession,
  type SessionPane,
  SessionPaneMissingError,
  steerPane,
  transcriptDir,
} from '../claude/session-runtime.service.js';
import { buildCodeMap, buildKnowledgeSlice } from './code-map.service.js';
import { codegraphBinary, prepareGraph } from './codegraph.client.js';
import { assertNoArmedGitDrivers, GIT_SAFE_CONFIG, scrubbedGitEnv } from './git-diff.client.js';
import { scopeConflicts } from './overlap.service.js';
import { projectId, projectPaths } from './paths.utils.js';
import {
  compileProfile,
  snapshotUserConfigHash,
  writeCompiledProfile,
} from './profile-compiler.service.js';
import {
  appendEvent,
  claimingSession,
  ensureProject,
  getSession,
  getTask,
  insertSession,
  insertTask,
  type SessionRow,
  transitionSession,
} from './session.repository.js';
import {
  ScopeConflictError,
  TaskAlreadyClaimedError,
  UnknownTaskError,
} from './session-lifecycle.errors.js';
import { assertPlannableSpec } from './task-spec.utils.js';
import type { SessionId, TaskId, TaskSpec } from './types/profile.types.js';
import type {
  LaunchTaskRequest,
  NewSessionRequest,
  PlanTaskRequest,
} from './types/session-lifecycle.types.js';

/** A short, filesystem- and tmux-safe id derived from the task id and a counter. */
function sessionSlug(taskId: string, existing: number): string {
  const stem = taskId.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 24);
  return existing === 0 ? stem : `${stem}-${existing}`;
}

function git(repoPath: string, ...args: string[]): string {
  // Hooks off and the GIT_DIR family scrubbed: `worktree add` fires
  // post-checkout, and a hook planted by an earlier session lives in the shared
  // common dir, untracked (decision 28).
  return execFileSync('git', [...GIT_SAFE_CONFIG, '-C', repoPath, ...args], {
    encoding: 'utf8',
    env: scrubbedGitEnv(),
  }).trim();
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
  // The row key wins over the blob: identity comes from the trusted primary
  // key, the spec is authoritative only for intent. A spec whose `id` had
  // drifted would compile one task's hooks under another task's session row,
  // leaving the gate auditing a different spec than the hooks enforce.
  const task: TaskSpec = { ...(JSON.parse(row.spec) as TaskSpec), id: row.id as TaskId };
  // The conflict check is now the first thing to read a stored spec's globs, so
  // it runs after the same validation `pup plan add` did. A row written before
  // that validation existed would otherwise reach `scopedPaths` with no
  // `scopeIn` and throw a bare TypeError, where `compileProfile` used to raise
  // a legible InvalidProfileError.
  assertPlannableSpec(task);
  // Before `git worktree add`, which checks out every file in HEAD and runs a
  // smudge filter on each one with the operator's environment. The shared
  // config and `info/attributes` arm it, `.git/**` is untracked, and the
  // driver name is chosen by whoever wrote it, so there is nothing to disarm
  // — only a refusal (decision 50).
  assertNoArmedGitDrivers(req.repoPath);
  // Admission control, not a report: the radar notices two sessions in one file
  // 15 seconds after both are already editing it, which is too late to be a
  // decision. Measured before the worktree exists so a refusal costs nothing,
  // and always measured, so `--allow-overlap` records what it waved through
  // rather than skipping the question (decision 41).
  const conflicts = scopeConflicts(db, req.repoPath, task.scopeIn, task.scopeOut);
  if (conflicts.length > 0 && !req.allowOverlap) {
    throw new ScopeConflictError(row.id, conflicts);
  }
  task.knowledgeSlice = knowledgeSliceFor(db, req.repoPath, pid, task.scopeIn);
  const sessionId = startSession(db, { ...req, task });
  if (conflicts.length > 0) {
    appendEvent(db, sessionId, 'scope_overlap', {
      via: req.overlapVia ?? 'operator',
      accepted: conflicts.map((conflict) => ({
        session: conflict.sessionId,
        files: conflict.files,
      })),
    });
  }
  return sessionId;
}

/**
 * Plan and launch in one step — the assembly line behind `pup new`, unchanged
 * from the operator's side. Returns the created session id.
 */
export function createSession(db: Database, req: NewSessionRequest): string {
  // Both refusals are asked before the row is written, not only inside
  // `launchTask`, and for the same reason. A refusal costs an operator nothing
  // on `pup launch`, where the task already existed, but here it would leave
  // the spec they just abandoned sitting in the backlog — unclaimed,
  // attributed to them, and listed as planned work until someone notices and
  // drops it (decision 41).
  assertNoArmedGitDrivers(req.repoPath);
  const conflicts = scopeConflicts(db, req.repoPath, req.task.scopeIn, req.task.scopeOut);
  if (conflicts.length > 0 && !req.allowOverlap) {
    throw new ScopeConflictError(req.task.id, conflicts);
  }
  planTask(db, req);
  // Decided once, above. `launchTask` re-measures for its own `pup launch` path
  // and for the `scope_overlap` record, but must not re-decide: a holder that
  // appears in the window between the two reads would otherwise refuse after
  // the row exists, which is the orphan this function was reordered to prevent.
  return launchTask(db, {
    ...req,
    taskId: req.task.id,
    allowOverlap: true,
    overlapVia: req.allowOverlap ? (req.overlapVia ?? 'operator') : 'raced',
  });
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

function startSession(db: Database, req: LaunchTaskRequest & { task: TaskSpec }): string {
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
  });
  git(req.repoPath, 'worktree', 'add', '-b', branch, worktreePath, 'HEAD');
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
  });

  const pane = launchSession({
    sessionId,
    worktreePath,
    settingsPath: join(compiledDir, 'settings.json'),
    model: req.model,
    mcpConfigPath,
  });
  // The pane id, not the session name: every later steer is addressed to it
  // (decision 46), so it is stored before anything is typed into it.
  db.prepare('UPDATE sessions SET tmux_target = ? WHERE id = ?').run(pane.paneId, sessionId);
  transitionSession(db, sessionId, 'running', { profileHash: compiled.hash });

  // Deliver the compiled task context as the opening prompt once the UI is ready.
  const started = kickoff(pane, compiled.contextMarkdown);
  appendEvent(db, sessionId, 'steer', { kind: 'kickoff', delivered: started });
  return sessionId;
}

/** Mark a session done (run by the agent via `pup session done`). */
export function markSessionDone(db: Database, sessionId: string, summary: string): void {
  appendEvent(db, sessionId, 'session_done', { summary });
  transitionSession(db, sessionId, 'awaiting-review', { summary });
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
 * Steer a session by id, into the pane recorded at its launch. The session
 * half of `steerPane`: resolves the row, refuses one with no pane recorded,
 * and lets the runtime's own refusals (a gone pane, a paste that never landed)
 * through untouched for the caller to print.
 */
export function steerSession(db: Database, sessionId: string, message: string): void {
  steerPane(sessionPane(requireSession(db, sessionId)), message);
}

/** Send Escape to a session's launch pane; see `steerSession` for the shape. */
export function interruptSession(db: Database, sessionId: string): void {
  interruptPane(sessionPane(requireSession(db, sessionId)));
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
  if (!row) throw new Error(`No session ${sessionId}.`);
  return row;
}
