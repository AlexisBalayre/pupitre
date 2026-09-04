import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { detectAdapters } from '../adapters/adapter.registry.js';
import {
  kickoff,
  killSession as killTmux,
  launchSession,
  transcriptDir,
} from '../claude/session-runtime.service.js';
import { buildCodeMap, buildKnowledgeSlice } from './code-map.service.js';
import { scrubbedGitEnv } from './git-diff.client.js';
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
  transitionSession,
} from './session.repository.js';
import { TaskAlreadyClaimedError, UnknownTaskError } from './session-lifecycle.errors.js';
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
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repoPath, ...args], {
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
  task.knowledgeSlice = knowledgeSliceFor(db, req.repoPath, pid, task.scopeIn);
  return startSession(db, { ...req, task });
}

/**
 * Plan and launch in one step — the assembly line behind `pup new`, unchanged
 * from the operator's side. Returns the created session id.
 */
export function createSession(db: Database, req: NewSessionRequest): string {
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
  const compiled = compileProfile({
    base: req.base,
    role: req.role,
    task: req.task,
    sessionId: sessionId as SessionId,
    worktreePath,
    eventsFile: paths.eventsFile(sessionId),
    userConfigHash,
    outDir: compiledDir,
  });
  git(req.repoPath, 'worktree', 'add', '-b', branch, worktreePath, 'HEAD');
  writeCompiledProfile(compiled, compiledDir);

  insertSession(db, {
    id: sessionId,
    taskId: req.task.id,
    worktreePath,
    branch,
    profileHash: compiled.hash,
    transcriptPath: transcriptDir(worktreePath),
  });

  const { target } = launchSession({
    sessionId,
    worktreePath,
    settingsPath: join(compiledDir, 'settings.json'),
    model: req.model,
  });
  db.prepare('UPDATE sessions SET tmux_target = ? WHERE id = ?').run(target, sessionId);
  transitionSession(db, sessionId, 'running', { profileHash: compiled.hash });

  // Deliver the compiled task context as the opening prompt once the UI is ready.
  const started = kickoff(sessionId, compiled.contextMarkdown);
  appendEvent(db, sessionId, 'steer', { kind: 'kickoff', delivered: started });
  return sessionId;
}

/** Mark a session done (run by the agent via `pup session done`). */
export function markSessionDone(db: Database, sessionId: string, summary: string): void {
  appendEvent(db, sessionId, 'session_done', { summary });
  transitionSession(db, sessionId, 'awaiting-review', { summary });
}

export function killSession(db: Database, sessionId: string): void {
  const row = getSession(db, sessionId);
  if (!row) throw new Error(`No session ${sessionId}.`);
  killTmux(sessionId);
  transitionSession(db, sessionId, 'killed');
}
