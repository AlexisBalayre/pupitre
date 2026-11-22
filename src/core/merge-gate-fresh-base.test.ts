import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  killSession: vi.fn(),
  steerPane: vi.fn(),
}));

// Without this, every merging test would spawn a real `claude -p` call.
vi.mock('../claude/utility.service.js', () => ({
  runUtility: vi.fn(() => ({ ok: false, output: 'mocked out in tests' })),
}));

// The real execFileSync, wrapped so a test can count the git processes a gate
// spawns; every git call still runs for real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

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
import { GateStageStatus } from './enums/gate-stage-status.enums.js';
import { InterruptSignal } from './enums/interrupt-signal.enums.js';
import { MergeStatus } from './enums/merge-status.enums.js';
import { SessionState } from './enums/session-state.enums.js';
import { runMergeGate } from './merge-gate.service.js';
import { getSession } from './session.repository.js';
import { HELD_SLOT_ENV } from './test-slot.service.js';
import type { GateStageResult } from './types/merge-gate.types.js';

describe('fresh-base on a branch no open PR holds (decision 190)', { timeout: 20_000 }, () => {
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

    expect(outcome.status).toBe(MergeStatus.Merged);
    expect(freshBase(outcome.report.stages)).toMatchObject({
      status: GateStageStatus.Pass,
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

    expect(outcome.status).toBe(MergeStatus.Merged);
    expect(freshBase(outcome.report.stages)).toMatchObject({
      status: GateStageStatus.Pass,
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

    expect(outcome.status).toBe(MergeStatus.Rejected);
    expect(outcome.rejectCount).toBe(1);
    expect(getSession(db, SESSION_ID)?.state).toBe(SessionState.Running);
    const stage = freshBase(outcome.report.stages);
    expect(stage?.status).toBe(GateStageStatus.Fail);
    expect(stage?.detail).toContain('Auto-merge of main hit conflicts');
    expect(stage?.detail).toContain('`git merge refs/heads/main`');
    expect(vi.mocked(steerPane).mock.calls[0]?.[1]).toContain('git merge refs/heads/main');
    expect(revParse(repo, 'main')).toBe(target);
    expect(revParse(repo, BRANCH)).toBe(resolved);
    expect(sh(worktree, 'git', 'status', '--porcelain').trim()).toBe('');
  });

  /**
   * Throw `failure` from the first git call whose argv `matches`, after running
   * it for real when `runFirst`, as a Ctrl-C landing once it has done its work.
   */
  const failGit = (
    matches: (args: string[]) => boolean,
    failure: { message: string; signal: string | null; status: number | null },
    runFirst: boolean,
  ): void => {
    const real = vi.mocked(execFileSync).getMockImplementation();
    let done = false;
    vi.mocked(execFileSync).mockImplementation(((file: string, args: string[], opts: object) => {
      if (!done && file === 'git' && matches(args)) {
        done = true;
        if (runFirst) {
          try {
            real?.(file, args, opts as never);
          } catch {
            // the failure below stands for this one
          }
        }
        throw Object.assign(new Error(failure.message), failure);
      }
      return real?.(file, args, opts as never);
    }) as never);
    onTestFinished(() => {
      vi.mocked(execFileSync).mockImplementation(real as never);
    });
  };

  /** A branch whose rebase onto main conflicts while its merge with main is clean. */
  const conflictingRebase = (): { worktree: string; tip: string; target: string } => {
    const worktree = seedSession(db, repo);
    commitIn(repo, 'src/app.ts', 'export const app = 2;\n');
    commitIn(worktree, 'src/app.ts', 'export const app = 3;\n');
    commitIn(worktree, 'src/app.ts', 'export const app = 1;\n');
    return { worktree, tip: revParse(worktree, 'HEAD'), target: revParse(repo, 'main') };
  };

  const isRebase = (args: string[]): boolean =>
    args.includes('rebase') && !args.includes('--abort');
  const isAbort = (args: string[]): boolean => args.includes('rebase') && args.includes('--abort');
  const interrupt = {
    message: 'Command failed: git rebase',
    signal: InterruptSignal.Sigint,
    status: null,
  };

  // With `runFirst`, the killed git does its work first: the rebase stops on its
  // conflict and its abort succeeds, so only the interrupt check stands between
  // the Ctrl-C and a clean merge that lands. A rebase killed before it starts
  // leaves nothing to abort, so the abort fails too and only the interrupt check
  // on the rebase's own error keeps the Ctrl-C from a fail steered to the worker.
  // A killed abort is thrown before it runs, its own error carrying the signal.
  it.each([
    ['the rebase', isRebase, true],
    ['the rebase before it starts', isRebase, false],
    ['the abort of a conflicting rebase', isAbort, false],
  ])('rethrows an interrupt that kills %s, merging nothing', async (_, matches, runFirst) => {
    const { tip, target } = conflictingRebase();
    failGit(matches, interrupt, runFirst);

    await expect(merge()).rejects.toThrow('Command failed: git rebase');

    expect(vi.mocked(steerPane)).not.toHaveBeenCalled();
    expect(revParse(repo, BRANCH)).toBe(tip);
    expect(revParse(repo, 'main')).toBe(target);
  });

  it('fails fresh-base without merging when the abort of a conflicting rebase fails', async () => {
    const { tip, target } = conflictingRebase();
    failGit(
      isAbort,
      { message: 'Command failed: git rebase --abort', signal: null, status: 128 },
      false,
    );

    const outcome = await merge();

    expect(outcome.status).toBe(MergeStatus.Rejected);
    const stage = freshBase(outcome.report.stages);
    expect(stage?.status).toBe(GateStageStatus.Fail);
    expect(stage?.detail).toContain('Auto-rebase onto main failed and so did its abort');
    // The rebase stopped on its conflict and nothing aborted it: its dir is named.
    expect(stage?.detail).toMatch(/rebase-merge is left in this worktree's git dir/);
    expect(stage?.detail).toContain('`git merge refs/heads/main`');
    // `pup merge`, `pup review` and a blocked session show it to unsandboxed readers.
    expect(stage?.detail).toContain('Anyone else should inspect that state without running git');
    // The advice, not the failed commands' own output it quotes after it.
    expect(stage?.detail?.split('\n')[0]).not.toMatch(/rebase --abort/);
    expect(revParse(repo, BRANCH)).toBe(tip);
    expect(revParse(repo, 'main')).toBe(target);
  });

  it('spends no more ancestry checks on 30 merges off the target than on 1', async () => {
    /** The gate's `--is-ancestor` processes on a stale branch holding `merges` side merges. */
    const ancestryChecks = async (merges: number): Promise<number> => {
      db = openStore(':memory:');
      repo = initRepo();
      const worktree = seedSession(db, repo);
      // A commit of the branch's own first, so no merge has a parent on main.
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      for (let side = 0; side < merges; side++) {
        sh(worktree, 'git', 'checkout', '-q', '-b', `side-${side}`, BRANCH);
        commitIn(worktree, `src/side-${side}.ts`, `export const side${side} = 1;\n`);
        sh(worktree, 'git', 'checkout', '-q', BRANCH);
        sh(worktree, 'git', 'merge', '-q', '--no-ff', '--no-edit', `side-${side}`);
      }
      commitIn(repo, 'README.md', '# hello\n');
      vi.mocked(execFileSync).mockClear();

      const outcome = await merge();

      // No merge of the target among them, so the branch is still rebased.
      expect(freshBase(outcome.report.stages)).toMatchObject({
        status: GateStageStatus.Pass,
        detail: 'auto-rebased onto main',
      });
      return vi
        .mocked(execFileSync)
        .mock.calls.filter(([, args]) => (args as string[] | undefined)?.includes('--is-ancestor'))
        .length;
    };

    expect(await ancestryChecks(30)).toBe(await ancestryChecks(1));
  }, 120_000);
});
