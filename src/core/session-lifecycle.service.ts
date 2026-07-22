import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  kickoff,
  killSession as killTmux,
  launchSession,
  transcriptDir,
} from '../claude/session-runtime.service.js';
import { projectId, projectPaths } from './paths.utils.js';
import {
  compileProfile,
  snapshotUserConfigHash,
  writeCompiledProfile,
} from './profile-compiler.service.js';
import {
  appendEvent,
  ensureProject,
  getSession,
  insertSession,
  insertTask,
  transitionSession,
} from './session.repository.js';
import type { ProfileLayer, SessionId, TaskSpec } from './types/profile.types.js';

export interface NewSessionRequest {
  repoPath: string;
  base: ProfileLayer;
  role?: ProfileLayer;
  task: TaskSpec;
  claudeUserDir: string;
  model?: string;
}

/** A short, filesystem- and tmux-safe id derived from the task id and a counter. */
function sessionSlug(taskId: string, existing: number): string {
  const stem = taskId.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 24);
  return existing === 0 ? stem : `${stem}-${existing}`;
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();
}

/**
 * Compile a profile, create an isolated worktree, launch the session, and record
 * it — the assembly line behind `pup new`. Returns the created session id.
 */
export function createSession(db: Database, req: NewSessionRequest): string {
  const pid = projectId(req.repoPath);
  const paths = projectPaths(req.repoPath);
  ensureProject(db, pid, req.repoPath);

  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE task_id = ?').get(req.task.id) as {
      n: number;
    }
  ).n;
  const sessionId = sessionSlug(req.task.id, count) as unknown as string;
  const branch = `pup/${sessionId}`;
  const worktreePath = join(req.repoPath, '.worktrees', sessionId);
  const compiledDir = paths.compiledDir(sessionId);

  git(req.repoPath, 'worktree', 'add', '-b', branch, worktreePath, 'HEAD');

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
  writeCompiledProfile(compiled, compiledDir);

  insertTask(db, {
    id: req.task.id,
    projectId: pid,
    spec: JSON.stringify(req.task),
    role: req.role?.name,
  });
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
