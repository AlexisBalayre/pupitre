import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
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

// Wraps the real execFileSync (every git call in this suite still runs for
// real) so a test can inspect the stdio options a specific call was made with,
// and the real spawn every gate stage runs through, so a test can count them.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), spawn: vi.fn(actual.spawn) };
});

// The real rmSync, wrapped so a test can make the gate checkout's removal fail,
// and the real writeFileSync, so one can fail the merge lock's pid write.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    rmSync: vi.fn(actual.rmSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

// The real loadavg, wrapped so a gate asked to wait never waits on this
// machine's load (decision 88).
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, loadavg: vi.fn(actual.loadavg) };
});

// Shortened by the one test that runs a stage out of its timeout.
const gateTimeout = vi.hoisted(() => ({ ms: undefined as number | undefined }));
vi.mock('./merge-gate.constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./merge-gate.constants.js')>();
  return {
    ...actual,
    get GATE_COMMAND_TIMEOUT_MS() {
      return gateTimeout.ms ?? actual.GATE_COMMAND_TIMEOUT_MS;
    },
  };
});

// Set by the one test that swaps the worktree's gitfile around every check, as
// a session racing the gate would: each check reads the trusted pointer, each
// git call after it finds the swapped one.
const pointerSwap = vi.hoisted(() => ({
  around: undefined as ((check: () => void) => void) | undefined,
}));
vi.mock('./git-diff.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-diff.client.js')>();
  return {
    ...actual,
    verifiedWorktreeGitEnv: (repoPath: string, worktreePath: string) => {
      let env = undefined as ReturnType<typeof actual.verifiedWorktreeGitEnv> | undefined;
      const check = () => {
        env = actual.verifiedWorktreeGitEnv(repoPath, worktreePath);
      };
      pointerSwap.around ? pointerSwap.around(check) : check();
      return env as ReturnType<typeof actual.verifiedWorktreeGitEnv>;
    },
  };
});

// Shortened by the one test of a gate that runs out its wait for a test slot.
const slotWait = vi.hoisted(() => ({ ms: undefined as number | undefined }));
vi.mock('./test-slot.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./test-slot.service.js')>();
  return {
    ...actual,
    get GATE_SLOT_WAIT_MS() {
      return slotWait.ms ?? actual.GATE_SLOT_WAIT_MS;
    },
  };
});

import {
  BRANCH,
  commitIn,
  debtAdapter,
  failingBuildAdapter,
  GIT_ENV,
  initRepo,
  LAUNCH_PANE,
  onPlatform,
  passingAdapter,
  SESSION_ID,
  seedSession,
  sh,
  untimed,
} from '@test/helpers/merge-gate.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { formatDuration } from '../adapters/capability.utils.js';
import type { Adapter, CapabilityContext } from '../adapters/types/adapter.types.js';
import { killSession, steerPane } from '../claude/session-runtime.service.js';
import { runUtility } from '../claude/utility.service.js';
import { openStore } from './db.client.js';
import { listDecisionRecords } from './decision-record.repository.js';
import { initProject } from './init.service.js';
import { insertLedgerEntry, listLedgerEntries } from './ledger.repository.js';
import { DUPLICATION_RULE_ID } from './merge-gate.constants.js';
import {
  MergeLockHeldError,
  MergeLockLostError,
  SessionNotReviewableError,
} from './merge-gate.errors.js';
import {
  countChangedLines,
  firstOwnSubject,
  pullRequestText,
  runMergeGate as runGate,
  waitForLoad,
  withMergeLock,
} from './merge-gate.service.js';
import { GateInterruptedError, UndeclaredSandboxError } from './sandbox.utils.js';
import {
  appendEvent,
  getProject,
  getSession,
  listEvents,
  saveProjectBaseline,
  saveProjectOriginUrl,
} from './session.repository.js';
import { GATE_SLOT_WAIT_MS, HELD_SLOT_ENV } from './test-slot.service.js';
import type { DebtBaseline, ProjectBaseline } from './types/init.types.js';
import type { MergeOutcome } from './types/merge-gate.types.js';
import type { TaskId } from './types/profile.types.js';

describe('runMergeGate', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;
  /** Where the fake gh records its argv, so a test can assert what it was asked to do. */
  let ghLog: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clearing keeps a queued once-implementation; a test whose gate never
    // steers would otherwise hand its throwing steer to the next one that does.
    vi.mocked(steerPane).mockReset();
    db = openStore(':memory:');
    repo = initRepo();
    ghLog = join(tempDir('pup-ghlog-'), 'calls');
    // As inside a slot already held, so a gate here never queues behind the
    // machine's real test runs; the slot tests clear it (decision 96).
    vi.stubEnv(HELD_SLOT_ENV, 'merge-gate.test');
  });

  /**
   * Every gate a test started that has not settled. The stages run
   * asynchronously (decision 95), so a test that runs out its timeout leaves
   * its gate running, and without a wait it would run on into the next test's
   * repo, mocks and environment: one slow test would fail the ones after it.
   */
  const unsettled = new Set<Promise<unknown>>();
  const runMergeGate = (...args: Parameters<typeof runGate>): ReturnType<typeof runGate> => {
    const gate = runGate(...args);
    unsettled.add(gate);
    const forget = (): boolean => unsettled.delete(gate);
    void gate.then(forget, forget);
    return gate;
  };

  // Before the env goes, and before any `onTestFinished` reset, which vitest
  // runs after this: the gate finishes under the test that started it.
  afterEach(async () => {
    await Promise.allSettled(unsettled);
    vi.unstubAllEnvs();
  }, 120_000);

  const merge = (
    adapters: Adapter | Adapter[] = passingAdapter,
    acceptDebt?: { reason: string; reviewBy: string },
  ) =>
    runMergeGate(db, {
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: Array.isArray(adapters) ? adapters : [adapters],
      acceptDebt: acceptDebt && { acceptedBy: 'human', ...acceptDebt },
    });

  /** Stamped with the current rule by default, so the stage compares (decision 39). */
  const seedDebtBaseline = (debt: DebtBaseline) =>
    saveProjectBaseline(
      db,
      'proj-1',
      ['fake'],
      JSON.stringify({
        capturedAt: 'now',
        adapters: ['fake'],
        stages: [],
        debt: { duplicationRule: DUPLICATION_RULE_ID, ...debt },
      }),
    );

  // A realistic coverableFiles: source, not tests, not assets.
  const coverableFiles = (_ctx: CapabilityContext, files: string[]): string[] =>
    files.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  const ORIGIN_URL = 'git@github.com:owner/repo.git';

  // Origin is GitHub-shaped so the --repo pin can be derived. A rewrite in the
  // operator's global config, which the pinned push still honours, lands it in
  // a local bare repo so the gate's real `git push` stays offline. Recording
  // the URL on the project row is what the operator's `pup init` would have
  // done at setup; without it the gate refuses to push anywhere (decision 56).
  const addOrigin = (): string => {
    const host = tempDir('pup-origin-');
    const bare = join(host, 'owner', 'repo.git');
    mkdirSync(bare, { recursive: true });
    sh(bare, 'git', 'init', '--bare', '-b', 'main');
    sh(repo, 'git', 'remote', 'add', 'origin', ORIGIN_URL);
    saveProjectOriginUrl(db, 'proj-1', ORIGIN_URL);
    const globalConfig = join(host, 'gitconfig');
    writeFileSync(globalConfig, `[url "${host}/"]\n\tinsteadOf = git@github.com:\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    return bare;
  };

  const withFakeGh = async <TResult>(
    script: string,
    fn: () => TResult | Promise<TResult>,
  ): Promise<TResult> => {
    const ghDir = tempDir('pup-gh-');
    writeFileSync(join(ghDir, 'gh'), script, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${ghDir}:${originalPath}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = originalPath;
    }
  };

  /**
   * Fake gh: answers the `pr list` probe with `openPrs`, records every argv in
   * `ghLog`, and echoes `pr create`'s argv as the PR URL so the created-PR
   * tests can assert on the wiring. `pr view` reports the PR's head as `head`,
   * or else as whatever the branch holds in the repo its `--repo` names, read
   * from outside the repo so only the operator's global rewrite applies, and
   * the PR as `state` onto main.
   */
  const fakeGh = (openPrs: unknown[], head?: string, state = 'OPEN'): string =>
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${ghLog}`,
      '[ "$1" = "--version" ] && exit 0',
      `if [ "$2" = "list" ]; then echo '${JSON.stringify(openPrs)}'; exit 0; fi`,
      'if [ "$2" = "view" ]; then',
      head === undefined
        ? `  head=$(cd / && git ls-remote "git@\${5%%/*}:\${5#*/}.git" refs/heads/${BRANCH} | cut -f1)`
        : `  head=${head}`,
      `  printf '{"headRefOid":"%s","state":"${state}","baseRefName":"main"}\\n' "$head"; exit 0`,
      'fi',
      'cat >/dev/null',
      'echo "$@"',
    ].join('\n');

  const ghCalls = (): string[] =>
    existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean) : [];

  const openPrOnMain = {
    url: 'https://github.com/owner/repo/pull/7',
    baseRefName: 'main',
    isCrossRepository: false,
  };

  /**
   * A second GitHub-shaped URL under the same rewrite `addOrigin` installs, so
   * it resolves to a local bare repo like origin does. Shaped that way on
   * purpose: a target `originRepoSlug` would refuse anyway, or one no rewrite
   * can reach, would make a refusal test pass for a reason other than the one
   * it is testing.
   */
  const secondRemote = (bare: string, owner: string, name: string): string => {
    const path = join(dirname(dirname(bare)), owner, `${name}.git`);
    mkdirSync(path, { recursive: true });
    sh(path, 'git', 'init', '--bare', '-b', 'main');
    return path;
  };

  // The target is read before the lock and the session outlives the stages, so
  // the merge must run against the branch the gate was asked to move, or not at
  // all; and what it recorded must be what the ref says (decision 79).
  it('refuses when the main checkout changed branch during the stages, recording nothing', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    sh(repo, 'git', 'branch', 'elsewhere');
    // `gateCommands` runs in-process after the target was read and before the
    // merge: the one seam a test can move the main checkout from, standing in
    // for a session that does it while the stages run.
    const movingAdapter: Adapter = {
      ...passingAdapter,
      gateCommands: (repoPath) => {
        sh(repoPath, 'git', 'checkout', '-q', 'elsewhere');
        return passingAdapter.gateCommands(repoPath);
      },
    };

    await expect(merge(movingAdapter)).rejects.toThrow(/moved from main to elsewhere/);

    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    expect(sh(repo, 'git', 'rev-parse', 'main').trim()).not.toBe(
      sh(worktree, 'git', 'rev-parse', 'HEAD').trim(),
    );
    expect(existsSync(worktree)).toBe(true);
  });

  describe('off darwin (decision 78)', () => {
    it('refuses before running any child unless the operator declared the VM', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', undefined);
      vi.mocked(execFileSync).mockClear();
      vi.mocked(spawn).mockClear();

      await expect(merge()).rejects.toThrow(UndeclaredSandboxError);
      await expect(merge()).rejects.toThrow(/PUP_SANDBOX=vm/);
      // Not a git call, not a stage: nothing was spawned at all.
      expect(execFileSync).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    it('runs the gate under the declaration and names it in the report', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', 'vm');

      const outcome = await merge();

      expect(outcome.status).toBe('merged');
      expect(outcome.report.sandbox).toBe('vm (declared by operator)');
    });

    it('treats any value but vm as no declaration', async () => {
      seedSession(db, repo);
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', 'yes');

      await expect(merge()).rejects.toThrow(UndeclaredSandboxError);
    });
  });

  it('writes a decision record for the merged files even when the draft utility fails', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

    const outcome = await merge();

    expect(outcome.status).toBe('merged');
    const [record] = listDecisionRecords(db, 'src/feature.ts');
    expect(record?.session_id).toBe(SESSION_ID);
    expect(record?.summary).toContain('test goal');
    expect(JSON.parse(record?.files ?? '[]')).toEqual(['src/feature.ts']);
    // The CLI's one-keystroke approval needs the id of the record just drafted.
    expect(outcome.decisionRecordId).toBe(record?.id);
  });

  it('auto-rebases a stale branch and merges with linear history', async () => {
    const worktree = seedSession(db, repo);
    commitIn(repo, 'README.md', '# hello\n');
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

    const outcome = await merge();

    expect(outcome.status).toBe('merged');
    expect(outcome.report.stages).toContainEqual(
      expect.objectContaining({ stage: 'fresh-base', detail: 'auto-rebased onto main' }),
    );
    const log = sh(repo, 'git', 'log', '--oneline', 'main');
    expect(log).toContain('edit README.md');
    expect(log).toContain('edit src/feature.ts');
  });

  it('re-steers the session with the report when the auto-rebase conflicts', async () => {
    const worktree = seedSession(db, repo);
    commitIn(repo, 'src/app.ts', 'export const app = 2;\n');
    commitIn(worktree, 'src/app.ts', 'export const app = 3;\n');

    const outcome = await merge();

    expect(outcome.status).toBe('rejected');
    expect(outcome.rejectCount).toBe(1);
    expect(getSession(db, SESSION_ID)?.state).toBe('running');
    // Into the pane recorded at launch, never a session target (decision 46).
    expect(vi.mocked(steerPane).mock.calls[0]?.[0]).toEqual({
      sessionId: SESSION_ID,
      paneId: LAUNCH_PANE,
    });
    expect(vi.mocked(steerPane).mock.calls[0]?.[1]).toContain('rebase');
  });

  it('hard-fails a session that edits the adapter escape-hatch config', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, '.pupitre/adapter.yml', 'test: echo ok\n');

    const outcome = await merge();

    expect(outcome.status).toBe('rejected');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'scope-audit', status: 'fail' });
    expect(outcome.report.stages.at(-1)?.detail).toContain('.pupitre/adapter.yml (protected path)');
  });

  it('merges an oversize diff with --accept-debt and writes a ledger entry', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));

    const outcome = await merge(passingAdapter, { reason: 'deadline', reviewBy: 'before v2' });

    expect(outcome.status).toBe('merged');
    const [entry] = listLedgerEntries(db, 'proj-1');
    expect(entry).toMatchObject({ reason: 'deadline', review_by: 'before v2', status: 'open' });
    expect(JSON.parse(entry?.files ?? '[]')).toContain('src/big.ts');
  });

  it('leaves a root lockfile out of the diff size', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'pnpm-lock.yaml'] });
    commitIn(worktree, 'pnpm-lock.yaml', 'generated: line\n'.repeat(700));

    const outcome = await merge();

    expect(outcome.status).toBe('merged');
    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '0 source + 0 test + 0 docs changed lines',
    });
  });

  // Decision 110: only source lines count toward the flag, and the detail
  // names the split.
  it('counts test files and docs/ apart from source and passes on source alone', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'docs/**'] });
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n'.repeat(227));
    commitIn(worktree, 'src/feature.test.ts', 'const line = 1;\n'.repeat(300));
    commitIn(worktree, 'src/other.test.ts', 'const line = 1;\n'.repeat(60));
    commitIn(worktree, 'docs/feature.md', 'A line of prose.\n'.repeat(85));

    const outcome = await merge();

    expect(outcome.status).toBe('merged');
    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '227 source + 360 test + 85 docs changed lines',
    });
  });

  // A `*.test.ts` that holds one test passes vitest, so production code could
  // live in it and import it; whatever code reaches counts as source. The
  // gate's filesystem (APFS) opens a specifier in any case.
  it('counts a test file production code imports as source, by any specifier', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.test.ts', 'export const v = 1;\n'.repeat(5));
    commitIn(worktree, 'src/use.ts', "export { v } from './big.test.js';\n");
    commitIn(worktree, 'src/dyn.test.ts', 'export const d = 1;\n'.repeat(2));
    commitIn(worktree, 'src/dyn.ts', "export const m = await import('#lib/dyn.test.js');\n");
    commitIn(worktree, 'src/caps.test.ts', 'export const c = 1;\n'.repeat(2));
    commitIn(worktree, 'src/caps.ts', "export * from './CAPS.Test.TS';\n");

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '12 source + 0 test + 0 docs changed lines',
    });
  });

  it('follows test files re-exporting one another to production code', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/helper.test.ts', 'export const h = 1;\n'.repeat(3));
    commitIn(worktree, 'src/b.test.ts', "export * from './helper.test.js';\n");
    commitIn(worktree, 'src/a.test.ts', "export * from './b.test.js';\n");
    commitIn(worktree, 'src/use.ts', "export * from './a.test.js';\n");

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '6 source + 0 test + 0 docs changed lines',
    });
  });

  // A Vue component or a Vite entry loads a module as code does, its `src`
  // quoted or not; prose under docs/ loads nothing.
  it('reads every file naming a test but prose under docs/', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'docs/**'] });
    commitIn(worktree, 'src/big.test.ts', 'export const v = 1;\n'.repeat(5));
    commitIn(
      worktree,
      'src/App.vue',
      '<script setup lang="ts">import { v } from \'./big.test.js\';</script>\n',
    );
    commitIn(worktree, 'src/page.test.ts', 'export const p = 1;\n'.repeat(2));
    commitIn(worktree, 'src/index.html', '<script type="module" src="./page.test.ts"></script>\n');
    commitIn(worktree, 'src/bare.test.ts', 'export const b = 1;\n'.repeat(2));
    commitIn(worktree, 'src/bare.html', '<script type=module src=./bare.test.ts></script>\n');
    commitIn(worktree, 'src/quiet.test.ts', 'const q = 1;\n'.repeat(3));
    commitIn(worktree, 'docs/guide.md', 'See `./quiet.test.js`.\n');

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '12 source + 3 test + 1 docs changed lines',
    });
  });

  it('keeps a test file only other tests import as test', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/helper.test.ts', 'export const h = 1;\n'.repeat(3));
    commitIn(worktree, 'src/a.test.ts', "import { h } from './helper.test.js';\n");

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '0 source + 4 test + 0 docs changed lines',
    });
  });

  it('flags a source diff over the line flag whatever its tests add', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(601));
    commitIn(worktree, 'src/big.test.ts', 'const line = 1;\n'.repeat(50));

    const outcome = await merge();

    expect(outcome.status).toBe('refused');
    const stage = outcome.report.stages.find((s) => s.stage === 'diff-size');
    expect(stage?.status).toBe('flagged');
    expect(stage?.detail).toContain(
      '601 source + 50 test + 0 docs changed lines: source exceeds the 600-line flag',
    );
  });

  it('refuses to run while another merge holds the lock', async () => {
    seedSession(db, repo);
    mkdirSync(join(repo, '.git', 'pup-merge.lock'));

    await expect(merge()).rejects.toThrow(MergeLockHeldError);
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
  });

  // A session moving the lock away mid-gate lets another run in: the merge
  // happened, so the error carries the whole outcome `pup merge` prints
  // before it fails (decision 88).
  it('fails a gate whose lock was moved away while it ran, carrying its merged outcome', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const lock = join(repo, '.git', 'pup-merge.lock');
    const movingTheLock: Adapter = {
      ...passingAdapter,
      duplication: () => {
        renameSync(lock, `${lock}.moved`);
        return { duplicatedLines: 0, blocks: [] };
      },
    };

    const error = await merge(movingTheLock).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(MergeLockLostError);
    const outcome = (error as MergeLockLostError<MergeOutcome>).result;
    expect(outcome.status).toBe('merged');
    expect(outcome.report.passed).toBe(true);
    expect(sh(repo, 'git', 'log', '--oneline', 'main')).toContain('edit src/feature.ts');
  });

  it('refuses a branch that introduces a new unused export', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    seedDebtBaseline({ deadExports: [], duplicatedLines: 0 });
    const adapter = debtAdapter({
      deadCode: () => [{ file: 'src/feature.ts', exportName: 'feature' }],
    });

    const outcome = await merge(adapter);

    expect(outcome.status).toBe('refused');
    expect(outcome.report.stages).toContainEqual(
      expect.objectContaining({
        stage: 'dead-code',
        status: 'flagged',
        detail: expect.stringContaining('src/feature.ts#feature'),
      }),
    );
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
  });

  /**
   * A renamed file, and a copy of a file the branch never changed, each grown
   * by 40 decision points; the adapter counts `if (` in what it reads, and
   * with `omitBefore` returns nothing at the target, as a partial custom
   * command can.
   */
  const seedRenameAndCopy = ({ omitBefore = false } = {}): Adapter => {
    const plain = (name: string) =>
      Array.from({ length: 60 }, (_, i) => `export const ${name}${i} = ${i};\n`).join('');
    const branches = (n: number) => 'if (a) b();\n'.repeat(n);
    commitIn(repo, 'src/legacy.ts', plain('legacy') + branches(10));
    commitIn(repo, 'src/kept.ts', plain('kept') + branches(10));
    const worktree = seedSession(db, repo);
    sh(worktree, 'git', 'mv', 'src/legacy.ts', 'src/renamed.ts');
    commitIn(worktree, 'src/renamed.ts', plain('legacy') + branches(50));
    commitIn(worktree, 'src/copied.ts', plain('kept') + branches(50));
    return debtAdapter({
      complexity: ({ measurePath }: CapabilityContext, files: string[]) =>
        omitBefore && measurePath === repo
          ? []
          : files
              .filter((file) => existsSync(join(measurePath, file)))
              .map((file) => ({
                file,
                complexity: readFileSync(join(measurePath, file), 'utf8').split('if (').length - 1,
              })),
    });
  };

  const complexityDetail = (outcome: Awaited<ReturnType<typeof merge>>) =>
    outcome.report.stages.find((s) => s.stage === 'complexity')?.detail;

  // Decision 145: judged by their rise from the source, not by the new-file cap.
  it('judges a renamed and a copied file by their rise from the source', async () => {
    const outcome = await merge(seedRenameAndCopy());

    expect(complexityDetail(outcome)).toContain(
      'complexity rose sharply in 2 touched file(s): src/copied.ts (+40), src/renamed.ts (+40)',
    );
  });

  // Decision 145: `-C -C` compares every added file with every file the target
  // holds, so it runs under a deadline rather than for as long as a branch of
  // generated files makes it.
  it('judges without copy pairs, and says so, when copy detection runs out of time', async () => {
    const adapter = seedRenameAndCopy();
    const { execFileSync: real } =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    // `-C -C` side by side: every git call already carries `-C <cwd>`.
    const copyPass = (args: unknown) =>
      Array.isArray(args) && args.includes('--raw') && args.join('\0').includes('\0-C\0-C\0');
    vi.mocked(execFileSync).mockImplementation(((
      file: string,
      args: readonly string[],
      options: object,
    ) => {
      if (copyPass(args)) {
        throw Object.assign(new Error('spawnSync git ETIMEDOUT'), {
          code: 'ETIMEDOUT',
          signal: 'SIGTERM',
        });
      }
      return real(file, args, options);
    }) as unknown as typeof execFileSync);
    onTestFinished(() => {
      vi.mocked(execFileSync).mockImplementation(real);
    });

    const outcome = await merge(adapter);

    // The rename still pairs; the copy meets the cap, which 50 does not pass.
    expect(complexityDetail(outcome)).toContain(
      'complexity rose sharply in 1 touched file(s): src/renamed.ts (+40); ' +
        "copies not paired: git's copy detection ran past 30 s",
    );
    const copyCall = vi.mocked(execFileSync).mock.calls.find(([, args]) => copyPass(args));
    expect(copyCall?.[2]).toMatchObject({ timeout: 30_000 });
  });

  // Decision 157: a custom command that returns nothing at the target must not
  // turn an existing file into a new one the cap lets through.
  it('judges a file the target holds by its rise even when the before-measure omits it', async () => {
    const branches = (n: number) => 'if (a) b();\n'.repeat(n);
    commitIn(repo, 'src/kept.ts', 'export const kept = 1;\n');
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/kept.ts', branches(20));
    commitIn(worktree, 'src/fresh.ts', branches(20));
    const adapter = debtAdapter({
      complexity: ({ measurePath }: CapabilityContext, files: string[]) =>
        measurePath === repo
          ? []
          : files.map((file) => ({
              file,
              complexity: readFileSync(join(measurePath, file), 'utf8').split('if (').length - 1,
            })),
    });

    const outcome = await merge(adapter);

    // The new file's 20 stays under the cap; the existing file's 20 is a rise.
    expect(complexityDetail(outcome)).toContain(
      'complexity rose sharply in 1 touched file(s): src/kept.ts (+20).',
    );
  });

  // Decision 157: a renamed or copied file whose source the target holds is not
  // new either, though the before-measure omits the source and the new path is
  // absent from the target. Both land at exactly the cap, which would pass.
  it('judges a rename and a copy by their source in the target tree when the before-measure omits it', async () => {
    const outcome = await merge(seedRenameAndCopy({ omitBefore: true }));

    expect(complexityDetail(outcome)).toContain(
      'complexity rose sharply in 2 touched file(s): src/copied.ts (+50), src/renamed.ts (+50).',
    );
  });

  // Decision 72: `pup init` always measured every detected adapter while the
  // gate measured only the first, so in a TypeScript+Python repo the second
  // stack's debt was never gated and the ratchet then overwrote the
  // all-adapter bar with a partial one.
  describe('a repo two adapters detected', () => {
    /** A second stack whose debt lives in files the first one never reads. */
    const secondAdapter = (overrides: Partial<Adapter> = {}): Adapter => ({
      ...debtAdapter(),
      id: 'fake-second',
      ...overrides,
    });

    it("flags a dead export the second adapter's files introduce", async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.py', 'def feature():\n    pass\n');
      seedDebtBaseline({ deadExports: [], duplicatedLines: 0 });

      const outcome = await merge([
        debtAdapter(),
        secondAdapter({ deadCode: () => [{ file: 'src/feature.py', exportName: 'feature' }] }),
      ]);

      expect(outcome.status).toBe('refused');
      expect(outcome.report.stages).toContainEqual(
        expect.objectContaining({
          stage: 'dead-code',
          status: 'flagged',
          detail: expect.stringContaining('src/feature.py#feature'),
        }),
      );
    });

    it('ratchets the duplication bar to the sum over both adapters', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      seedDebtBaseline({ deadExports: [], duplicatedLines: 60 });
      const adapters = [
        debtAdapter({ duplication: () => ({ duplicatedLines: 12, blocks: [] }) }),
        secondAdapter({ duplication: () => ({ duplicatedLines: 30, blocks: [] }) }),
      ];

      const outcome = await merge(adapters);

      expect(outcome.status).toBe('merged');
      expect(outcome.report.stages).toContainEqual(
        expect.objectContaining({
          stage: 'duplication',
          status: 'pass',
          detail: '42 duplicated lines (baseline 60)',
        }),
      );
      const stored = JSON.parse(getProject(db, 'proj-1')?.baseline ?? '{}') as ProjectBaseline;
      expect(stored.debt?.duplicatedLines).toBe(42);
      // The same number `pup init` would have recorded over the same adapters —
      // the bar the gate ratchets and the bar init captures are one measurement.
      expect((await initProject(db, repo, adapters)).baseline.debt?.duplicatedLines).toBe(42);
    });

    it('flags a complexity rise in either adapter, over its own files', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.py', 'def feature():\n    pass\n');

      const outcome = await merge([
        debtAdapter(),
        secondAdapter({
          complexity: ({ measurePath }) => [
            { file: 'src/feature.py', complexity: measurePath === repo ? 1 : 40 },
          ],
        }),
      ]);

      expect(outcome.status).toBe('refused');
      expect(outcome.report.stages).toContainEqual(
        expect.objectContaining({
          stage: 'complexity',
          status: 'flagged',
          detail: expect.stringContaining('src/feature.py (+39)'),
        }),
      );
    });

    it('runs the hard stages and the nested-package check from the first adapter only', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const secondGateCommands = vi.fn(() => [
        { stage: 'build' as const, command: 'false', args: [] },
      ]);
      const secondNested = vi.fn(() => []);

      const outcome = await merge([
        passingAdapter,
        secondAdapter({
          gateCommands: secondGateCommands,
          touchedNestedPackages: secondNested,
        }),
      ]);

      // One repo has one build, test and lint (decision 22): the second
      // adapter's failing build is never run.
      expect(outcome.status).toBe('merged');
      expect(secondGateCommands).not.toHaveBeenCalled();
      expect(secondNested).not.toHaveBeenCalled();
    });
  });

  // The trap this closes end to end: a compare the gate skipped must not write
  // the number it could not compare in as the floor, where no later merge or
  // audit ever sees it. `judgeDebt` withholds it; this is the store agreeing.
  it('leaves the stored duplication bar alone when the rule no longer matches', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    seedDebtBaseline({ deadExports: [], duplicatedLines: 220, duplicationRule: 'imports-counted' });
    const adapter = debtAdapter({ duplication: () => ({ duplicatedLines: 62, blocks: [] }) });

    const outcome = await merge(adapter);

    expect(outcome.report.stages).toContainEqual(
      expect.objectContaining({
        stage: 'duplication',
        status: 'skipped',
        detail: expect.stringContaining('counts duplication a different way'),
      }),
    );
    const stored = JSON.parse(getProject(db, 'proj-1')?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt?.duplicatedLines).toBe(220);
    expect(stored.debt?.duplicationRule).toBe('imports-counted');
  });

  it('merges flagged debt with --accept-debt, writing one ledger entry per flag', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    seedDebtBaseline({ deadExports: [], duplicatedLines: 0 });
    const adapter = debtAdapter({
      deadCode: () => [{ file: 'src/feature.ts', exportName: 'feature' }],
      duplication: () => ({
        duplicatedLines: 8,
        blocks: [{ locations: [{ file: 'src/feature.ts', line: 1 }] }],
      }),
    });

    const outcome = await merge(adapter, { reason: 'deadline', reviewBy: 'before v2' });

    expect(outcome.status).toBe('merged');
    const entries = listLedgerEntries(db, 'proj-1');
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.description).sort()).toEqual([
      `Duplicated lines rose from 0 to 8 in session ${SESSION_ID}`,
      `New unused exports (1) merged from session ${SESSION_ID}`,
    ]);
  });

  it('with openPr pushes the branch and opens a PR instead of merging locally', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    seedDebtBaseline({ deadExports: [{ file: 'src/legacy.ts', exportName: 'old' }] });
    const bare = addOrigin();
    const mainBefore = sh(repo, 'git', 'rev-parse', 'main').trim();

    const outcome = await withFakeGh(fakeGh([]), () =>
      runMergeGate(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [debtAdapter({ deadCode: () => [] })],
        openPr: true,
      }),
    );

    expect(outcome.status).toBe('merged');
    expect(outcome.prWasAdopted).toBe(false);
    expect(outcome.prUrl).toContain('--repo github.com/owner/repo');
    expect(outcome.prUrl).toContain(`--head ${BRANCH}`);
    expect(outcome.prUrl).toContain('--base main');
    // The session's one commit, not the goal: a squash lands the title as main's subject.
    expect(outcome.prUrl).toContain('--title edit src/feature.ts --body-file');
    expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(mainBefore);
    expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).not.toBe('');
    expect(getSession(db, SESSION_ID)?.state).toBe('merged');
    expect(existsSync(worktree)).toBe(false);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH).trim()).toBe('');
    // The target has not moved, so the bar must not either — the post-PR audit ratchets.
    const stored = JSON.parse(getProject(db, 'proj-1')?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt?.deadExports).toEqual([{ file: 'src/legacy.ts', exportName: 'old' }]);
  });

  it('with openPr refuses when origin no longer matches the recorded push target', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const bare = addOrigin();
    const rogue = secondRemote(bare, 'attacker', 'repo');
    // Written from the session's worktree into the config every checkout
    // shares — the value decision 54 reads raw, and the one thing it could not
    // defend against because it had nothing to compare it to.
    sh(worktree, 'git', 'config', 'remote.origin.url', 'git@github.com:attacker/repo.git');

    await expect(
      withFakeGh(fakeGh([]), () =>
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [passingAdapter],
          openPr: true,
        }),
      ),
    ).rejects.toThrow(
      /recorded: +git@github\.com:owner\/repo\.git[\s\S]*configured: +git@github\.com:attacker\/repo\.git/,
    );
    expect(sh(rogue, 'git', 'branch', '--list', BRANCH).trim()).toBe('');
    expect(sh(bare, 'git', 'branch', '--list', BRANCH).trim()).toBe('');
    // Refused before the gate ran, so gh was only probed: nothing was pushed
    // and no pull request was opened anywhere.
    expect(ghCalls()).toEqual(['--version']);
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
  });

  it('with openPr adopts an open PR onto the same base and rewrites its description', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    addOrigin();

    const outcome = await withFakeGh(fakeGh([openPrOnMain]), () =>
      runMergeGate(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [passingAdapter],
        openPr: true,
      }),
    );

    expect(outcome.status).toBe('merged');
    expect(outcome.prUrl).toBe(openPrOnMain.url);
    expect(outcome.prWasAdopted).toBe(true);
    // An adopted description is unverifiable, so the gate overwrites it.
    expect(ghCalls()).toContainEqual(expect.stringContaining(`pr edit ${openPrOnMain.url}`));
    expect(ghCalls()).not.toContainEqual(expect.stringContaining('pr create'));
  });

  it('with openPr refuses a same-named PR from a fork, before pushing', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const bare = addOrigin();

    await expect(
      withFakeGh(fakeGh([{ ...openPrOnMain, isCrossRepository: true }]), () =>
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [passingAdapter],
          openPr: true,
        }),
      ),
    ).rejects.toThrow('fork');
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    expect(sh(bare, 'git', 'branch', '--list', BRANCH).trim()).toBe('');
  });

  it('with openPr fails fast when gh is unavailable, before any gate stage', async () => {
    seedSession(db, repo);

    await expect(
      withFakeGh('#!/bin/sh\nexit 1\n', () =>
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [passingAdapter],
          openPr: true,
        }),
      ),
    ).rejects.toThrow('gh');
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
  });

  describe('re-gating a merged session whose PR head moved (decision 86)', () => {
    const PR_URL = openPrOnMain.url;
    let bare: string;
    /** The sha the first gate pinned and the PR first vouched for. */
    let pinned: string;

    /** The first gate's adoption rewrote the PR once; a refused re-gate must not again. */
    const prEdits = () => ghCalls().filter((call) => call.startsWith('pr edit')).length;
    const merges = () =>
      listEvents(db, SESSION_ID)
        .filter((row) => row.type === 'merge')
        .map((row) => JSON.parse(row.payload) as { sha: string; prUrl?: string });

    /**
     * A `--pr` gate that adopted PR #7, then, with `fixRound`, the operator's
     * CI fix round as LOOP.md runs it: the branch back in a review worktree, a
     * commit, a push to the PR. Returns the branch tip.
     */
    async function gateThenFix(
      {
        fixRound = true,
        firstFile = 'src/feature.ts',
        firstContent = 'export const a = 1;\n',
      } = {},
      acceptDebt?: { reason: string; reviewBy: string; acceptedBy: string },
    ): Promise<string> {
      const worktree = seedSession(db, repo);
      commitIn(worktree, firstFile, firstContent);
      bare = addOrigin();
      const first = await withFakeGh(fakeGh([openPrOnMain]), () =>
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [passingAdapter],
          openPr: true,
          acceptDebt,
        }),
      );
      expect(first.status).toBe('merged');
      pinned = merges().at(-1)?.sha as string;
      if (!fixRound) return pinned;
      const review = join(repo, '.worktrees', `${SESSION_ID}-review`);
      sh(repo, 'git', 'worktree', 'add', '-b', BRANCH, review, pinned);
      commitIn(review, 'src/fix.ts', 'export const fix = 1;\n');
      sh(review, 'git', 'push', '-q', bare, BRANCH);
      return sh(review, 'git', 'rev-parse', 'HEAD').trim();
    }

    const regate = (
      adapters: Adapter[] = [passingAdapter],
      gh = fakeGh([openPrOnMain]),
      acceptDebt?: { reason: string; reviewBy: string; acceptedBy: string },
    ) =>
      withFakeGh(gh, () =>
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters,
          openPr: true,
          acceptDebt,
        }),
      );

    /** Only the fix round's file builds: a pass proves the stages read the new head. */
    const fixChecking: Adapter = {
      ...passingAdapter,
      gateCommands: () => [
        { stage: 'build', command: 'test', args: ['-f', 'src/fix.ts'] },
        { stage: 'test', command: 'true', args: [] },
        { stage: 'lint', command: 'true', args: [] },
      ],
    };

    it("rewrites the PR title by the rule: the session's first commit subject", async () => {
      await gateThenFix();
      const editsBefore = prEdits();

      const outcome = await regate([fixChecking]);

      expect(outcome.status).toBe('merged');
      expect(prEdits()).toBe(editsBefore + 1);
      const edit = ghCalls()
        .filter((call) => call.startsWith('pr edit'))
        .at(-1);
      expect(edit).toContain('--title edit src/feature.ts --body-file');
    });

    it('runs every stage on the new head and appends a merge event with its sha and the same PR', async () => {
      const tip = await gateThenFix();
      const drafts = vi.mocked(runUtility).mock.calls.length;

      const outcome = await regate([fixChecking]);

      expect(outcome.status).toBe('merged');
      expect(outcome.prUrl).toBe(PR_URL);
      expect(outcome.decisionRecordId).toBeUndefined();
      expect(outcome.report.stages.map(({ stage, status }) => `${stage}:${status}`)).toEqual(
        expect.arrayContaining([
          'worktree-clean:skipped',
          'fresh-base:pass',
          'build:pass',
          'test:pass',
          'lint:pass',
          'scope-audit:pass',
          'diff-size:pass',
        ]),
      );
      expect(outcome.report.stages.some((stage) => stage.status === 'fail')).toBe(false);
      expect(merges()).toHaveLength(2);
      expect(merges().at(-1)).toMatchObject({ sha: tip, prUrl: PR_URL, target: 'main' });
      expect(getSession(db, SESSION_ID)?.state).toBe('merged');
      // The newest gate run is the re-gate's, logged onto the state it keeps.
      const lastGate = listEvents(db, SESSION_ID)
        .filter((row) => row.type === 'gate_result')
        .at(-1);
      expect(JSON.parse(lastGate?.payload ?? '{}')).toMatchObject({
        from: 'merged',
        to: 'merged',
        report: { passed: true },
      });
      // Adopted and rewritten, then read back at the new pin; nothing pushed.
      expect(prEdits()).toBe(2);
      expect(ghCalls().at(-1)).toBe(
        `pr view ${PR_URL} --repo github.com/owner/repo --json headRefOid`,
      );
      expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).toBe(tip);
      expect(vi.mocked(runUtility).mock.calls.length).toBe(drafts);
      expect(killSession).toHaveBeenCalledTimes(1);
    });

    /** Run a re-gate expected to refuse, and assert it wrote nothing. */
    async function expectRefusedUnwritten(
      refusal: RegExp,
      gh = fakeGh([openPrOnMain]),
    ): Promise<void> {
      const events = listEvents(db, SESSION_ID).length;
      const ledger = listLedgerEntries(db, 'proj-1').length;
      const edits = prEdits();

      await expect(regate([fixChecking], gh)).rejects.toThrow(refusal);

      expect(listEvents(db, SESSION_ID)).toHaveLength(events);
      expect(listLedgerEntries(db, 'proj-1')).toHaveLength(ledger);
      expect(prEdits()).toBe(edits);
      expect(getSession(db, SESSION_ID)?.state).toBe('merged');
    }

    /** The fix round's review worktree removed, and the local branch it held deleted. */
    function dropReviewBranch(): void {
      sh(
        repo,
        'git',
        'worktree',
        'remove',
        '--force',
        join(repo, '.worktrees', `${SESSION_ID}-review`),
      );
      sh(repo, 'git', 'branch', '-D', BRANCH);
    }

    it.each<[string, () => Promise<unknown>, string, RegExp]>([
      ['closed', () => gateThenFix(), 'CLOSED', /is CLOSED on GitHub, not OPEN: a closed PR/],
      ['merged', () => gateThenFix(), 'MERGED', /is MERGED on GitHub, not OPEN: .*pup land s1/],
      ['still at the pin', () => gateThenFix({ fixRound: false }), 'OPEN', /still has its head at/],
    ])('refuses a PR %s, writing nothing', async (_label, setup, state, refusal) => {
      await setup();

      await expectRefusedUnwritten(refusal, fakeGh([openPrOnMain], undefined, state));
    });

    /** A merge event as the store can hold it: session-writable, so any shape. */
    function plantMerge(fields: Record<string, unknown>): void {
      db.prepare("INSERT INTO events (session_id, type, payload) VALUES (?, 'merge', ?)").run(
        SESSION_ID,
        JSON.stringify({ branch: BRANCH, files: [], ...fields }),
      );
    }

    it.each<[string, (pin: string) => Record<string, string>]>([
      ['no pinned sha', () => ({ target: 'main' })],
      ['a sha outside the pinned shape', () => ({ sha: '--upload-pack=x', target: 'main' })],
      ['no target', (pin) => ({ sha: pin })],
    ])('refuses a merge event with %s, asking gh nothing', async (_label, fields) => {
      await gateThenFix();
      plantMerge({ prUrl: PR_URL, ...fields(pinned) });
      const calls = ghCalls().length;

      await expectRefusedUnwritten(/merge event names no pinned sha and target/);

      expect(ghCalls()).toHaveLength(calls);
    });

    it("refuses a recorded PR url outside origin's repo, asking gh nothing", async () => {
      await gateThenFix();
      plantMerge({ prUrl: 'https://github.com/other/repo/pull/7', sha: pinned, target: 'main' });
      const calls = ghCalls().length;

      await expectRefusedUnwritten(/is not a pull request of github\.com\/owner\/repo/);

      // The availability probe only: no PR was asked about.
      expect(ghCalls().slice(calls)).toEqual(['--version']);
    });

    it('refuses when the main checkout is on another branch than the merge targeted', async () => {
      await gateThenFix();
      sh(repo, 'git', 'switch', '-q', '-c', 'release');

      await expectRefusedUnwritten(/was gated onto main, but the main checkout is on release/);
    });

    it('refuses a PR GitHub reports in a state it cannot read', async () => {
      await gateThenFix();

      await expectRefusedUnwritten(
        /is UNKNOWN on GitHub, not OPEN: only an open PR is re-gated/,
        fakeGh([openPrOnMain], undefined, 'UNKNOWN'),
      );
    });

    it('refuses a PR whose state gh leaves out', async () => {
      await gateThenFix();
      const stateless = fakeGh([openPrOnMain]).replace('"state":"OPEN",', '');
      expect(stateless).not.toContain('"state"');

      await expectRefusedUnwritten(/is in an unreadable state on GitHub, not OPEN/, stateless);
    });

    it('refuses a PR GitHub reports with an unreadable head', async () => {
      await gateThenFix();

      await expectRefusedUnwritten(/with an unreadable head/, fakeGh([openPrOnMain], 'not-a-sha'));
    });

    it.each<[string, unknown[], RegExp]>([
      [
        'another open PR',
        [{ ...openPrOnMain, url: 'https://github.com/owner/repo/pull/8' }],
        /open pull request for pup\/s1 is https:\/\/github\.com\/owner\/repo\/pull\/8, not .*pull\/7/,
      ],
      ['no open PR', [], /open pull request for pup\/s1 is none, not .*pull\/7/],
    ])('refuses when adoption finds %s for the branch', async (_label, listed, refusal) => {
      await gateThenFix();

      await expectRefusedUnwritten(refusal, fakeGh(listed));
    });

    it('refuses a local branch turned into a symref, with the symref refusal', async () => {
      await gateThenFix();
      dropReviewBranch();
      sh(repo, 'git', 'symbolic-ref', `refs/heads/${BRANCH}`, 'refs/heads/main');

      await expectRefusedUnwritten(/is a symbolic ref to refs\/heads\/main/);
    });

    it('refuses when the local branch is missing, before any stage', async () => {
      await gateThenFix();
      dropReviewBranch();

      await expectRefusedUnwritten(/pup\/s1 is missing in this repo, but .* has its head at/);
    });

    it('refuses a merged session that opened no PR, asking gh nothing', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      expect((await merge()).status).toBe('merged');
      addOrigin();

      await expectRefusedUnwritten(/merged with no pull request: .*local fast-forward/);

      expect(ghCalls()).toEqual([]);
    });

    it('refuses a session that already landed', async () => {
      await gateThenFix();
      appendEvent(db, SESSION_ID, 'landed', { sha: pinned, target: 'main', prUrl: PR_URL });

      await expectRefusedUnwritten(/has already landed/);
    });

    it('still refuses a merged session without --pr', async () => {
      await gateThenFix();

      await expect(merge()).rejects.toThrow(SessionNotReviewableError);
    });

    it('refuses when the local branch is not at the PR head, before any stage', async () => {
      await gateThenFix();
      commitIn(join(repo, '.worktrees', `${SESSION_ID}-review`), 'src/local.ts', 'x;\n');

      await expectRefusedUnwritten(/is at [0-9a-f]+ in this repo, but .* has its head at/);
    });

    // The body vouches for the new pin only, as a first gate's does (decision 82).
    it('refuses a re-gate whose PR head reads back elsewhere after the rewrite', async () => {
      const tip = await gateThenFix();
      const edited = join(dirname(ghLog), 'edited');
      const elsewhere = 'e'.repeat(40);
      const viewCheck = 'if [ "$2" = "view" ]; then';
      expect(fakeGh([openPrOnMain]).split(viewCheck)).toHaveLength(2);
      const movedAfterEdit = fakeGh([openPrOnMain]).replace(
        viewCheck,
        [
          `[ "$2" = "edit" ] && touch ${edited}`,
          `if [ "$2" = "view" ] && [ -e ${edited} ]; then`,
          `  printf '{"headRefOid":"${elsewhere}"}\\n'; exit 0`,
          'fi',
          viewCheck,
        ].join('\n'),
      );
      const events = listEvents(db, SESSION_ID).length;

      await expect(regate([fixChecking], movedAfterEdit)).rejects.toThrow(
        `has its head at ${elsewhere}, not at ${tip}`,
      );

      expect(listEvents(db, SESSION_ID)).toHaveLength(events);
      expect(merges().at(-1)?.sha).toBe(pinned);
      expect(getSession(db, SESSION_ID)?.state).toBe('merged');
    });

    it('refuses a new head failing a hard stage, keeping the earlier merge event newest', async () => {
      await gateThenFix();

      const outcome = await regate([failingBuildAdapter]);

      expect(outcome.status).toBe('refused');
      expect(outcome.report.stages.find((stage) => stage.stage === 'build')?.status).toBe('fail');
      expect(merges()).toHaveLength(1);
      expect(merges().at(-1)?.sha).toBe(pinned);
      expect(getSession(db, SESSION_ID)?.state).toBe('merged');
      expect(steerPane).not.toHaveBeenCalled();
      expect(prEdits()).toBe(1);
    });

    it('refuses a new head not based on the target instead of rebasing it', async () => {
      await gateThenFix();
      commitIn(repo, 'src/main-moved.ts', 'export const moved = 1;\n');

      const outcome = await regate();

      expect(outcome.status).toBe('refused');
      expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'fresh-base', status: 'fail' });
      expect(merges()).toHaveLength(1);
    });

    it('files no second ledger entry for a flag the first gate already filed', async () => {
      const debt = { reason: 'deadline', reviewBy: 'before v2', acceptedBy: 'human' };
      await gateThenFix(
        { firstFile: 'src/big.ts', firstContent: 'const line = 1;\n'.repeat(700) },
        debt,
      );
      expect(listLedgerEntries(db, 'proj-1')).toHaveLength(1);
      // Another session's debt over the same file holds no kind for this one,
      // and stays a candidate to close.
      const other = insertLedgerEntry(db, {
        projectId: 'proj-1',
        description: 'Oversize diff (900 lines) merged from session s9',
        files: ['src/big.ts'],
        reason: 'older',
        acceptedBy: 'human',
        reviewBy: 'later',
      });

      const outcome = await regate([passingAdapter], fakeGh([openPrOnMain]), debt);

      expect(outcome.status).toBe('merged');
      expect(outcome.report.stages.find((stage) => stage.stage === 'diff-size')?.status).toBe(
        'flagged',
      );
      expect(listLedgerEntries(db, 'proj-1')).toHaveLength(2);
      expect(outcome.debtCandidates).toEqual([
        { id: other, description: 'Oversize diff (900 lines) merged from session s9' },
      ]);
    });

    it.each<[string, string, Adapter]>([
      [
        'duplication',
        'Duplicated lines rose from 0 to 5',
        debtAdapter({ duplication: () => ({ duplicatedLines: 8, blocks: [] }) }),
      ],
      [
        'unmeasured coverage',
        'Coverage unmeasured over 1 changed source file(s)',
        debtAdapter({ coverableFiles, coverage: () => ({ files: {} }) }),
      ],
    ])(
      'files no second ledger entry for a held %s flag whose figures moved',
      async (_label, held, adapter) => {
        const debt = { reason: 'deadline', reviewBy: 'before v2', acceptedBy: 'human' };
        await gateThenFix();
        seedDebtBaseline({ duplicatedLines: 0 });
        insertLedgerEntry(db, {
          projectId: 'proj-1',
          description: `${held} in session ${SESSION_ID}`,
          files: ['src/feature.ts'],
          reason: 'older',
          acceptedBy: 'human',
          reviewBy: 'later',
        });

        const outcome = await regate([adapter], fakeGh([openPrOnMain]), debt);

        expect(outcome).toMatchObject({ status: 'merged', regated: true });
        expect(outcome.report.stages.filter((stage) => stage.status === 'flagged')).toHaveLength(1);
        expect(listLedgerEntries(db, 'proj-1').map((entry) => entry.description)).toEqual([
          `${held} in session ${SESSION_ID}`,
        ]);
      },
    );

    /** The fix round's package: its name carries a digit, and it has no test script. */
    const untestedApp2: Adapter = {
      ...fixChecking,
      touchedNestedPackages: () => [
        {
          dir: 'src/app2',
          changedFiles: ['src/fix.ts'],
          droppedSources: [],
          commands: [],
          missing: ['test'],
        },
      ],
    };

    it('files a new ledger entry for a flag differing from a held one only by a digit in a name', async () => {
      const debt = { reason: 'deadline', reviewBy: 'before v2', acceptedBy: 'human' };
      await gateThenFix();
      insertLedgerEntry(db, {
        projectId: 'proj-1',
        description: `Nested package src/app1 changed with no test script, merged from session ${SESSION_ID}`,
        files: ['src/app1/index.ts'],
        reason: 'older',
        acceptedBy: 'human',
        reviewBy: 'later',
      });

      const outcome = await regate([untestedApp2], fakeGh([openPrOnMain]), debt);

      expect(outcome).toMatchObject({ status: 'merged', regated: true });
      expect(listLedgerEntries(db, 'proj-1').map((entry) => entry.description)).toEqual(
        expect.arrayContaining([
          `Nested package src/app1 changed with no test script, merged from session ${SESSION_ID}`,
          `Nested package src/app2 changed with no test script, merged from session ${SESSION_ID}`,
        ]),
      );
      expect(listLedgerEntries(db, 'proj-1')).toHaveLength(2);
    });

    it('refuses a flag without --accept-debt, writing nothing and suggesting no steer', async () => {
      await gateThenFix();
      const ledger = listLedgerEntries(db, 'proj-1').length;

      const outcome = await regate([untestedApp2]);

      expect(outcome).toMatchObject({ status: 'refused', regated: true });
      expect(outcome.report.stages.some((stage) => stage.status === 'fail')).toBe(false);
      const flagged = outcome.report.stages.find((stage) => stage.status === 'flagged');
      expect(flagged?.detail).toContain('--accept-debt');
      expect(flagged?.detail).not.toContain('steer');
      expect(listLedgerEntries(db, 'proj-1')).toHaveLength(ledger);
      expect(merges()).toHaveLength(1);
      expect(merges().at(-1)?.sha).toBe(pinned);
      expect(prEdits()).toBe(1);
      expect(getSession(db, SESSION_ID)?.state).toBe('merged');
      expect(steerPane).not.toHaveBeenCalled();
    });
  });
});

describe('countChangedLines', () => {
  /** Commits `entries` from the index alone, holding what no APFS working tree could. */
  function commitBlobs(repo: string, entries: [mode: string, path: string, content: string][]) {
    for (const [mode, path, content] of entries) {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: repo,
        env: GIT_ENV,
        input: content,
        encoding: 'utf8',
      }).trim();
      sh(repo, 'git', 'update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`);
    }
    sh(repo, 'git', 'commit', '-q', '-m', 'from the index');
  }

  // On macOS `core.precomposeUnicode`, which `git init` turns on and a session
  // can write into the shared config, rewrites an NFD `<rev>:<path>` to NFC,
  // so the importer read returned its NFC sibling's text and the test it names
  // went unreached (decision 114). Elsewhere git ignores the key and this
  // passes either way.
  it('reads an NFD importer, not its NFC sibling', () => {
    const repo = initRepo();
    sh(repo, 'git', 'config', 'core.precomposeUnicode', 'false');
    sh(repo, 'git', 'checkout', '-q', '-b', 'feature');
    commitBlobs(repo, [
      ['100644', 'src/big.test.ts', 'export const v = 1;\n'.repeat(5)],
      ['100644', 'src/cafe\u0301.ts', "export * from './big.test.js';\n"],
      ['100644', 'src/caf\u00e9.ts', 'export {};\n'],
    ]);
    sh(repo, 'git', 'config', 'core.precomposeUnicode', 'true');

    expect(countChangedLines(repo, 'main', 'feature')).toEqual({
      source: 7,
      test: 0,
      docs: 0,
      forged: [],
    });
  });

  // Checkout writes a link with `symlink()`, which takes its target as a C
  // string, so a link blob `big.test.ts\0x` lands on `big.test.ts`. The link
  // blobs themselves are binary for their NUL and count nothing.
  it('reads a link target up to its first NUL, as checkout writes it', () => {
    const repo = initRepo();
    sh(repo, 'git', 'checkout', '-q', '-b', 'feature');
    commitBlobs(repo, [
      ['100644', 'src/big.test.ts', 'export const v = 1;\n'.repeat(5)],
      ['100644', 'docs/impl.md', 'print(1)\n'.repeat(3)],
      ['120000', 'src/impl.ts', 'big.test.ts\0x'],
      ['120000', 'src/pkg/impl.py', '../../docs/impl.md\0'],
    ]);

    expect(countChangedLines(repo, 'main', 'feature')).toEqual({
      source: 8,
      test: 0,
      docs: 0,
      forged: [],
    });
  });

  // APFS folds `\u017f` onto `s` and `\u03c2` onto `\u03c3` by tables no
  // JavaScript case mapping shares, so a name holding a character outside
  // ASCII is never compared: a link spelled with one lands anywhere, and a
  // changed path named with one is source whatever an ASCII link reaches.
  it.each([
    ['a target', 'src/pkg/impl.py', '../../doc\u017f/impl.md'],
    ['a directory', 'doc\u017f/impl.py', 'impl.md'],
  ])('lets a link with %s outside ASCII reach every path', (_, link, target) => {
    const repo = initRepo();
    sh(repo, 'git', 'config', 'core.precomposeUnicode', 'false');
    sh(repo, 'git', 'checkout', '-q', '-b', 'feature');
    commitBlobs(repo, [
      ['100644', 'docs/impl.md', 'print(1)\n'.repeat(5)],
      ['100644', 'src/plain.test.ts', 'export const v = 1;\n'],
      ['120000', link, target],
    ]);

    expect(countChangedLines(repo, 'main', 'feature')).toEqual({
      source: 7,
      test: 0,
      docs: 0,
      forged: [],
    });
  });

  it('counts a doc or test named outside ASCII as source, as an ASCII link may reach it', () => {
    const repo = initRepo();
    sh(repo, 'git', 'config', 'core.precomposeUnicode', 'false');
    sh(repo, 'git', 'checkout', '-q', '-b', 'feature');
    commitBlobs(repo, [
      ['100644', 'docs/\u017fecret.md', 'print(1)\n'.repeat(5)],
      ['100644', 'src/\u017fub/big.test.ts', 'export const v = 1;\n'.repeat(3)],
      ['120000', 'src/pkg/impl.py', '../../docs/secret.md'],
      ['120000', 'src/impl.ts', 'sub/big.test.ts'],
    ]);

    expect(countChangedLines(repo, 'main', 'feature')).toEqual({
      source: 10,
      test: 0,
      docs: 0,
      forged: [],
    });
  });

  it('takes no final sigma for a sigma', () => {
    const repo = initRepo();
    sh(repo, 'git', 'config', 'core.precomposeUnicode', 'false');
    sh(repo, 'git', 'checkout', '-q', '-b', 'feature');
    commitBlobs(repo, [
      [
        '100644',
        'src/\u03bb\u03cc\u03b3\u03bf\u03c2/big.test.ts',
        'export const v = 1;\n'.repeat(3),
      ],
      ['120000', 'src/impl.ts', '\u03bb\u03cc\u03b3\u03bf\u03c3/big.test.ts'],
    ]);

    expect(countChangedLines(repo, 'main', 'feature')).toEqual({
      source: 4,
      test: 0,
      docs: 0,
      forged: [],
    });
  });

  // git's `icase` pathspec and a JavaScript `/i` without `u` fold ASCII only,
  // so a manifest under the Kelvin sign or a config under a long s went unseen
  // where APFS opens either as the ASCII name.
  it.each([
    ['website/pac\u212aage.json', '{ "dependencies": { "@docusaurus/core": "3" } }\n'],
    ['docu\u017faurus.config.ts', 'export default {};\n'],
  ])('compiles docs/ Markdown beside %s', (witness, content) => {
    const repo = initRepo();
    sh(repo, 'git', 'config', 'core.precomposeUnicode', 'false');
    sh(repo, 'git', 'checkout', '-q', '-b', 'feature');
    commitBlobs(repo, [
      ['100644', witness, content],
      ['100644', 'docs/big.md', 'export const v = 1;\n'.repeat(5)],
      ['100644', 'docs/notes.rst', 'Notes\n=====\n'],
    ]);

    expect(countChangedLines(repo, 'main', 'feature')).toEqual({
      source: 6,
      test: 0,
      docs: 2,
      forged: [],
    });
  });

  // runGit decodes git's output as UTF-8, so a path whose bytes are not UTF-8
  // was listed as `src/\ufffd.ts`, and reading that path read a decoy
  // committed under the replacement character itself.
  it('names every test from an importer whose path is not UTF-8', () => {
    const repo = initRepo();
    sh(repo, 'git', 'checkout', '-q', '-b', 'feature');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo,
      env: GIT_ENV,
      input: "export * from './big.test.js';\n",
      encoding: 'utf8',
    }).trim();
    // `src/\u00e9.ts` in Latin-1: no argument carries a byte that is not UTF-8.
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: repo,
      env: GIT_ENV,
      input: Buffer.concat([
        Buffer.from(`100644 ${blob}\tsrc/`),
        Buffer.from([0xe9]),
        Buffer.from('.ts\n'),
      ]),
    });
    commitBlobs(repo, [
      ['100644', 'src/big.test.ts', 'export const v = 1;\n'.repeat(5)],
      ['100644', 'src/\ufffd.ts', 'export {};\n'],
    ]);

    expect(countChangedLines(repo, 'main', 'feature')).toEqual({
      source: 7,
      test: 0,
      docs: 0,
      forged: [],
    });
  });
});

describe('pullRequestText (decision 137)', () => {
  const report = { sessionId: SESSION_ID, passed: true, sandbox: 'test', stages: [] };
  const title = (goal: string, ownSubject: string | undefined): string =>
    pullRequestText(
      { id: 'task-s1' as TaskId, goal, scopeIn: ['src/**'], acceptance: ['done'] },
      SESSION_ID,
      report,
      ownSubject === undefined ? [] : [ownSubject],
      'a'.repeat(40),
      ownSubject,
    ).title;
  /** 79 characters of nine-letter words: the 72-character limit falls mid-word. */
  const longGoal = 'abcdefghi '.repeat(8).trim();

  it('is the session commit subject when it fits 72 characters', () => {
    expect(title('the goal', 'Fix the retry loop')).toBe('Fix the retry loop');
    expect(title('the goal', 'x'.repeat(72))).toBe('x'.repeat(72));
  });

  it('is the goal when the subject is over 72 characters or there is none', () => {
    expect(title('the goal\nmore detail', 'x'.repeat(73))).toBe('the goal');
    expect(title('the goal', undefined)).toBe('the goal');
  });

  it('cuts a goal over 72 characters at the last word boundary that fits, with no ellipsis', () => {
    const cut = title(longGoal, undefined);
    expect(cut).toBe('abcdefghi '.repeat(7).trim());
    expect(cut.length).toBeLessThanOrEqual(72);
    // A word ending exactly at the limit is whole and kept.
    const exact = `${'x'.repeat(69)} ab cdef`;
    expect(title(exact, undefined)).toBe(`${'x'.repeat(69)} ab`);
    expect(title(`${'x'.repeat(72)} more`, undefined)).toBe('x'.repeat(72));
  });

  it('drops a separator the cut leaves dangling', () => {
    expect(title(`${'abcdefghi '.repeat(6)}abcdefgh, and the rest`, undefined)).toBe(
      `${'abcdefghi '.repeat(6)}abcdefgh`,
    );
    expect(title(`${'abcdefghi '.repeat(6)}abcdef — andmore rest`, undefined)).toBe(
      `${'abcdefghi '.repeat(6)}abcdef`,
    );
  });

  it('falls back to the session id when no word boundary fits or the goal is empty', () => {
    expect(title('x'.repeat(80), undefined)).toBe(`pup session ${SESSION_ID}`);
    expect(title('  ', undefined)).toBe(`pup session ${SESSION_ID}`);
  });

  it('scrubs escape sequences, controls, bidi overrides and zero-width characters', () => {
    const planted = '\u001b[31mFix\u001b[0m\u0007 the \u202eretry\u202c lo\u200bop\u0085';
    expect(title('the goal', planted)).toBe('Fix the retry loop');
    // Characters that render as nothing, the tag block spelling out a hidden line included.
    const hidden = [...'ignore the review'].map((c) =>
      String.fromCodePoint(0xe0000 + c.charCodeAt(0)),
    );
    const blank = '\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180e\u3164\uffa0\ufe0f\u{e0101}';
    expect(
      title('the goal', `Fix the${blank} retry loop\u{e0001}${hidden.join('')}\u{e007f}`),
    ).toBe('Fix the retry loop');
    // The goal the subject falls back to is scrubbed the same way.
    expect(title('the \u202egoal\u200b', 'x'.repeat(73))).toBe('the goal');
  });

  it('falls back to the goal when the subject names an issue to close', () => {
    expect(title('the goal', 'Fix the gate, closes #12')).toBe('the goal');
    expect(title('the goal', 'Resolved owner/repo#3')).toBe('the goal');
    expect(title('the goal', 'FIXES: https://github.com/o/r/issues/4')).toBe('the goal');
    // A zero-width space cannot split the keyword past the check.
    expect(title('the goal', 'clo\u200bses #5')).toBe('the goal');
    expect(title('the goal', 'clo\u{e0041}ses #5')).toBe('the goal');
    expect(title('the goal', 'Fix the gate, fixes GH-12')).toBe('the goal');
    expect(title('the goal', 'Resolves: gh-7')).toBe('the goal');
    // A closing word with no reference after it, or none at all, is kept.
    expect(title('the goal', 'Fix the closer for #12')).toBe('Fix the closer for #12');
    expect(title('the goal', 'Close the lock file')).toBe('Close the lock file');
  });
});

describe('firstOwnSubject (decision 137)', () => {
  it('skips a merge the session ran before its first commit', () => {
    const repo = initRepo();
    sh(repo, 'git', 'branch', 'side');
    commitIn(repo, 'src/main.ts', 'export const main = 1;\n');
    const targetSha = sh(repo, 'git', 'rev-parse', 'main').trim();
    sh(repo, 'git', 'checkout', '-q', 'side');
    sh(repo, 'git', 'merge', '-q', '--no-ff', '--no-edit', 'main');
    const merge = sh(repo, 'git', 'rev-parse', 'HEAD').trim();
    commitIn(repo, 'src/fix.ts', 'export const fix = 1;\n');
    const sha = sh(repo, 'git', 'rev-parse', 'HEAD').trim();
    // The merge is the oldest commit past the target.
    expect(sh(repo, 'git', 'log', '--reverse', '--format=%s', `${targetSha}..${sha}`)).toMatch(
      /^Merge branch 'main' into side\n/,
    );

    expect(firstOwnSubject(repo, targetSha, sha)).toBe('edit src/fix.ts');
    expect(firstOwnSubject(repo, targetSha, merge)).toBeUndefined();
  });

  it("takes a commit of the session's whose message reads like a merge, read without the commit graph", () => {
    const repo = initRepo();
    const targetSha = sh(repo, 'git', 'rev-parse', 'HEAD').trim();
    sh(repo, 'git', 'commit', '-q', '--allow-empty', '-m', 'Merge main into pup/s1');
    const sha = sh(repo, 'git', 'rev-parse', 'HEAD').trim();
    vi.mocked(execFileSync).mockClear();

    expect(firstOwnSubject(repo, targetSha, sha)).toBe('Merge main into pup/s1');
    const read = vi.mocked(execFileSync).mock.calls.at(-1)?.[1] as string[];
    expect(read.join(' ')).toContain('-c core.useReplaceRefs=false');
    expect(read.join(' ')).toContain('-c core.commitGraph=false log --reverse --no-merges');
  });
});

describe('withMergeLock', () => {
  const lockedRepo = () => {
    const repo = tempDir('pup-lock-');
    mkdirSync(join(repo, '.git'));
    return repo;
  };

  // SIGHUP too: closing the terminal sends it, and node's default would die
  // mid-lock and strand it (decision 88).
  it('keeps node listening for SIGINT, SIGTERM and SIGHUP while the lock is held, and only then', async () => {
    const repo = lockedRepo();
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const before = signals.map((signal) => process.listeners(signal));
    let during: number[] | undefined;

    await expect(
      withMergeLock(repo, () => {
        during = signals.map((signal) => process.listeners(signal).length);
        throw new Error('interrupted');
      }),
    ).rejects.toThrow('interrupted');

    expect(during).toEqual(before.map((listeners) => listeners.length + 1));
    expect(signals.map((signal) => process.listeners(signal))).toEqual(before);
    expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
  });

  it('records its pid in the lock while held', async () => {
    const repo = lockedRepo();

    const pid = await withMergeLock(repo, () =>
      readFileSync(join(repo, '.git', 'pup-merge.lock', 'pid'), 'utf8'),
    );

    expect(pid).toBe(`${process.pid}\n`);
  });

  /** A pid that was alive a moment ago and is not now. */
  const deadPid = () => execFileSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim();

  it('refuses a lock path that is a link, without reading or reclaiming what it points at', async () => {
    const repo = lockedRepo();
    const elsewhere = tempDir('pup-lock-elsewhere-');
    writeFileSync(join(elsewhere, 'pid'), `${deadPid()}\n`);
    symlinkSync(elsewhere, join(repo, '.git', 'pup-merge.lock'));
    const fn = vi.fn();

    await expect(withMergeLock(repo, fn)).rejects.toThrow(MergeLockHeldError);
    expect(fn).not.toHaveBeenCalled();
    expect(existsSync(join(elsewhere, 'pid'))).toBe(true);
  });

  // A run killed mid-reclaim strands the reclaim lock; a fresh one is another
  // run reclaiming right now.
  it.each([
    ['replaces a stranded reclaim lock and reclaims', 60_000, true],
    ['replaces a reclaim lock dated in the future and reclaims', -60_000, true],
    ['leaves a fresh reclaim lock to the run holding it', 0, false],
  ])('%s', async (_, ageMs, reclaims) => {
    const repo = lockedRepo();
    const lock = join(repo, '.git', 'pup-merge.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${deadPid()}\n`);
    const reclaiming = `${lock}.reclaim`;
    mkdirSync(reclaiming);
    const then = new Date(Date.now() - ageMs);
    utimesSync(reclaiming, then, then);
    const fn = vi.fn(() => 'ran');

    const locked = withMergeLock(repo, fn);

    if (reclaims) {
      await expect(locked).resolves.toBe('ran');
      expect(readdirSync(join(repo, '.git'))).toEqual([]);
    } else {
      // Not the live holder's "do not remove it, retry once that run ends".
      await expect(locked).rejects.toThrow(
        /, is gone, and another run is reclaiming it \(.+\.reclaim\)\. Do not remove either/,
      );
      expect(existsSync(reclaiming)).toBe(true);
    }
  });

  it('treats a stale reclaim lock it cannot remove as held', async () => {
    const repo = lockedRepo();
    const lock = join(repo, '.git', 'pup-merge.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${deadPid()}\n`);
    const reclaiming = `${lock}.reclaim`;
    mkdirSync(reclaiming);
    writeFileSync(join(reclaiming, 'planted'), 'x');
    const then = new Date(Date.now() - 60_000);
    utimesSync(reclaiming, then, then);
    const fn = vi.fn();

    await expect(withMergeLock(repo, fn)).rejects.toThrow(MergeLockHeldError);
    expect(fn).not.toHaveBeenCalled();
    expect(readdirSync(reclaiming)).toEqual(['planted']);
    expect(existsSync(join(lock, 'pid'))).toBe(true);
  });

  // A lock with no pid refuses every later run, so a take that cannot record
  // its pid is undone.
  it('undoes a take whose pid cannot be written, leaving no lock', async () => {
    const repo = lockedRepo();
    const pidFile = join(repo, '.git', 'pup-merge.lock', 'pid');
    const real = vi.mocked(writeFileSync).getMockImplementation();
    vi.mocked(writeFileSync).mockImplementation(((...args: Parameters<typeof writeFileSync>) => {
      if (args[0] === pidFile) throw new Error('disk full');
      return real?.(...args);
    }) as never);
    onTestFinished(() => {
      vi.mocked(writeFileSync).mockImplementation(real as never);
    });
    const fn = vi.fn();

    await expect(withMergeLock(repo, fn)).rejects.toThrow('disk full');
    expect(fn).not.toHaveBeenCalled();
    expect(readdirSync(join(repo, '.git'))).toEqual([]);
  });

  // A session that can write `.git` can swap the lock directory for a link to
  // another (another project's lock, say): nothing is then removed through it.
  describe('a lock directory swapped for a link (decision 88)', () => {
    let repo: string;
    let lock: string;
    /** Another lock's directory, whose pid a removal through the link would delete. */
    let elsewhere: string;
    let errors: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      repo = lockedRepo();
      lock = join(repo, '.git', 'pup-merge.lock');
      elsewhere = tempDir('pup-lock-elsewhere-');
      writeFileSync(join(elsewhere, 'pid'), '123\n');
      errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => errors.mockRestore());
    const swap = () => {
      renameSync(lock, `${lock}.moved`);
      symlinkSync(elsewhere, lock);
    };
    /**
     * The lock swapped right before its pid write, which then fails, or lands
     * in the link's target as it would in a directory with no pid yet.
     */
    const aroundPidWrite = (then: 'write' | 'throw') => {
      const real = vi.mocked(writeFileSync).getMockImplementation();
      vi.mocked(writeFileSync).mockImplementation(((...args: Parameters<typeof writeFileSync>) => {
        if (args[0] !== join(lock, 'pid')) return real?.(...args);
        swap();
        if (then === 'throw') throw new Error('disk full');
        return real?.(join(elsewhere, 'fresh-pid'), args[1], args[2]);
      }) as never);
      onTestFinished(() => {
        vi.mocked(writeFileSync).mockImplementation(real as never);
      });
    };

    it('leaves the link and what it points at on release, and fails on the lost lock', async () => {
      await expect(withMergeLock(repo, swap)).rejects.toThrow(MergeLockLostError);

      expect(readFileSync(join(elsewhere, 'pid'), 'utf8')).toBe('123\n');
      expect(errors.mock.calls.flat().join('\n')).toMatch(
        /pup-merge\.lock\.released-[0-9a-f]{16} is no longer the lock directory pup made/,
      );
    });

    it('takes nothing when the swap lands between the mkdir and the pid write', async () => {
      aroundPidWrite('write');
      const fn = vi.fn();

      await expect(withMergeLock(repo, fn)).rejects.toThrow(MergeLockHeldError);
      expect(fn).not.toHaveBeenCalled();
      expect(readFileSync(join(elsewhere, 'pid'), 'utf8')).toBe('123\n');
      expect(errors.mock.calls.flat().join('\n')).toContain(
        `${lock} was replaced while pup took it`,
      );
    });

    it('undoes nothing through the link when the pid write fails after the swap', async () => {
      aroundPidWrite('throw');

      await expect(withMergeLock(repo, vi.fn())).rejects.toThrow('disk full');
      expect(readFileSync(join(elsewhere, 'pid'), 'utf8')).toBe('123\n');
      expect(errors.mock.calls.flat().join('\n')).toContain(
        `${lock} is no longer the lock directory pup made`,
      );
    });
  });

  // The lock sits in a `.git` the session can write: only the pid pup wrote
  // goes with it.
  it('removes only its pid on release, leaving and naming anything else put there', async () => {
    const repo = lockedRepo();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => errors.mockRestore());

    await withMergeLock(repo, () =>
      writeFileSync(join(repo, '.git', 'pup-merge.lock', 'planted'), 'x'),
    );

    expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
    const [aside] = readdirSync(join(repo, '.git'));
    expect(aside).toMatch(/^pup-merge\.lock\.released-[0-9a-f]{16}$/);
    expect(readdirSync(join(repo, '.git', aside as string))).toEqual(['planted']);
    expect(errors.mock.calls.flat().join('\n')).toContain(
      `Could not remove ${join(repo, '.git', aside as string)}:`,
    );
  });

  // What ran under the lock is done whatever the release does: a land's event
  // already refuses a re-run, so its outcome must reach the caller. A lock moved
  // away meant another run could take a fresh one meanwhile, so that is no
  // clean success (decision 88).
  describe('a release that fails', () => {
    let repo: string;
    let lock: string;
    let errors: ReturnType<typeof vi.spyOn>;
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    /** Root writes through a read-only `.git`, so the chmod tests below would test nothing. */
    const asRoot = process.getuid?.() === 0;
    let before: ReturnType<typeof process.listeners>[];
    beforeEach(() => {
      repo = lockedRepo();
      lock = join(repo, '.git', 'pup-merge.lock');
      errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      before = signals.map((signal) => process.listeners(signal));
    });
    afterEach(() => {
      errors.mockRestore();
      expect(signals.map((signal) => process.listeners(signal))).toEqual(before);
    });

    it('fails on a lock moved away under it, carrying what the section returned', async () => {
      const locked = withMergeLock(repo, () => {
        renameSync(lock, `${lock}.moved`);
        return 'landed';
      });

      await expect(locked).rejects.toThrow(MergeLockLostError);
      await expect(locked).rejects.toMatchObject({ result: 'landed' });
      await expect(locked).rejects.toThrow(/was gone or replaced when this run released it/);
    });

    it("keeps the section's own error on a lock moved away, naming the lost lock beside it", async () => {
      await expect(
        withMergeLock(repo, () => {
          renameSync(lock, `${lock}.moved`);
          throw new Error('audit failed');
        }),
      ).rejects.toThrow('audit failed');

      expect(errors.mock.calls.flat()).toContainEqual(
        expect.stringMatching(/pup-merge\.lock was gone or replaced when this run released it/),
      );
    });

    // A session that owns `.git` can move the lock aside, let another run take
    // a fresh one, then make the release's rename fail with something other
    // than ENOENT: still a lost lock, not a warning (decision 88).
    it.skipIf(asRoot)(
      'fails on a lock replaced under it whose release meets another error',
      async () => {
        const git = join(repo, '.git');
        onTestFinished(() => chmodSync(git, 0o755));

        const locked = withMergeLock(repo, () => {
          renameSync(lock, `${lock}.moved`);
          mkdirSync(lock);
          writeFileSync(join(lock, 'pid'), '123\n');
          chmodSync(git, 0o555);
          return 'merged';
        });

        await expect(locked).rejects.toThrow(MergeLockLostError);
        expect(errors.mock.calls.flat().join('\n')).not.toContain('Could not release');
        expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('123\n');
      },
    );

    it.skipIf(asRoot)(
      'returns the result of a lock it still holds but cannot move, and says so',
      async () => {
        const git = join(repo, '.git');
        onTestFinished(() => chmodSync(git, 0o755));

        const result = await withMergeLock(repo, () => {
          chmodSync(git, 0o555);
          return 'merged';
        });

        expect(result).toBe('merged');
        expect(errors.mock.calls.flat()).toContainEqual(
          expect.stringMatching(
            /^Could not release .*pup-merge\.lock: .*EACCES.*A later run reclaims it/,
          ),
        );
        expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(`${process.pid}\n`);
      },
    );

    /**
     * lstat of the moved-aside lock failing with `code` (a plain error with no
     * code when it is undefined), every other lstat real.
     */
    const asideUnreadable = (code?: string) => {
      const real = vi.mocked(lstatSync).getMockImplementation();
      vi.mocked(lstatSync).mockImplementation(((...args: Parameters<typeof lstatSync>) => {
        if (String(args[0]).includes('pup-merge.lock.released-')) {
          throw code === undefined
            ? new Error('lstat failed')
            : Object.assign(new Error(`${code}: lstat failed`), { code });
        }
        return real?.(...args);
      }) as never);
      onTestFinished(() => {
        vi.mocked(lstatSync).mockImplementation(real as never);
      });
    };

    // The rename took the lock off its path, so it was released: a directory
    // left aside that a filesystem fault keeps from being read must not fail
    // the merge it ends.
    it('returns the result when a fault keeps the moved-aside lock from being read', async () => {
      asideUnreadable('EIO');

      const result = await withMergeLock(repo, () => 'merged');

      expect(result).toBe('merged');
      expect(existsSync(lock)).toBe(false);
      const left = readdirSync(join(repo, '.git')).filter((entry) =>
        /^pup-merge\.lock\.released-[0-9a-f]{16}$/.test(entry),
      );
      expect(left).toHaveLength(1);
      expect(readFileSync(join(repo, '.git', left[0] ?? '', 'pid'), 'utf8')).toBe(
        `${process.pid}\n`,
      );
      expect(errors.mock.calls.flat().join('\n')).toMatch(
        /^Could not read .*pup-merge\.lock\.released-[0-9a-f]{16}: .*EIO.*left as it is/m,
      );
      expect(errors.mock.calls.flat().join('\n')).not.toContain('was gone or replaced');
    });

    // A session that owns `.git` can deny pup the moved-aside directory, or
    // swap a component of its path, to hide that it swapped the lock: anything
    // but a disk fault stays a lost lock (decision 88).
    it.each(['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'])(
      'fails on the lost lock when %s keeps the moved-aside lock from being read',
      async (code) => {
        asideUnreadable(code);

        const locked = withMergeLock(repo, () => 'merged');

        await expect(locked).rejects.toThrow(MergeLockLostError);
        await expect(locked).rejects.toMatchObject({ result: 'merged' });
        expect(errors.mock.calls.flat().join('\n')).toMatch(
          new RegExp(
            `^Could not read .*pup-merge\\.lock\\.released-[0-9a-f]{16}: .*${code}.*compromised`,
            'm',
          ),
        );
      },
    );

    // The allow-list names the one error that counts as released: an error
    // that carries no code at all must stay a lost lock too.
    it('fails on the lost lock when an error with no code keeps the moved-aside lock from being read', async () => {
      asideUnreadable();

      const locked = withMergeLock(repo, () => 'merged');

      await expect(locked).rejects.toThrow(MergeLockLostError);
      await expect(locked).rejects.toMatchObject({ result: 'merged' });
      expect(errors.mock.calls.flat().join('\n')).toMatch(
        /^Could not read .*pup-merge\.lock\.released-[0-9a-f]{16}: .*lstat failed.*compromised/m,
      );
    });
  });

  describe('waiting for a live holder (decision 88)', () => {
    let repo: string;
    let errors: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      vi.useFakeTimers();
      repo = lockedRepo();
      mkdirSync(join(repo, '.git', 'pup-merge.lock'));
      writeFileSync(join(repo, '.git', 'pup-merge.lock', 'pid'), `${process.pid}\n`);
      errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
      vi.useRealTimers();
      errors.mockRestore();
    });

    it('takes the lock once it is released, saying once that it waits', async () => {
      const fn = vi.fn(() => 'ran');
      const locked = withMergeLock(repo, fn, 60_000);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fn).not.toHaveBeenCalled();
      rmSync(join(repo, '.git', 'pup-merge.lock'), { recursive: true });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(locked).resolves.toBe('ran');
      expect(errors.mock.calls).toEqual([
        [`Waiting for the merge lock, held by pid ${process.pid}, for up to 60.0s.`],
      ]);
      expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
    });

    // A taker writes its pid in the tick of its mkdir: a lock found without one
    // is looked at again briefly before it is refused as one with no holder.
    it('waits for a pid the taker has not written yet', async () => {
      rmSync(join(repo, '.git', 'pup-merge.lock', 'pid'));
      const fn = vi.fn(() => 'ran');
      const locked = withMergeLock(repo, fn, 60_000);

      await vi.advanceTimersByTimeAsync(100);
      writeFileSync(join(repo, '.git', 'pup-merge.lock', 'pid'), `${process.pid}\n`);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fn).not.toHaveBeenCalled();
      rmSync(join(repo, '.git', 'pup-merge.lock'), { recursive: true });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(locked).resolves.toBe('ran');
    });

    it('refuses a lock that still has no pid after a second, though the wait is longer', async () => {
      rmSync(join(repo, '.git', 'pup-merge.lock', 'pid'));
      const fn = vi.fn();
      const locked = withMergeLock(repo, fn, 60_000);
      const refused = expect(locked).rejects.toThrow(MergeLockHeldError);

      await vi.advanceTimersByTimeAsync(1_000);

      await refused;
      expect(fn).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    });

    it('refuses once the wait runs out, leaving the holder its lock', async () => {
      const fn = vi.fn();
      const locked = withMergeLock(repo, fn, 60_000);
      const refused = expect(locked).rejects.toThrow(MergeLockHeldError);

      await vi.advanceTimersByTimeAsync(60_000);

      await refused;
      expect(fn).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(repo, '.git', 'pup-merge.lock', 'pid'), 'utf8')).toBe(
        `${process.pid}\n`,
      );
    });
  });
});

describe('waitForLoad (decisions 88, 134)', () => {
  /** Another gate or a worker holds a test slot, so the load may be pup's. */
  const othersGoing = (): boolean => true;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    errors.mockRestore();
  });

  it('returns at once, saying nothing, under the ceiling', async () => {
    await waitForLoad(() => 3.9, 4, othersGoing);

    expect(errors).not.toHaveBeenCalled();
  });

  // An idle load above the core count (a scanner, a sync daemon) is no test
  // run of pup's, and waiting it out only delays tests that run anyway.
  it('returns at once, saying nothing, above the ceiling while no other test run is going', async () => {
    const othersTesting = vi.fn(() => false);

    await waitForLoad(() => 20, 8, othersTesting);

    expect(othersTesting).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('stops waiting once the other test runs end, though the load stays above the ceiling', async () => {
    const others = [true, true, false];
    const othersTesting = vi.fn(() => others.shift() ?? false);
    let done = false;
    const waited = waitForLoad(() => 20, 8, othersTesting).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);

    await waited;
    expect(othersTesting).toHaveBeenCalledTimes(3);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('waits, while another test run is going, for the load to fall under the ceiling, saying so in one line', async () => {
    const loads = [6, 5, 4, 2];
    const readLoad = vi.fn(() => loads.shift() ?? 0);
    let done = false;
    const waited = waitForLoad(readLoad, 4, othersGoing).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);

    await waited;
    expect(readLoad).toHaveBeenCalledTimes(4);
    expect(errors.mock.calls).toEqual([
      [
        'The 1-minute load average is 6.0, not under 4, while other test runs are going; the ' +
          `gate waits up to ${formatDuration(GATE_SLOT_WAIT_MS)} for it to fall or for them to ` +
          'end before its tests.',
      ],
    ]);
  });

  // The lock keeps node alive through the signal, so the wait has to end on
  // it itself, as a stage child's forwarded interrupt would.
  it('ends on an interrupt with GateInterruptedError, and stops listening', async () => {
    const before = process.listeners('SIGHUP');
    const waited = waitForLoad(() => 9, 4, othersGoing);
    const interrupted = expect(waited).rejects.toThrow(GateInterruptedError);

    await vi.advanceTimersByTimeAsync(1_000);
    process.emit('SIGHUP', 'SIGHUP');

    await interrupted;
    expect(process.listeners('SIGHUP')).toEqual(before);
  });

  it('runs the tests anyway once a wait on other test runs runs out, with a one-line note', async () => {
    const waited = waitForLoad(() => 9, 4, othersGoing);

    await vi.advanceTimersByTimeAsync(GATE_SLOT_WAIT_MS);

    await waited;
    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls[1]).toEqual([
      `The load average is still 9.0 after ${formatDuration(GATE_SLOT_WAIT_MS)}; the gate ` +
        'runs its tests anyway.',
    ]);
  });

  // The default reads the slots under `HOME`, here a temp dir this test fills.
  describe("with the machine's own test slots", () => {
    let home: string;
    beforeEach(() => {
      home = tempDir('pup-load-home-');
      vi.stubEnv('HOME', home);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns at once, saying nothing, above the ceiling while no slot is held', async () => {
      await waitForLoad(() => 20, 8);

      expect(errors).not.toHaveBeenCalled();
    });

    it('waits above the ceiling while another process holds a slot', async () => {
      const slots = join(home, '.pupitre', 'slots');
      mkdirSync(slots, { recursive: true });
      writeFileSync(
        join(slots, 'slot-0.lock'),
        JSON.stringify({ kind: 'worker', label: 'other', pid: process.ppid, token: 'x' }),
      );
      let done = false;
      const waited = waitForLoad(() => 20, 8).then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(done).toBe(false);
      expect(errors).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(GATE_SLOT_WAIT_MS);

      await waited;
      expect(errors).toHaveBeenCalledTimes(2);
    });
  });
});
