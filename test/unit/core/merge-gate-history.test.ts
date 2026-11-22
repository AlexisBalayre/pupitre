import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

vi.mock('@src/claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/claude/session-runtime.service.js')>()),
  killSession: vi.fn(),
  steerPane: vi.fn(),
}));

// Without this, every merging test would spawn a real `claude -p` call.
vi.mock('@src/claude/utility.service.js', () => ({
  runUtility: vi.fn(() => ({ ok: false, output: 'mocked out in tests' })),
}));

import { openStore } from '@src/core/db.client.js';
import { getDecisionRecord } from '@src/core/decision-record.repository.js';
import { GateStageStatus } from '@src/core/enums/gate-stage-status.enums.js';
import { MergeStatus } from '@src/core/enums/merge-status.enums.js';
import { runMergeGate } from '@src/core/merge-gate.service.js';
import { projectId } from '@src/core/paths.utils.js';
import { TOOLCHAIN_CACHE_DIRNAME } from '@src/core/sandbox.utils.js';
import { HELD_SLOT_ENV } from '@src/core/test-slot.service.js';
import {
  BRANCH,
  commitIn,
  GIT_ENV,
  passingAdapter,
  SESSION_ID,
  seedSession,
  sh,
  untimed,
} from '@test/helpers/merge-gate.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';

/**
 * `info/grafts` and `shallow` sit in the shared git dir, which a session can
 * write and no diff shows, and each rewrites a commit's parents for any git
 * that reads them. Re-parenting the target's tip onto the branch tip empties
 * the three-dot diff and the `target..tip` log; cutting the branch tip off its
 * base leaves the log one commit long. The gate's reads take neither: the
 * scope audit, the ADR-number check and the commit subjects read the real
 * history (decision 205, under decision 89's pins).
 */
describe('the merge gate under a planted info/grafts or shallow file', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    repo = tempDir('pup-gate-history-');
    onTestFinished(() => {
      rmSync(join(tmpdir(), TOOLCHAIN_CACHE_DIRNAME, projectId(repo)), {
        recursive: true,
        force: true,
      });
    });
    sh(repo, 'git', 'init', '-b', 'main');
    sh(repo, 'git', 'config', 'user.email', 'gate@test');
    sh(repo, 'git', 'config', 'user.name', 'gate-test');
    commitIn(repo, 'src/app.ts', 'export const app = 1;\n');
    commitIn(repo, 'docs/adr/0001-existing.md', '# 0001\n');
    // Newer than any branch commit, as a target tip is once the branch forks:
    // with a parent the graft dates after it, plain git's merge-base walk can
    // stop before it meets the branch, and the control would read no base.
    execFileSync('git', ['commit', '-q', '--amend', '--no-edit'], {
      cwd: repo,
      env: { ...GIT_ENV, GIT_COMMITTER_DATE: '4000000000 +0000' },
    });
    // As inside a slot already held, so a gate here never queues behind the
    // machine's real test runs (decision 96).
    vi.stubEnv(HELD_SLOT_ENV, 'merge-gate-history.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const tipOf = (ref: string) => sh(repo, 'git', 'rev-parse', ref).trim();

  /** Main's tip re-parented onto the branch tip: the branch reads as merged. */
  const plantGrafts = () => {
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'info', 'grafts'), `${tipOf('main')} ${tipOf(BRANCH)}\n`);
  };

  /** The branch tip listed as a shallow edge: it reads as a root commit. */
  const plantShallow = () => {
    writeFileSync(join(repo, '.git', 'shallow'), `${tipOf(BRANCH)}\n`);
  };

  const merge = () =>
    runMergeGate(db, { repoPath: repo, sessionId: SESSION_ID, adapters: [passingAdapter] });

  const stage = (outcome: Awaited<ReturnType<typeof merge>>, name: string) =>
    untimed(outcome.report.stages).find((s) => s.stage === name);

  // The controls: each plant bends what a plain git in the checkout reads.
  it('is a grafts file that empties a plain diff and log of the branch', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    commitIn(worktree, 'notes.txt', 'off-scope\n');
    plantGrafts();

    expect(sh(repo, 'git', 'diff', '--name-only', `main...${BRANCH}`)).toBe('');
    expect(sh(repo, 'git', 'log', '--format=%s', `main..${BRANCH}`)).toBe('');
  });

  it('is a shallow file that cuts a plain log of the branch to its tip', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    commitIn(worktree, 'notes.txt', 'off-scope\n');
    plantShallow();

    expect(sh(repo, 'git', 'log', '--format=%s', `main..${BRANCH}`)).toBe('edit notes.txt\n');
    expect(() => sh(repo, 'git', 'diff', '--name-only', `main...${BRANCH}`)).toThrow(
      /no merge base/,
    );
  });

  it.each([
    ['info/grafts', () => plantGrafts()],
    ['shallow', () => plantShallow()],
  ])('refuses an ADR number the target holds past a planted %s', async (_, plant) => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'docs/adr/**'] });
    commitIn(worktree, 'docs/adr/0001-mine.md', '# 0001 mine\n');
    plant();

    const outcome = await merge();

    expect(outcome).toMatchObject({ status: MergeStatus.Refused, rejectCount: 0 });
    expect(stage(outcome, 'adr-number')).toEqual({
      stage: 'adr-number',
      status: GateStageStatus.Fail,
      detail:
        'ADR numbers already taken:\n' +
        '  docs/adr/0001-mine.md: decision 0001 is already on the target; renumber it 0002, ' +
        'the lowest free number',
    });
  });

  it.each([
    ['info/grafts', () => plantGrafts()],
    ['shallow', () => plantShallow()],
  ])('audits the scope of every change past a planted %s', async (_, plant) => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    commitIn(worktree, 'notes.txt', 'off-scope\n');
    plant();

    const outcome = await merge();

    expect(outcome).toMatchObject({ status: MergeStatus.Rejected, rejectCount: 1 });
    expect(stage(outcome, 'scope-audit')).toEqual({
      stage: 'scope-audit',
      status: GateStageStatus.Fail,
      detail: 'Out-of-scope changes:\n  notes.txt (outside scope-in)',
    });
  });

  it.each([
    ['info/grafts', () => plantGrafts()],
    ['shallow', () => plantShallow()],
  ])('merges past a planted %s, recording every commit of the branch', async (_, plant) => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    commitIn(worktree, 'src/more.ts', 'export const more = 1;\n');
    const tip = tipOf(BRANCH);
    plant();

    const outcome = await merge();

    expect(outcome.status).toBe(MergeStatus.Merged);
    expect(tipOf('main')).toBe(tip);
    const record = getDecisionRecord(db, outcome.decisionRecordId as number);
    expect(record?.summary).toContain('edit src/feature.ts | edit src/more.ts');
  });
});
