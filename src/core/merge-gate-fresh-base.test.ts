import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  killSession: vi.fn(),
  steerPane: vi.fn(),
}));

// Without this, every merging test would spawn a real `claude -p` call.
vi.mock('../claude/utility.service.js', () => ({
  runUtility: vi.fn(() => ({ ok: false, output: 'mocked out in tests' })),
}));

import {
  BRANCH,
  commitIn,
  initRepo,
  passingAdapter,
  SESSION_ID,
  seedSession,
  sh,
} from '@test/helpers/merge-gate.mock.js';
import { steerPane } from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { runMergeGate } from './merge-gate.service.js';
import { getSession } from './session.repository.js';
import { HELD_SLOT_ENV } from './test-slot.service.js';
import type { GateStageResult } from './types/merge-gate.types.js';

describe('fresh-base on a branch no open PR holds (decision 188)', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(steerPane).mockReset();
    db = openStore(':memory:');
    repo = initRepo();
    // As inside a slot already held, so a gate here never queues behind the
    // machine's real test runs (decision 96).
    vi.stubEnv(HELD_SLOT_ENV, 'merge-gate-fresh-base.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const merge = () =>
    runMergeGate(db, { repoPath: repo, sessionId: SESSION_ID, adapters: [passingAdapter] });

  const freshBase = (stages: GateStageResult[]): GateStageResult | undefined =>
    stages.find((stage) => stage.stage === 'fresh-base');

  const parents = (dir: string, rev: string): string[] =>
    sh(dir, 'git', 'rev-list', '--parents', '-n', '1', rev).trim().split(' ').slice(1);

  const revParse = (dir: string, rev: string): string => sh(dir, 'git', 'rev-parse', rev).trim();

  /**
   * The worker's `git merge main` over a conflict on `src/app.ts`, resolved to
   * `resolution` and committed, as a session waiting for its first gate does.
   */
  const mergeMainResolving = (worktree: string, resolution: string): void => {
    expect(() => sh(worktree, 'git', 'merge', '--no-edit', 'main')).toThrow();
    writeFileSync(join(worktree, 'src/app.ts'), resolution);
    sh(worktree, 'git', 'add', 'src/app.ts');
    sh(worktree, 'git', 'commit', '--no-edit');
  };

  it('keeps a merge of the target the worker resolved, taking the moved target as a merge', async () => {
    const worktree = seedSession(db, repo);
    commitIn(repo, 'src/app.ts', 'export const app = 2;\n');
    commitIn(worktree, 'src/app.ts', 'export const app = 3;\n');
    mergeMainResolving(worktree, 'export const app = 23;\n');
    const resolved = revParse(worktree, 'HEAD');
    // Main moves again, cleanly against the merge: a rebase would replay
    // `app = 3` over `app = 2` and hit the conflict the merge resolved.
    commitIn(repo, 'README.md', '# hello\n');
    const movedMain = revParse(repo, 'main');

    const outcome = await merge();

    expect(outcome.status).toBe('merged');
    expect(freshBase(outcome.report.stages)).toMatchObject({
      status: 'pass',
      detail: 'auto-merged main',
    });
    expect(parents(repo, 'main')).toEqual([resolved, movedMain]);
    expect(readFileSync(join(repo, 'src/app.ts'), 'utf8')).toBe('export const app = 23;\n');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# hello\n');
  });

  it('takes the target as a merge when the rebase conflicts and the merge is clean', async () => {
    const worktree = seedSession(db, repo);
    commitIn(repo, 'src/app.ts', 'export const app = 2;\n');
    // Changed and changed back: the rebase replays the first over `app = 2`
    // and conflicts, while the branch's net change to the file is none.
    commitIn(worktree, 'src/app.ts', 'export const app = 3;\n');
    commitIn(worktree, 'src/app.ts', 'export const app = 1;\n');
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const tip = revParse(worktree, 'HEAD');
    const target = revParse(repo, 'main');

    const outcome = await merge();

    expect(outcome.status).toBe('merged');
    expect(freshBase(outcome.report.stages)).toMatchObject({
      status: 'pass',
      detail: 'auto-merged main after the auto-rebase hit conflicts',
    });
    expect(parents(repo, 'main')).toEqual([tip, target]);
    expect(readFileSync(join(repo, 'src/app.ts'), 'utf8')).toBe('export const app = 2;\n');
    expect(readFileSync(join(repo, 'src/feature.ts'), 'utf8')).toBe('export const feature = 1;\n');
  });

  it('rejects a branch whose merge with the target conflicts, steering a merge and leaving it as it was', async () => {
    const worktree = seedSession(db, repo);
    commitIn(repo, 'src/app.ts', 'export const app = 2;\n');
    commitIn(worktree, 'src/app.ts', 'export const app = 3;\n');
    mergeMainResolving(worktree, 'export const app = 23;\n');
    const resolved = revParse(worktree, 'HEAD');
    commitIn(repo, 'src/app.ts', 'export const app = 4;\n');
    const target = revParse(repo, 'main');

    const outcome = await merge();

    expect(outcome.status).toBe('rejected');
    expect(outcome.rejectCount).toBe(1);
    expect(getSession(db, SESSION_ID)?.state).toBe('running');
    const stage = freshBase(outcome.report.stages);
    expect(stage?.status).toBe('fail');
    expect(stage?.detail).toContain('Auto-merge of main hit conflicts');
    expect(stage?.detail).toContain('`git merge refs/heads/main`');
    expect(vi.mocked(steerPane).mock.calls[0]?.[1]).toContain('git merge refs/heads/main');
    expect(revParse(repo, 'main')).toBe(target);
    expect(revParse(repo, BRANCH)).toBe(resolved);
    expect(sh(worktree, 'git', 'status', '--porcelain').trim()).toBe('');
  });
});
