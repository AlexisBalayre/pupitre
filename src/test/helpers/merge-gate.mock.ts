import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { onTestFinished } from 'vitest';
import type { Adapter } from '../../adapters/types/adapter.types.js';
import {
  ensureProject,
  insertSession,
  insertTask,
  listEvents,
  transitionSession,
} from '../../core/session.repository.js';
import type { GateStageResult } from '../../core/types/merge-gate.types.js';
import type { TaskId, TaskSpec } from '../../core/types/profile.types.js';
import { tempDir } from '../temp-dir.mock.js';

// Test repos must not inherit the developer's global git config (hooks, signing)
// nor GIT_DIR & co. — when this suite runs inside a git hook (pre-commit), those
// would redirect every git call at the pupitre repo instead of the temp repo.
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0] as string, args.slice(1), { cwd, encoding: 'utf8', env: GIT_ENV });
}

export function initRepo(): string {
  const repo = tempDir('pup-gate-');
  sh(repo, 'git', 'init', '-b', 'main');
  sh(repo, 'git', 'config', 'user.email', 'gate@test');
  sh(repo, 'git', 'config', 'user.name', 'gate-test');
  commitIn(repo, 'src/app.ts', 'export const app = 1;\n');
  return repo;
}

export function commitIn(dir: string, file: string, content: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', 'commit', '-m', `edit ${file}`);
}

export const SESSION_ID = 's1';
export const BRANCH = `pup/${SESSION_ID}`;
/** The pane `launchSession` would have recorded for the seeded session. */
export const LAUNCH_PANE = '%4';

export function seedSession(db: Database, repo: string, spec: Partial<TaskSpec> = {}): string {
  ensureProject(db, 'proj-1', repo);
  const taskId = `task-${SESSION_ID}`;
  const fullSpec: TaskSpec = {
    id: taskId as TaskId,
    goal: 'test goal',
    scopeIn: ['src/**'],
    acceptance: ['done'],
    ...spec,
  };
  insertTask(db, { id: taskId, projectId: 'proj-1', spec: JSON.stringify(fullSpec) });
  const worktree = join(repo, '.worktrees', SESSION_ID);
  sh(repo, 'git', 'worktree', 'add', '-b', BRANCH, worktree, 'HEAD');
  insertSession(db, {
    id: SESSION_ID,
    taskId,
    worktreePath: worktree,
    branch: BRANCH,
    profileHash: 'hash',
    tmuxTarget: LAUNCH_PANE,
  });
  transitionSession(db, SESSION_ID, 'running');
  transitionSession(db, SESSION_ID, 'awaiting-review');
  return worktree;
}

/**
 * Where the gate cuts its detached checkout of the pinned sha (decision 81),
 * named after its root so its admin dir is its own (decision 101).
 */
export const GATE_CHECKOUT = new RegExp(
  `^${realpathSync(tmpdir()).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')}/(pup-gate-checkout-[^/]+)/\\1$`,
);

/** The reason the last transition into `blocked` recorded, as the gate wrote it. */
export function blockedReason(db: Database): string | undefined {
  const rows = listEvents(db, SESSION_ID).map(
    (event) => JSON.parse(event.payload) as { to?: string; reason?: string },
  );
  return rows.filter((payload) => payload.to === 'blocked').at(-1)?.reason;
}

export const passingAdapter: Adapter = {
  id: 'fake',
  detect: () => true,
  gateCommands: () => [
    { stage: 'build', command: 'true', args: [] },
    { stage: 'test', command: 'true', args: [] },
    { stage: 'lint', command: 'true', args: [] },
  ],
};

export const failingBuildAdapter: Adapter = {
  id: 'fake',
  detect: () => true,
  gateCommands: () => [{ stage: 'build', command: 'false', args: [] }],
};

export function debtAdapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    ...passingAdapter,
    deadCode: () => [],
    duplication: () => ({ duplicatedLines: 0, blocks: [] }),
    complexity: () => [],
    ...overrides,
  };
}

/** A report's stages without the wall times, which differ run to run (decision 95). */
export function untimed(stages: GateStageResult[]): GateStageResult[] {
  return stages.map(({ durationMs: _, ...stage }) => stage);
}

/** Pretend to be another platform for one test; `process.platform` is a plain property. */
export function onPlatform(platform: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', original);
  });
}
