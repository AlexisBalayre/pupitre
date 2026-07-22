import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStore } from './db.client.js';
import { buildReviewQueue, buildSessionReview } from './review.service.js';
import {
  appendEvent,
  ensureProject,
  incrementRejectCount,
  insertSession,
  insertTask,
  transitionSession,
} from './session.repository.js';
import type { TaskId, TaskSpec } from './types/profile.types.js';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0] as string, args.slice(1), { cwd, encoding: 'utf8', env: GIT_ENV });
}

function initRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-review-')));
  sh(repo, 'git', 'init', '-b', 'main');
  sh(repo, 'git', 'config', 'user.email', 'review@test');
  sh(repo, 'git', 'config', 'user.name', 'review-test');
  commitIn(repo, 'src/app.ts', 'export const app = 1;\n');
  return repo;
}

function commitIn(dir: string, file: string, content: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', 'commit', '-m', `edit ${file}`);
}

function seedSession(
  db: Database,
  repo: string,
  sessionId: string,
  state: 'running' | 'awaiting-review' = 'awaiting-review',
): string {
  ensureProject(db, 'proj-1', repo);
  const taskId = `task-${sessionId}`;
  const spec: TaskSpec = {
    id: taskId as TaskId,
    goal: `goal for ${sessionId}`,
    scopeIn: ['src/**'],
    acceptance: ['done'],
  };
  insertTask(db, { id: taskId, projectId: 'proj-1', spec: JSON.stringify(spec) });
  const worktree = join(repo, '.worktrees', sessionId);
  sh(repo, 'git', 'worktree', 'add', '-b', `pup/${sessionId}`, worktree, 'HEAD');
  insertSession(db, {
    id: sessionId,
    taskId,
    worktreePath: worktree,
    branch: `pup/${sessionId}`,
    profileHash: 'hash',
  });
  transitionSession(db, sessionId, 'running');
  if (state === 'awaiting-review') transitionSession(db, sessionId, 'awaiting-review');
  return worktree;
}

describe('review service', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = initRepo();
  });

  it('queues only awaiting-review sessions, riskiest first', () => {
    const big = seedSession(db, repo, 's-big');
    commitIn(big, 'src/big.ts', 'const line = 1;\n'.repeat(400));
    const small = seedSession(db, repo, 's-small');
    commitIn(small, 'src/small.ts', 'export const small = 1;\n');
    const running = seedSession(db, repo, 's-running', 'running');
    commitIn(running, 'src/other.ts', 'export const other = 1;\n');

    const queue = buildReviewQueue(db, repo);

    expect(queue.map((e) => e.sessionId)).toEqual(['s-big', 's-small']);
    expect(queue[0]?.changedLines).toBe(400);
    expect(queue[0]?.risk).toBeGreaterThan(queue[1]?.risk ?? 0);
  });

  it('counts overlap when another live session touches the same file', () => {
    const first = seedSession(db, repo, 's-first');
    commitIn(first, 'src/shared.ts', 'export const shared = 1;\n');
    const second = seedSession(db, repo, 's-second', 'running');
    commitIn(second, 'src/shared.ts', 'export const shared = 2;\n');

    const [entry] = buildReviewQueue(db, repo);

    expect(entry?.sessionId).toBe('s-first');
    expect(entry?.overlaps).toBe(1);
  });

  it('raises the risk score for logged scope violations and past rejections', () => {
    const worktree = seedSession(db, repo, 's-risky');
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    appendEvent(db, 's-risky', 'scope_violation', { path: 'docs/oops.md' });
    incrementRejectCount(db, 's-risky');

    const [entry] = buildReviewQueue(db, repo);

    expect(entry?.scopeViolations).toBe(1);
    expect(entry?.rejectCount).toBe(1);
    expect(entry?.risk).toBeGreaterThanOrEqual(5);
  });

  it('returns spec, per-file stats, and the last gate report in the detail view', () => {
    const worktree = seedSession(db, repo, 's-detail');
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\nexport const extra = 2;\n');
    const report = {
      sessionId: 's-detail',
      passed: false,
      stages: [{ stage: 'build', status: 'fail' as const, detail: 'boom' }],
    };
    appendEvent(db, 's-detail', 'gate_result', { report });

    const detail = buildSessionReview(db, repo, 's-detail');

    expect(detail.spec.goal).toBe('goal for s-detail');
    expect(detail.files).toEqual([{ path: 'src/feature.ts', added: 2, deleted: 0 }]);
    expect(detail.lastGateReport).toEqual(report);
    expect(detail.state).toBe('awaiting-review');
  });

  it('throws for a session that is not live', () => {
    seedSession(db, repo, 's-gone');
    transitionSession(db, 's-gone', 'killed');

    expect(() => buildSessionReview(db, repo, 's-gone')).toThrow('No live session');
  });

  it('shows detail for a blocked session so a human can unblock it', () => {
    const worktree = seedSession(db, repo, 's-blocked');
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    transitionSession(db, 's-blocked', 'rejected');
    transitionSession(db, 's-blocked', 'blocked');

    const detail = buildSessionReview(db, repo, 's-blocked');

    expect(detail.state).toBe('blocked');
    expect(detail.entry.sessionId).toBe('s-blocked');
  });
});
