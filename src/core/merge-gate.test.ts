import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../claude/session-runtime.service.js', () => ({
  killSession: vi.fn(),
  steerSession: vi.fn(),
}));

// Without this, every merging test would spawn a real `claude -p` call.
vi.mock('../claude/utility.service.js', () => ({
  runUtility: vi.fn(() => ({ ok: false, output: 'mocked out in tests' })),
}));

import type { Adapter } from '../adapters/types/adapter.types.js';
import { killSession, steerSession } from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { listDecisionRecords } from './decision-record.repository.js';
import { insertLedgerEntry, listLedgerEntries } from './ledger.repository.js';
import { MergeLockHeldError, SessionNotReviewableError } from './merge-gate.errors.js';
import { runMergeGate } from './merge-gate.service.js';
import {
  ensureProject,
  getSession,
  incrementRejectCount,
  insertSession,
  insertTask,
  transitionSession,
} from './session.repository.js';
import type { TaskId, TaskSpec } from './types/profile.types.js';

// Test repos must not inherit the developer's global git config (hooks, signing)
// nor GIT_DIR & co. — when this suite runs inside a git hook (pre-commit), those
// would redirect every git call at the pupitre repo instead of the temp repo.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0] as string, args.slice(1), { cwd, encoding: 'utf8', env: GIT_ENV });
}

function initRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-gate-')));
  sh(repo, 'git', 'init', '-b', 'main');
  sh(repo, 'git', 'config', 'user.email', 'gate@test');
  sh(repo, 'git', 'config', 'user.name', 'gate-test');
  commitIn(repo, 'src/app.ts', 'export const app = 1;\n');
  return repo;
}

function commitIn(dir: string, file: string, content: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', 'commit', '-m', `edit ${file}`);
}

const SESSION_ID = 's1';
const BRANCH = `pup/${SESSION_ID}`;

function seedSession(db: Database, repo: string, spec: Partial<TaskSpec> = {}): string {
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
  });
  transitionSession(db, SESSION_ID, 'running');
  transitionSession(db, SESSION_ID, 'awaiting-review');
  return worktree;
}

const passingAdapter: Adapter = {
  id: 'fake',
  detect: () => true,
  gateCommands: () => [
    { stage: 'build', command: 'true', args: [] },
    { stage: 'test', command: 'true', args: [] },
    { stage: 'lint', command: 'true', args: [] },
  ],
};

const failingBuildAdapter: Adapter = {
  id: 'fake',
  detect: () => true,
  gateCommands: () => [{ stage: 'build', command: 'false', args: [] }],
};

// Real git repos + worktrees per test — generous timeout so machine load can't flake it.
describe('runMergeGate', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    repo = initRepo();
  });

  const merge = (adapter = passingAdapter, acceptDebt?: { reason: string; reviewBy: string }) =>
    runMergeGate(db, { repoPath: repo, sessionId: SESSION_ID, adapter, acceptDebt });

  it('merges a clean in-scope branch ff-only and cleans everything up', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

    const outcome = merge();

    expect(outcome.status).toBe('merged');
    expect(sh(repo, 'git', 'log', '--oneline', 'main')).toContain('edit src/feature.ts');
    expect(getSession(db, SESSION_ID)?.state).toBe('merged');
    expect(
      (
        db.prepare('SELECT status FROM tasks WHERE id = ?').get(`task-${SESSION_ID}`) as {
          status: string;
        }
      ).status,
    ).toBe('done');
    expect(killSession).toHaveBeenCalledWith(SESSION_ID);
    expect(existsSync(worktree)).toBe(false);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH).trim()).toBe('');
    expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
  });

  it('writes a decision record for the merged files even when the draft utility fails', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

    const outcome = merge();

    expect(outcome.status).toBe('merged');
    const [record] = listDecisionRecords(db, 'src/feature.ts');
    expect(record?.session_id).toBe(SESSION_ID);
    expect(record?.summary).toContain('test goal');
    expect(JSON.parse(record?.files ?? '[]')).toEqual(['src/feature.ts']);
    // The CLI's one-keystroke approval needs the id of the record just drafted.
    expect(outcome.decisionRecordId).toBe(record?.id);
  });

  it('auto-rebases a stale branch and merges with linear history', () => {
    const worktree = seedSession(db, repo);
    commitIn(repo, 'README.md', '# hello\n');
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

    const outcome = merge();

    expect(outcome.status).toBe('merged');
    expect(outcome.report.stages).toContainEqual(
      expect.objectContaining({ stage: 'fresh-base', detail: 'auto-rebased onto main' }),
    );
    const log = sh(repo, 'git', 'log', '--oneline', 'main');
    expect(log).toContain('edit README.md');
    expect(log).toContain('edit src/feature.ts');
  });

  it('re-steers the session with the report when the auto-rebase conflicts', () => {
    const worktree = seedSession(db, repo);
    commitIn(repo, 'src/app.ts', 'export const app = 2;\n');
    commitIn(worktree, 'src/app.ts', 'export const app = 3;\n');

    const outcome = merge();

    expect(outcome.status).toBe('rejected');
    expect(outcome.rejectCount).toBe(1);
    expect(getSession(db, SESSION_ID)?.state).toBe('running');
    expect(vi.mocked(steerSession).mock.calls[0]?.[1]).toContain('rebase');
  });

  it('rejects on a build failure and stops the pipeline there', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

    const outcome = merge(failingBuildAdapter);

    expect(outcome.status).toBe('rejected');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'build', status: 'fail' });
    expect(outcome.report.stages.map((s) => s.stage)).not.toContain('scope-audit');
    expect(steerSession).toHaveBeenCalled();
  });

  it('hard-fails changes outside the task scope', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'notes.txt', 'off-scope\n');

    const outcome = merge();

    expect(outcome.status).toBe('rejected');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'scope-audit', status: 'fail' });
    expect(outcome.report.stages.at(-1)?.detail).toContain('notes.txt');
  });

  it('hard-fails a protected .claude path even when git would C-quote its name', () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, '.claude/café.md', 'smuggled hook config\n');

    const outcome = merge();

    expect(outcome.status).toBe('rejected');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'scope-audit', status: 'fail' });
    expect(outcome.report.stages.at(-1)?.detail).toContain('café.md (protected path)');
  });

  it('resolves gate commands from the trusted main checkout, not the session worktree', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const resolvedFrom: string[] = [];
    const recordingAdapter: Adapter = {
      id: 'fake',
      detect: () => true,
      gateCommands: (repoPath) => {
        resolvedFrom.push(repoPath);
        return passingAdapter.gateCommands(repoPath);
      },
    };

    merge(recordingAdapter);

    expect(resolvedFrom).toEqual([repo]);
  });

  it('fails preflight when the worktree is dirty', () => {
    const worktree = seedSession(db, repo);
    writeFileSync(join(worktree, 'src/uncommitted.ts'), 'export const x = 1;\n');

    const outcome = merge();

    expect(outcome.status).toBe('rejected');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'worktree-clean', status: 'fail' });
  });

  it('flags open debt entries whose files the merged diff touched, but never its own', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));
    const openId = insertLedgerEntry(db, {
      projectId: 'proj-1',
      description: 'shortcut in feature.ts',
      files: ['src/feature.ts'],
      reason: 'r',
      acceptedBy: 'human',
      reviewBy: 'c',
    });
    insertLedgerEntry(db, {
      projectId: 'proj-1',
      description: 'unrelated shortcut',
      files: ['src/other.ts'],
      reason: 'r',
      acceptedBy: 'human',
      reviewBy: 'c',
    });

    const outcome = merge(passingAdapter, { reason: 'deadline', reviewBy: 'before v2' });

    expect(outcome.status).toBe('merged');
    expect(outcome.debtCandidates).toEqual([{ id: openId, description: 'shortcut in feature.ts' }]);
  });

  it('refuses an oversize diff without --accept-debt and leaves the session reviewable', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));

    const outcome = merge();

    expect(outcome.status).toBe('refused');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'diff-size', status: 'flagged' });
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    expect(getSession(db, SESSION_ID)?.reject_count).toBe(0);
    expect(steerSession).not.toHaveBeenCalled();
  });

  it('merges an oversize diff with --accept-debt and writes a ledger entry', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));

    const outcome = merge(passingAdapter, { reason: 'deadline', reviewBy: 'before v2' });

    expect(outcome.status).toBe('merged');
    const [entry] = listLedgerEntries(db, 'proj-1');
    expect(entry).toMatchObject({ reason: 'deadline', review_by: 'before v2', status: 'open' });
    expect(JSON.parse(entry?.files ?? '[]')).toContain('src/big.ts');
  });

  it('counts a lockfile-named file outside the repo root toward the diff size', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/pnpm-lock.yaml', 'generated: line\n'.repeat(700));

    const outcome = merge();

    expect(outcome.status).toBe('refused');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'diff-size', status: 'flagged' });
  });

  it('parks the session as blocked once the reject cap is reached', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    incrementRejectCount(db, SESSION_ID);
    incrementRejectCount(db, SESSION_ID);

    const outcome = merge(failingBuildAdapter);

    expect(outcome.status).toBe('blocked');
    expect(outcome.rejectCount).toBe(3);
    expect(getSession(db, SESSION_ID)?.state).toBe('blocked');
    expect(steerSession).not.toHaveBeenCalled();
  });

  it('blocks instead of rejecting when the re-steer cannot be delivered', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    vi.mocked(steerSession).mockImplementationOnce(() => {
      throw new Error('no tmux session');
    });

    const outcome = merge(failingBuildAdapter);

    expect(outcome.status).toBe('blocked');
    expect(getSession(db, SESSION_ID)?.state).toBe('blocked');
  });

  it('refuses to run while another merge holds the lock', () => {
    seedSession(db, repo);
    mkdirSync(join(repo, '.git', 'pup-merge.lock'));

    expect(() => merge()).toThrow(MergeLockHeldError);
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
  });

  it('throws for a session that is not awaiting review', () => {
    seedSession(db, repo);
    transitionSession(db, SESSION_ID, 'running');

    expect(() => merge()).toThrow(SessionNotReviewableError);
  });
});
