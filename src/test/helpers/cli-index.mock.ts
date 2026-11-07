import { chmodSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, vi } from 'vitest';
import { SteerNotDeliveredError } from '../../claude/session-runtime.service.js';
import { resolveProject } from '../../cli/project.utils.js';
import { runGit } from '../../core/git-diff.client.js';
import { insertLedgerEntry } from '../../core/ledger.repository.js';
import { projectId, projectPaths } from '../../core/paths.utils.js';
import { endSandboxRun } from '../../core/sandbox.utils.js';
import {
  appendEvent,
  ensureProject,
  incrementRejectCount,
  insertSession,
  insertTask,
  saveProjectDormantAt,
  transitionSession,
} from '../../core/session.repository.js';
import { STALLED_AFTER_MS } from '../../core/session-activity.constants.js';
import { LaunchRolledBackError } from '../../core/session-lifecycle.errors.js';
import { tempDir } from '../temp-dir.mock.js';

export const HANDOFF_WAIT_DEFAULT_MS = 10 * 60 * 1000;

// Test repos must not inherit the developer's global git config (hooks, signing)
// nor GIT_DIR & co. — when this suite runs inside a git hook (pre-commit), those
// would redirect every git call at the pupitre repo instead of the temp repo.
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/** A repo with no adapter markers (no package.json, pyproject.toml, ...). */
export function initRepo(): string {
  const repo = tempDir('pup-cli-');
  runGit(repo, ['init', '-b', 'main'], { env: GIT_ENV });
  return repo;
}

/** The args of a mock's first call — throws instead of a `!` when it was never called. */
export function firstCall<Args extends unknown[]>(mockFn: (...args: Args) => unknown): Args {
  const call = vi.mocked(mockFn).mock.calls[0];
  if (!call) throw new Error('expected the mock to have been called');
  return call;
}

/** A repo the TypeScript adapter detects, for commands that require one. */
export function initRepoWithAdapter(): string {
  const repo = initRepo();
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(join(repo, 'tsconfig.json'), '{}');
  return repo;
}

/**
 * A `codegraph` on PATH printing `version`, or a PATH with none at all. The
 * capability line reports the operator's machine, so every test that reads it
 * says which machine it is pretending to be (decision 51).
 */
export function stubCodegraph(version?: string): void {
  const dir = tempDir('pup-cli-cg-');
  if (version !== undefined) {
    writeFileSync(join(dir, 'codegraph'), `#!/bin/sh\necho "${version}"\nexit 0\n`, {
      mode: 0o755,
    });
  }
  // `git` stays reachable: `pup init` resolves its project through it.
  vi.stubEnv('PATH', `${dir}:/usr/bin:/bin`);
}

/** Inserts the project/task/session rows a real (unmocked) `getSession` needs. */
export function seedSession(repoPath: string, sessionId: string, worktreePath?: string): void {
  const { db } = resolveProject(repoPath);
  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);
  insertTask(db, { id: `t-${sessionId}`, projectId: pid, spec: '{}' });
  insertSession(db, {
    id: sessionId,
    taskId: `t-${sessionId}`,
    worktreePath: worktreePath ?? join(repoPath, '.worktrees', sessionId),
    branch: `pup/${sessionId}`,
    profileHash: 'hash',
  });
  db.close();
}

/** The seeded session's worktree, created so `git -C` inside it resolves the repo. */
export function worktreeOf(repoPath: string, sessionId: string): string {
  const path = join(repoPath, '.worktrees', sessionId);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Registers the repo in the store the way `pup init` does, with nothing planned. */
export function registerProject(repoPath: string): string {
  const { db } = resolveProject(repoPath);
  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);
  db.close();
  return pid;
}

/** Puts a registered project to sleep, as `pup project dormant` leaves it. */
export function markDormant(repoPath: string, at = '2026-09-21T10:00:00.000Z'): void {
  const { db } = resolveProject(repoPath);
  saveProjectDormantAt(db, projectId(repoPath), at);
  db.close();
}

/** One planned task: a row in the backlog with no session of its own. */
export function seedBacklogTask(repoPath: string, taskId: string, goal: string): void {
  const { db } = resolveProject(repoPath);
  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);
  insertTask(db, {
    id: taskId,
    projectId: pid,
    spec: JSON.stringify({ id: taskId, goal, scopeIn: ['src/**'] }),
  });
  db.close();
}

/** A session whose tmux pane is gone for good — steer/interrupt must refuse it. */
/**
 * What `launchTask` and `createSession` throw once they have undone a launch
 * whose kickoff the window refused: the refusal that stopped it, and the
 * clause naming what was undone. The retry is this front end's to add.
 */
export function rolledBackLaunch(sessionId: string): LaunchRolledBackError {
  return new LaunchRolledBackError(
    `Launch rolled back (session ${sessionId} killed)`,
    new SteerNotDeliveredError(sessionId, 3000),
  );
}

export function seedKilledSession(repoPath: string, sessionId: string): void {
  seedSession(repoPath, sessionId);
  const { db } = resolveProject(repoPath);
  transitionSession(db, sessionId, 'killed');
  db.close();
}

/** A session the gate parked, with the reason and the rejections it recorded. */
export function seedBlockedSession(
  repoPath: string,
  sessionId: string,
  reason: string,
  rejectCount = 3,
): void {
  seedSession(repoPath, sessionId);
  const { db } = resolveProject(repoPath);
  transitionSession(db, sessionId, 'running');
  for (let i = 0; i < rejectCount; i += 1) incrementRejectCount(db, sessionId);
  transitionSession(db, sessionId, 'blocked', { reason, rejectCount });
  db.close();
}

/** Writes a running session's events file with its mtime `ageMs` in the past. */
export function seedEventsFile(repoPath: string, sessionId: string, ageMs: number): void {
  const paths = projectPaths(repoPath);
  mkdirSync(paths.sessionDir(sessionId), { recursive: true });
  const eventsFile = paths.eventsFile(sessionId);
  writeFileSync(eventsFile, `${JSON.stringify({ hook_event_name: 'PostToolUse' })}\n`);
  const time = new Date(Date.now() - ageMs);
  utimesSync(eventsFile, time, time);
}

/**
 * A session's events file with its permissions taken away, which is what makes
 * a whole snapshot throw: the reader stats it, finds it, and cannot read it.
 * Returns the path, for the caller to give its mode back.
 */
export function unreadableEventsFile(repoPath: string, sessionId: string, mode = 0o000): string {
  const eventsFile = projectPaths(repoPath).eventsFile(sessionId);
  mkdirSync(projectPaths(repoPath).sessionDir(sessionId), { recursive: true });
  writeFileSync(eventsFile, `${JSON.stringify({ hook_event_name: 'PostToolUse' })}\n`);
  chmodSync(eventsFile, mode);
  return eventsFile;
}

/**
 * A stalled running session with a pane, as the watchdog finds it: the events
 * file is older than the stall window and the pane was recorded at launch.
 */
export function seedStalledSession(repoPath: string, sessionId: string): void {
  seedSession(repoPath, sessionId);
  const { db } = resolveProject(repoPath);
  db.prepare('UPDATE sessions SET tmux_target = ? WHERE id = ?').run('%7', sessionId);
  transitionSession(db, sessionId, 'running');
  db.close();
  seedEventsFile(repoPath, sessionId, STALLED_AFTER_MS + 60_000);
}

/** The watcher's record of a dead turn for the stall the session is in now. */
export function seedDeadTurn(repoPath: string, sessionId: string, refusal?: string): void {
  const stalledAt = new Date(
    statSync(projectPaths(repoPath).eventsFile(sessionId)).mtimeMs,
  ).toISOString();
  const { db } = resolveProject(repoPath);
  appendEvent(db, sessionId, 'turn_died', {
    reason: '⏺ API Error: Connection lost while your computer was asleep',
    stalledAt,
    ...(refusal ? { refusal } : {}),
  });
  db.close();
}

/** Inserts one open ledger entry (real, unmocked repository) and returns its id. */
export function seedLedgerEntry(
  repoPath: string,
  overrides: { description?: string; reason?: string; acceptedBy?: string; reviewBy?: string } = {},
): number {
  const { db } = resolveProject(repoPath);
  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);
  const id = insertLedgerEntry(db, {
    projectId: pid,
    description: 'shortcut taken',
    files: ['src/a.ts'],
    reason: 'ship the demo',
    acceptedBy: 'human',
    reviewBy: 'before the next release',
    ...overrides,
  });
  db.close();
  return id;
}

// The gate children this file runs outside a gate start a sandbox run the
// gate would have ended, and a test worker exits without the `exit` event
// that ends it otherwise (decision 100).
afterAll(() => {
  endSandboxRun();
});
