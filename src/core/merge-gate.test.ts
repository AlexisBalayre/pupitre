import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

// The real rmSync, wrapped so a test can make the gate checkout's removal fail.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
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

import type { Adapter, CapabilityContext, NestedPackage } from '../adapters/types/adapter.types.js';
import { typescriptAdapter } from '../adapters/typescript.adapter.js';
import {
  killSession,
  SteerNotDeliveredError,
  steerPane,
} from '../claude/session-runtime.service.js';
import { runUtility } from '../claude/utility.service.js';
import { tempDir } from '../test/temp-dir.mock.js';
import { openStore } from './db.client.js';
import { listDecisionRecords } from './decision-record.repository.js';
import { ArmedGitDriverError, WorktreeRepointedError } from './git-diff.client.js';
import { initProject } from './init.service.js';
import { insertLedgerEntry, listLedgerEntries } from './ledger.repository.js';
import { DUPLICATION_RULE_ID } from './merge-gate.constants.js';
import { MergeLockHeldError, SessionNotReviewableError } from './merge-gate.errors.js';
import { runMergeGate as runGate, withMergeLock } from './merge-gate.service.js';
import { GateInterruptedError, UndeclaredSandboxError } from './sandbox.utils.js';
import {
  appendEvent,
  ensureProject,
  getProject,
  getSession,
  incrementRejectCount,
  insertSession,
  insertTask,
  listBacklogTasks,
  listEvents,
  MalformedTaskSpecError,
  saveProjectBaseline,
  saveProjectOriginUrl,
  transitionSession,
} from './session.repository.js';
import type { DebtBaseline, ProjectBaseline } from './types/init.types.js';
import type { GateStageResult } from './types/merge-gate.types.js';
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
  const repo = tempDir('pup-gate-');
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
/** The pane `launchSession` would have recorded for the seeded session. */
const LAUNCH_PANE = '%4';

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
    tmuxTarget: LAUNCH_PANE,
  });
  transitionSession(db, SESSION_ID, 'running');
  transitionSession(db, SESSION_ID, 'awaiting-review');
  return worktree;
}

/** Where the gate cuts its detached checkout of the pinned sha (decision 81). */
const GATE_CHECKOUT = new RegExp(
  `^${realpathSync(tmpdir()).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')}/pup-gate-checkout-[^/]+/checkout$`,
);

/** The reason the last transition into `blocked` recorded, as the gate wrote it. */
function blockedReason(db: Database): string | undefined {
  const rows = listEvents(db, SESSION_ID).map(
    (event) => JSON.parse(event.payload) as { to?: string; reason?: string },
  );
  return rows.filter((payload) => payload.to === 'blocked').at(-1)?.reason;
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

function debtAdapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    ...passingAdapter,
    deadCode: () => [],
    duplication: () => ({ duplicatedLines: 0, blocks: [] }),
    complexity: () => [],
    ...overrides,
  };
}

/** A report's stages without the wall times, which differ run to run (decision 95). */
function untimed(stages: GateStageResult[]): GateStageResult[] {
  return stages.map(({ durationMs: _, ...stage }) => stage);
}

/** Pretend to be another platform for one test; `process.platform` is a plain property. */
function onPlatform(platform: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', original);
  });
}

// Real git repos + worktrees per test — generous timeout so machine load can't flake it.
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

  it('merges a clean in-scope branch ff-only and cleans everything up', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

    const outcome = await merge();

    expect(outcome.status).toBe('merged');
    expect(sh(repo, 'git', 'log', '--oneline', 'main')).toContain('edit src/feature.ts');
    expect(getSession(db, SESSION_ID)?.state).toBe('merged');
    // A merged session claims its task, so the task leaves the backlog without
    // anything writing a second copy of that fact (decision 40).
    expect(listBacklogTasks(db, 'proj-1')).toEqual([]);
    // By the launch pane as well as the name (decision 46).
    expect(killSession).toHaveBeenCalledWith(SESSION_ID, LAUNCH_PANE);
    expect(existsSync(worktree)).toBe(false);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH).trim()).toBe('');
    expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
  });

  // A session can write any merge option into the target's `mergeOptions` in the
  // shared config; the gate's merge must still be the fast-forward it asked for,
  // and must not sign or verify through a planted program (decision 79).
  it('fast-forwards past a planted branch.<target>.mergeOptions, running no gpg', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const fired = join(repo, '.git', 'fired');
    const gpg = join(repo, '.git', 'planted-gpg');
    writeFileSync(gpg, `#!/bin/sh\necho gpg >> ${fired}\nexit 1\n`, { mode: 0o755 });
    sh(repo, 'git', 'config', 'gpg.program', gpg);
    sh(repo, 'git', 'config', 'branch.main.mergeOptions', '-s ours -S');
    const tip = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();

    const outcome = await merge();

    expect(outcome.status).toBe('merged');
    expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(tip);
    expect(existsSync(fired)).toBe(false);
  });

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

  it('fast-forwards past a planted pull.twohead, the strategy git takes when argv names none', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    // A default strategy that keeps the target's tree: without the pin and the
    // ref check this read as merged with the session's work discarded.
    sh(repo, 'git', 'config', 'pull.twohead', 'ours');
    const tip = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();

    const outcome = await merge();

    expect(outcome.status).toBe('merged');
    expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(tip);
  });

  it('refuses a target branch whose name contains =, before any stage runs', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    sh(repo, 'git', 'branch', '-m', 'main', 'x=y');

    await expect(merge()).rejects.toThrow(/'=' in its name/);

    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
  });

  // The gate pins the branch to one sha after fresh-base and fast-forwards
  // with plumbing against it (decision 80); each test below is one way a live
  // session used to change what porcelain `git merge <name>` landed.
  describe('the pinned fast-forward', () => {
    it('refuses a target branch whose name starts with -, before any stage runs', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      // git will not create such a branch, but the files are the session's to write.
      sh(repo, 'git', 'update-ref', 'refs/heads/-evil', 'main');
      sh(repo, 'git', 'symbolic-ref', 'HEAD', 'refs/heads/-evil');
      const gateCommands = vi.fn(passingAdapter.gateCommands);

      await expect(merge({ ...passingAdapter, gateCommands })).rejects.toThrow(/starts with '-'/);

      expect(gateCommands).not.toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    it('measures and merges the branch, not a lightweight tag named like it', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const tip = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();
      // A bare `pup/s1` resolves to the tag before the branch.
      commitIn(worktree, 'notes.txt', 'off-scope\n');
      sh(worktree, 'git', 'tag', BRANCH);
      sh(worktree, 'git', 'reset', '-q', '--hard', tip);

      const outcome = await merge();

      expect(outcome.status).toBe('merged');
      expect(sh(repo, 'git', 'rev-parse', 'refs/heads/main').trim()).toBe(tip);
      expect(existsSync(join(repo, 'notes.txt'))).toBe(false);
    });

    it('refuses a target name check-ref-format rejects, though it has no - or =', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      // A valid refname but no branch name; the HEAD file is the session's to write.
      sh(repo, 'git', 'update-ref', 'refs/heads/HEAD', 'main');
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/HEAD\n');
      const gateCommands = vi.fn(passingAdapter.gateCommands);

      await expect(merge({ ...passingAdapter, gateCommands })).rejects.toThrow(
        /HEAD is not a name git accepts for a branch/,
      );

      expect(gateCommands).not.toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    // check-ref-format accepts both, and the name is printed in every refusal.
    it.each([
      ['a bidi override', 'ma‮in'],
      ['a C1 control', 'ma\u009bin'],
    ])('refuses a target name carrying %s, before any stage runs', async (_label, name) => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      sh(repo, 'git', 'update-ref', `refs/heads/${name}`, 'main');
      sh(repo, 'git', 'symbolic-ref', 'HEAD', `refs/heads/${name}`);
      const gateCommands = vi.fn(passingAdapter.gateCommands);

      await expect(merge({ ...passingAdapter, gateCommands })).rejects.toThrow(
        /has a control or format character in its name/,
      );

      expect(gateCommands).not.toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    // The rebase runs on whatever the worktree has checked out; detached, it
    // leaves the branch where it was, and the pin is then no fast-forward.
    it.each([false, true])(
      'fails fresh-base for a pinned branch the target is not an ancestor of (openPr: %s)',
      async (openPr) => {
        const worktree = seedSession(db, repo);
        commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
        commitIn(repo, 'README.md', '# hello\n');
        const before = sh(repo, 'git', 'rev-parse', 'main').trim();
        sh(worktree, 'git', 'checkout', '-q', '--detach');
        if (openPr) {
          seedDebtBaseline({});
          addOrigin();
        }
        const gateCommands = vi.fn(passingAdapter.gateCommands);

        const outcome = await withFakeGh(fakeGh([]), () =>
          runMergeGate(db, {
            repoPath: repo,
            sessionId: SESSION_ID,
            adapters: [{ ...passingAdapter, gateCommands }],
            openPr,
          }),
        );

        expect(outcome.status).toBe('rejected');
        expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'fresh-base', status: 'fail' });
        expect(outcome.report.stages.at(-1)?.detail).toMatch(/is not based on main at/);
        expect(gateCommands).not.toHaveBeenCalled();
        expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(before);
        expect(ghCalls().some((call) => call.includes('pr create'))).toBe(false);
        expect(listEvents(db, SESSION_ID).some((event) => event.type === 'merge')).toBe(false);
      },
    );

    it('checks out the full tree past a planted sparse-checkout, deleting no trusted file', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      sh(repo, 'git', 'config', 'core.sparseCheckout', 'true');
      writeFileSync(join(repo, '.git', 'info', 'sparse-checkout'), 'src/feature.ts\n');

      expect((await merge()).status).toBe('merged');

      expect(existsSync(join(repo, 'src', 'app.ts'))).toBe(true);
      expect(existsSync(join(repo, 'src', 'feature.ts'))).toBe(true);
    });

    it('refuses when the checkout would overwrite a local change, moving nothing', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/app.ts', 'export const app = 2;\n');
      const before = sh(repo, 'git', 'rev-parse', 'main').trim();
      writeFileSync(join(repo, 'src', 'app.ts'), 'export const app = 3;\n');

      await expect(merge()).rejects.toThrow(/refused by the checkout; the ref was not moved/);

      expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(before);
      expect(readFileSync(join(repo, 'src', 'app.ts'), 'utf8')).toBe('export const app = 3;\n');
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    // Pinned through the symref, the branch would be main itself: an empty
    // diff passing every stage, then a delete through it that took main along.
    it('refuses a session branch turned into a symref to the target, and main survives', async () => {
      seedSession(db, repo);
      sh(repo, 'git', 'symbolic-ref', `refs/heads/${BRANCH}`, 'refs/heads/main');

      await expect(merge()).rejects.toThrow(/is a symbolic ref to refs\/heads\/main/);

      expect(sh(repo, 'git', 'rev-parse', '--verify', 'refs/heads/main').trim()).not.toBe('');
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    it('does not merge a commit added to the branch after the stages, and records the pinned sha', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const pinned = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();
      // `gateCommands` runs in-process after the pin: the session committing
      // while its stages run.
      const lateAdapter: Adapter = {
        ...passingAdapter,
        gateCommands: (repoPath) => {
          commitIn(worktree, 'src/late.ts', 'export const late = 1;\n');
          return passingAdapter.gateCommands(repoPath);
        },
      };

      const outcome = await merge(lateAdapter);

      expect(outcome.status).toBe('merged');
      expect(sh(repo, 'git', 'rev-parse', 'refs/heads/main').trim()).toBe(pinned);
      expect(existsSync(join(repo, 'src', 'late.ts'))).toBe(false);
      const mergeEvent = listEvents(db, SESSION_ID).find((event) => event.type === 'merge');
      expect(JSON.parse(mergeEvent?.payload ?? '{}')).toMatchObject({ sha: pinned });
      // Never measured, so kept for the operator rather than deleted.
      expect(sh(repo, 'git', 'rev-parse', `refs/heads/${BRANCH}`).trim()).not.toBe(pinned);
    });

    // The ratchet and the decision draft can throw, and the draft waits on
    // `claude -p`: the merge event must already exist by then, since main
    // holds the sha and `pup status` already reads merged.
    it('records the merge event before the decision draft, so a draft that throws loses nothing', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const pinned = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();
      vi.mocked(runUtility).mockImplementationOnce(() => {
        throw new Error('claude -p crashed');
      });

      await expect(merge()).rejects.toThrow('claude -p crashed');

      expect(sh(repo, 'git', 'rev-parse', 'refs/heads/main').trim()).toBe(pinned);
      const mergeEvent = listEvents(db, SESSION_ID).find((event) => event.type === 'merge');
      expect(JSON.parse(mergeEvent?.payload ?? '{}')).toMatchObject({ sha: pinned });
      expect(() =>
        sh(repo, 'git', 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`),
      ).toThrow();
    });

    it('names the commits a branch gained after the pin and records them as leftBehind', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const pinned = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();
      const lateAdapter: Adapter = {
        ...passingAdapter,
        gateCommands: (repoPath) => {
          commitIn(worktree, 'src/late.ts', 'export const late = 1;\n');
          commitIn(worktree, 'src/later.ts', 'export const later = 1;\n');
          return passingAdapter.gateCommands(repoPath);
        },
      };
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
      onTestFinished(() => warn.mockRestore());

      expect((await merge(lateAdapter)).status).toBe('merged');

      expect(sh(repo, 'git', 'rev-parse', 'refs/heads/main').trim()).toBe(pinned);
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines.filter((line) => line.includes('left behind'))).toEqual([
        `${BRANCH} moved after the gate pinned ${pinned}: 2 later commits were left behind on it, not merged.`,
      ]);
      const mergeEvent = listEvents(db, SESSION_ID).find((event) => event.type === 'merge');
      expect(JSON.parse(mergeEvent?.payload ?? '{}')).toMatchObject({
        sha: pinned,
        leftBehind: 2,
      });
    });

    it('prints nothing extra and records no leftBehind when the branch did not move', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const pinned = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
      onTestFinished(() => warn.mockRestore());

      expect((await merge()).status).toBe('merged');

      expect(warn.mock.calls.some((call) => String(call[0]).includes('left behind'))).toBe(false);
      const mergeEvent = listEvents(db, SESSION_ID).find((event) => event.type === 'merge');
      const payload = JSON.parse(mergeEvent?.payload ?? '{}');
      expect(payload.sha).toBe(pinned);
      expect(payload).not.toHaveProperty('leftBehind');
    });

    it('keeps the branch and completes a merge whose branch delete an interrupt killed', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const pinned = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const gitDir = tempDir('pup-git-');
      writeFileSync(
        join(gitDir, 'git'),
        `#!/bin/sh\ncase " $* " in *" update-ref --no-deref -d refs/heads/${BRANCH} "*) kill -TERM $$ ;; esac\nexec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );
      const originalPath = process.env.PATH;
      process.env.PATH = `${gitDir}:${originalPath}`;
      onTestFinished(() => {
        process.env.PATH = originalPath;
      });

      expect((await merge()).status).toBe('merged');

      expect(sh(repo, 'git', 'rev-parse', 'refs/heads/main').trim()).toBe(pinned);
      expect(sh(repo, 'git', 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(pinned);
      const mergeEvent = listEvents(db, SESSION_ID).find((event) => event.type === 'merge');
      expect(JSON.parse(mergeEvent?.payload ?? '{}')).not.toHaveProperty('leftBehind');
    });

    it('prints nothing and records no leftBehind when the branch is gone after the pin', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const pinned = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();
      const deletingAdapter: Adapter = {
        ...passingAdapter,
        gateCommands: (repoPath) => {
          sh(repo, 'git', 'update-ref', '-d', `refs/heads/${BRANCH}`);
          return passingAdapter.gateCommands(repoPath);
        },
      };
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
      onTestFinished(() => warn.mockRestore());

      expect((await merge(deletingAdapter)).status).toBe('merged');

      expect(sh(repo, 'git', 'rev-parse', 'refs/heads/main').trim()).toBe(pinned);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('left behind'))).toBe(false);
      const mergeEvent = listEvents(db, SESSION_ID).find((event) => event.type === 'merge');
      const payload = JSON.parse(mergeEvent?.payload ?? '{}');
      expect(payload.sha).toBe(pinned);
      expect(payload).not.toHaveProperty('leftBehind');
    });

    // Refused before the checkout is touched: the target is re-read right
    // before read-tree, so a moved target never leaves the main checkout on the
    // new tree with a restore line for a live session to arm against.
    it('refuses a target moved during the stages before touching the checkout', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const before = sh(repo, 'git', 'rev-parse', 'main').trim();
      const moved = sh(
        repo,
        'git',
        'commit-tree',
        '-p',
        before,
        '-m',
        'moved under the lock',
        `${before}^{tree}`,
      ).trim();
      const movingAdapter: Adapter = {
        ...passingAdapter,
        gateCommands: (repoPath) => {
          sh(repoPath, 'git', 'update-ref', 'refs/heads/main', moved);
          return passingAdapter.gateCommands(repoPath);
        },
      };

      const refusal = await (async () => {
        try {
          await merge(movingAdapter);
        } catch (error) {
          return (error as Error).message;
        }
      })();

      expect(refusal).toContain(`main moved from ${before} to ${moved} while the gate ran`);
      expect(refusal).toContain('nothing was checked out');
      expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(moved);
      // The main checkout's files are the target's, untouched.
      expect(existsSync(join(repo, 'src', 'feature.ts'))).toBe(false);
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
      expect(listEvents(db, SESSION_ID).some((event) => event.type === 'merge')).toBe(false);
      expect(existsSync(worktree)).toBe(true);
    });

    it('refuses attributes armed during the stages before the checkout runs a smudge', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const fired = join(repo, '.git', 'fired');
      const armingAdapter: Adapter = {
        ...passingAdapter,
        gateCommands: (repoPath) => {
          writeFileSync(join(repoPath, '.git', 'info', 'attributes'), '* filter=pwn\n');
          sh(repoPath, 'git', 'config', 'filter.pwn.smudge', `sh -c 'echo pwned >> ${fired}; cat'`);
          return passingAdapter.gateCommands(repoPath);
        },
      };
      const before = sh(repo, 'git', 'rev-parse', 'main').trim();

      await expect(merge(armingAdapter)).rejects.toThrow(ArmedGitDriverError);

      expect(existsSync(fired)).toBe(false);
      expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(before);
      expect(existsSync(join(repo, 'src', 'feature.ts'))).toBe(false);
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });
  });

  // `--accept-debt` files its ledger entries after the stages; a merge refused
  // after that must not leave them reading as merged from this session without
  // saying so (decision 82).
  describe('accepted debt and the refusals under the lock', () => {
    const refusalOf = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('expected a refusal');
    };
    const accept = { reason: 'deadline', reviewBy: 'before v2' };

    it('refuses a target moved during the stages before filing any ledger entry', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));
      const before = sh(repo, 'git', 'rev-parse', 'main').trim();
      const moved = sh(
        repo,
        'git',
        'commit-tree',
        '-p',
        before,
        '-m',
        'moved under the lock',
        `${before}^{tree}`,
      ).trim();
      const movingAdapter: Adapter = {
        ...passingAdapter,
        gateCommands: (repoPath) => {
          sh(repoPath, 'git', 'update-ref', 'refs/heads/main', moved);
          return passingAdapter.gateCommands(repoPath);
        },
      };

      const refusal = await refusalOf(() => merge(movingAdapter, accept));

      expect(refusal).toContain(`main moved from ${before} to ${moved} while the gate ran`);
      expect(refusal).not.toContain('ledger');
      expect(listLedgerEntries(db, 'proj-1')).toEqual([]);
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    // `assertTargetAt` runs before the HEAD re-read, so a target deleted or
    // turned into a symref is refused there, ahead of the "main worktree
    // moved" check, with nothing to arrange.
    it('refuses a target deleted during the stages as moved to nowhere, filing nothing', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));
      const before = sh(repo, 'git', 'rev-parse', 'main').trim();
      const deletingAdapter: Adapter = {
        ...passingAdapter,
        gateCommands: (repoPath) => {
          sh(repoPath, 'git', 'update-ref', '-d', 'refs/heads/main');
          return passingAdapter.gateCommands(repoPath);
        },
      };

      const refusal = await refusalOf(() => merge(deletingAdapter, accept));

      expect(refusal).toContain(`main moved from ${before} to nowhere while the gate ran`);
      expect(listLedgerEntries(db, 'proj-1')).toEqual([]);
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    it('refuses a target turned into a symref during the stages with the symref refusal', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));
      sh(repo, 'git', 'branch', 'other');
      const symrefAdapter: Adapter = {
        ...passingAdapter,
        gateCommands: (repoPath) => {
          sh(repoPath, 'git', 'symbolic-ref', 'refs/heads/main', 'refs/heads/other');
          return passingAdapter.gateCommands(repoPath);
        },
      };

      const refusal = await refusalOf(() => merge(symrefAdapter, accept));

      expect(refusal).toContain('refs/heads/main is a symbolic ref to refs/heads/other');
      expect(refusal).not.toContain('moved from');
      expect(listLedgerEntries(db, 'proj-1')).toEqual([]);
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    it('says the ledger entries were kept when a refusal that must stay last fires', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));
      const armingAdapter: Adapter = {
        ...passingAdapter,
        gateCommands: (repoPath) => {
          writeFileSync(join(repoPath, '.git', 'info', 'attributes'), '* filter=pwn\n');
          return passingAdapter.gateCommands(repoPath);
        },
      };

      let thrown: unknown;
      try {
        await merge(armingAdapter, accept);
      } catch (error) {
        thrown = error;
      }

      // Extended in place, so the refusal keeps its type.
      expect(thrown).toBeInstanceOf(ArmedGitDriverError);
      expect((thrown as Error).message).toContain(
        'The accepted-debt ledger entry was kept for the retry',
      );
      expect(listLedgerEntries(db, 'proj-1')).toHaveLength(1);
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    it('says nothing about the ledger on a late refusal when no debt was accepted', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      sh(repo, 'git', 'branch', 'elsewhere');
      const movingAdapter: Adapter = {
        ...passingAdapter,
        gateCommands: (repoPath) => {
          sh(repoPath, 'git', 'checkout', '-q', 'elsewhere');
          return passingAdapter.gateCommands(repoPath);
        },
      };

      const refusal = await refusalOf(() => merge(movingAdapter, accept));

      expect(refusal).toMatch(/moved from main to elsewhere/);
      expect(refusal).not.toContain('ledger');
    });

    // A fix round's session is gated again as a finished one (decision 90),
    // holding the entry its first gate filed. Only a re-gate skips a kind the
    // session holds (decision 86): here the figure grew, so the ledger keeps
    // what this gate let through beside what the first one did.
    it('files a grown figure beside an entry of its kind the session already holds', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(800));
      const held = `Oversize diff (700 lines) merged from session ${SESSION_ID}`;
      insertLedgerEntry(db, {
        projectId: 'proj-1',
        description: held,
        files: ['src/big.ts'],
        reason: 'older',
        acceptedBy: 'human',
        reviewBy: 'later',
      });

      const outcome = await merge(passingAdapter, accept);

      expect(outcome.status).toBe('merged');
      expect(outcome.report.stages.find((stage) => stage.stage === 'diff-size')?.status).toBe(
        'flagged',
      );
      expect(listLedgerEntries(db, 'proj-1').map((entry) => entry.description)).toEqual([
        held,
        expect.stringMatching(/^Oversize diff \(8\d\d lines\) merged from session /),
      ]);
    });
  });

  // Every stage and debt capability reads a private detached checkout of the
  // pinned sha, never the worktree the live session can edit while they run
  // (decision 81).
  describe('the gate checkout', () => {
    /** The checkout this gate registered, read from git while the gate runs. */
    const registeredCheckout = (): string | undefined =>
      sh(repo, 'git', 'worktree', 'list', '--porcelain')
        .split('\n')
        .map((line) => line.replace(/^worktree /, ''))
        .find((path) => GATE_CHECKOUT.test(path));
    const expectDropped = (checkout: string | undefined) => {
      expect(checkout).toMatch(GATE_CHECKOUT);
      expect(existsSync(dirname(checkout as string))).toBe(false);
      expect(registeredCheckout()).toBeUndefined();
    };
    /**
     * A shell build stage, and a hook run in-process once the checkout is cut;
     * answers the checkout the hook saw.
     */
    const adapterAfterCut = (
      build: string,
      hook: (repoPath: string) => void = () => {},
    ): { adapter: Adapter; checkout: () => string | undefined } => {
      let checkout: string | undefined;
      return {
        checkout: () => checkout,
        adapter: {
          ...passingAdapter,
          gateCommands: (repoPath) => {
            checkout = registeredCheckout();
            hook(repoPath);
            return [
              { stage: 'build', command: 'sh', args: ['-c', build] },
              ...passingAdapter.gateCommands(repoPath).filter((c) => c.stage !== 'build'),
            ];
          },
        },
      };
    };

    it('measures the pinned files when the worktree is edited after the pin', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      seedDebtBaseline({ deadExports: [], duplicatedLines: 0 });
      const { adapter, checkout } = adapterAfterCut('grep -q "feature = 1" src/feature.ts', () =>
        writeFileSync(join(worktree, 'src/feature.ts'), 'export const feature = 2;\n'),
      );
      let measured: string | undefined;

      const outcome = await merge(
        debtAdapter({
          ...adapter,
          deadCode: ({ measurePath }) => {
            measured = readFileSync(join(measurePath, 'src/feature.ts'), 'utf8');
            return [];
          },
        }),
      );

      expect(outcome.status).toBe('merged');
      expect(untimed(outcome.report.stages)).toContainEqual({ stage: 'build', status: 'pass' });
      expect(measured).toBe('export const feature = 1;\n');
      expectDropped(checkout());
    });

    it('drops the checkout after a pass', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const { adapter, checkout } = adapterAfterCut('test -f src/feature.ts');

      expect((await merge(adapter)).status).toBe('merged');

      expectDropped(checkout());
    });

    it('drops the checkout after a failed stage', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const { adapter, checkout } = adapterAfterCut('exit 1');

      expect((await merge(adapter)).status).toBe('rejected');

      expectDropped(checkout());
    });

    it('drops the checkout after a thrown gate', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const moved = sh(repo, 'git', 'commit-tree', '-p', 'main', '-m', 'moved', 'main^{tree}');
      const { adapter, checkout } = adapterAfterCut('true', (repoPath) =>
        sh(repoPath, 'git', 'update-ref', 'refs/heads/main', moved.trim()),
      );

      await expect(merge(adapter)).rejects.toThrow(/moved from/);

      expectDropped(checkout());
    });

    /** A `node_modules` with one package and a vite cache, ignored by git. */
    const installDeps = (dir: string, marker: string): void => {
      mkdirSync(join(dir, 'node_modules', '.vite'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'marker'), marker);
      writeFileSync(join(repo, '.git', 'info', 'exclude'), 'node_modules\n');
    };

    // Writable where the stage writes: vite's temp files go beside the
    // packages, and the caches start empty.
    it("links the main checkout's packages into a node_modules of its own", async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      installDeps(repo, 'main\n');
      const { adapter, checkout } = adapterAfterCut(
        'test ! -L node_modules && grep -q main node_modules/marker && ' +
          'test ! -e node_modules/.vite && mkdir node_modules/.vite-temp',
      );

      expect((await merge(adapter)).status).toBe('merged');

      // The links went with the checkout, not through it.
      expect(readFileSync(join(repo, 'node_modules', 'marker'), 'utf8')).toBe('main\n');
      expect(existsSync(join(repo, 'node_modules', '.vite-temp'))).toBe(false);
      expectDropped(checkout());
    });

    // The session can rewrite its own `.bin` while the stages run.
    it("links the main checkout's packages even when the worktree has its own", async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      installDeps(repo, 'main\n');
      installDeps(worktree, 'session\n');
      const { adapter } = adapterAfterCut('grep -q main node_modules/marker');

      expect((await merge(adapter)).status).toBe('merged');
    });

    it('checks out every committed file past a planted core.sparseCheckout', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      sh(repo, 'git', 'config', 'core.sparseCheckout', 'true');
      writeFileSync(join(repo, '.git', 'info', 'sparse-checkout'), '/src/app.ts\n');

      expect((await merge(adapterAfterCut('test -f src/feature.ts').adapter)).status).toBe(
        'merged',
      );
    });

    it('refuses filter drivers armed after the check before the lock, running no smudge', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      // The target moves, so the gate rebases: the session arms the drivers
      // as the rebase ends, after the check before the lock and before the cut.
      commitIn(repo, 'src/other.ts', 'export const other = 1;\n');
      const fired = join(repo, '.git', 'fired');
      const real = vi.mocked(execFileSync).getMockImplementation();
      vi.mocked(execFileSync).mockImplementation(((file: string, args: string[], opts: object) => {
        const output = real?.(file, args, opts as never);
        if (file === 'git' && args.includes('rebase')) {
          writeFileSync(join(repo, '.git', 'info', 'attributes'), '* filter=pwn\n');
          sh(repo, 'git', 'config', 'filter.pwn.smudge', `sh -c 'echo pwned >> ${fired}; cat'`);
        }
        return output;
      }) as never);
      onTestFinished(() => {
        vi.mocked(execFileSync).mockImplementation(real as never);
      });
      const gateCommands = vi.fn(passingAdapter.gateCommands);

      await expect(merge({ ...passingAdapter, gateCommands })).rejects.toThrow(ArmedGitDriverError);

      expect(existsSync(fired)).toBe(false);
      expect(gateCommands).not.toHaveBeenCalled();
      expect(registeredCheckout()).toBeUndefined();
    });

    // A stage can leave a directory nobody can remove; the gate's own outcome
    // still stands.
    it('keeps the outcome when the checkout cannot be dropped', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const { adapter, checkout } = adapterAfterCut('mkdir -p locked/inner && chmod 000 locked');
      onTestFinished(() => {
        const locked = join(checkout() as string, 'locked');
        if (existsSync(locked)) sh(repo, 'chmod', '700', locked);
        rmSync(dirname(checkout() as string), { recursive: true, force: true });
      });

      expect((await merge(adapter)).status).toBe('merged');

      expect(existsSync(join(checkout() as string, 'locked'))).toBe(true);
    });

    // A vendored node_modules is a committed file like any other (decision 81).
    it('keeps a node_modules the branch commits, when nothing in it links outside', async () => {
      const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'node_modules/**'] });
      const marker = sh(
        worktree,
        'sh',
        '-c',
        'printf vendored | git hash-object -w --stdin',
      ).trim();
      sh(
        worktree,
        'git',
        'update-index',
        '--add',
        '--cacheinfo',
        `100644,${marker},node_modules/vendored`,
      );
      sh(worktree, 'git', 'commit', '-q', '-m', 'vendor');
      // The index holds it; the worktree must too, or worktree-clean sees a deletion.
      mkdirSync(join(worktree, 'node_modules'), { recursive: true });
      writeFileSync(join(worktree, 'node_modules', 'vendored'), 'vendored');
      const adapter: Adapter = {
        ...passingAdapter,
        gateCommands: () => [
          { stage: 'build', command: 'test', args: ['-e', 'node_modules/vendored'] },
        ],
      };

      expect((await merge(adapter)).status).toBe('merged');
    });

    /** Commits a symlink at `path` pointing at `target` and mirrors it in the worktree. */
    function commitLink(worktree: string, path: string, target: string): void {
      const blob = sh(
        worktree,
        'sh',
        '-c',
        `printf %s ${JSON.stringify(target)} | git hash-object -w --stdin`,
      ).trim();
      sh(worktree, 'git', 'update-index', '--add', '--cacheinfo', `120000,${blob},${path}`);
      sh(worktree, 'git', 'commit', '-q', '-m', `link ${path}`);
      mkdirSync(dirname(join(worktree, path)), { recursive: true });
      symlinkSync(target, join(worktree, path));
    }

    // A committed link out of the checkout would reach the session's worktree,
    // wherever in the tree it sits, and whatever its path holds.
    it.each([
      ['under node_modules', 'node_modules/out'],
      ['anywhere in the tree', 'src/out'],
      ['with a tab in its path, beside a decoy', 'lib\tx'],
    ])('refuses a committed link that reaches outside the checkout, %s', async (_where, path) => {
      const worktree = seedSession(db, repo, { scopeIn: ['**'] });
      if (path.includes('\t')) commitIn(worktree, 'lib', 'decoy\n');
      commitLink(worktree, path, worktree);

      await expect(merge()).rejects.toThrow(
        /is a committed link that reaches outside the gate checkout/,
      );

      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    // A `..` after a named segment climbs from wherever that segment resolves at
    // stage time: an environment entry linked after the vet, or a committed
    // `b -> .`; no lexical reading knows, so such a target is refused.
    it.each([
      [
        'through an environment entry linked after the vet',
        '../node_modules/.bin/../../.worktrees/s1/src/real.ts',
      ],
      ['through a committed link to the checkout itself', 'b/b/../../../../../../../tmp/real.ts'],
    ])(
      'refuses a dangling committed link whose .. climbs past a named segment, %s',
      async (_how, target) => {
        const worktree = seedSession(db, repo);
        commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
        if (target.startsWith('b/')) commitLink(worktree, 'b', '.');
        commitLink(worktree, 'src/x.ts', target);

        await expect(merge()).rejects.toThrow(
          /src\/x\.ts is a committed link that reaches outside/,
        );
      },
    );

    it('refuses a dangling committed link that points outside the checkout', async () => {
      const worktree = seedSession(db, repo);
      commitLink(worktree, 'src/dangling', '/nowhere/at/all');

      await expect(merge()).rejects.toThrow(
        /src\/dangling is a committed link that reaches outside/,
      );
    });

    // A dangling link whose target stays inside adds no reach: build output,
    // a gitignored file, as the target branch may already carry.
    it('keeps a dangling committed link whose target stays inside the checkout', async () => {
      const worktree = seedSession(db, repo);
      commitLink(worktree, 'src/types.d.ts', '../dist/types.d.ts');

      expect((await merge()).status).toBe('merged');
    });
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

  it.runIf(process.platform === 'darwin')('ignores the declaration on darwin', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    vi.stubEnv('PUP_SANDBOX', 'vm');

    const outcome = await merge();

    expect(outcome.report.sandbox).toMatch(
      /^sandbox-exec \(macOS\)$|^inherited \(pup is itself sandboxed\)$/,
    );
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

  it('rejects on a build failure and stops the pipeline there', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

    const outcome = await merge(failingBuildAdapter);

    expect(outcome.status).toBe('rejected');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'build', status: 'fail' });
    expect(outcome.report.stages.map((s) => s.stage)).not.toContain('scope-audit');
    expect(steerPane).toHaveBeenCalled();
  });

  describe('an interrupted gate (decision 95)', () => {
    const sleeping: Adapter = {
      ...passingAdapter,
      gateCommands: () => [{ stage: 'test', command: 'sh', args: ['-c', 'sleep 47.5'] }],
    };

    it('ends a sleeping stage child on Ctrl-C and unwinds without waiting for it', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const before = process.listeners('SIGINT');
      const started = Date.now();

      const gate = merge(sleeping).catch((error: unknown) => error);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
      const child = vi.mocked(spawn).mock.results[0]?.value as ChildProcess;
      const checkout = (vi.mocked(spawn).mock.calls[0]?.[2] as { cwd?: string } | undefined)?.cwd;
      // What node does with a terminal's Ctrl-C: the lock's listener and the
      // seam's forwarder both run.
      for (const listener of process.listeners('SIGINT') as NodeJS.SignalsListener[]) {
        if (!before.includes(listener)) listener('SIGINT');
      }
      const failure = await gate;

      expect(failure).toBeInstanceOf(GateInterruptedError);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(() => process.kill(child.pid as number, 0)).toThrow();
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
      expect(steerPane).not.toHaveBeenCalled();
      expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
      expect(checkout).toMatch(GATE_CHECKOUT);
      expect(existsSync(checkout as string)).toBe(false);
      expect(process.listeners('SIGINT')).toEqual(before);
    });

    // The crash the interrupt used to end on: a removal that threw over the
    // gate's own result.
    it('reports a gate checkout it could not remove and still returns the stage results', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const { rmSync: removeForReal } = await vi.importActual<typeof import('node:fs')>('node:fs');
      const left: string[] = [];
      vi.mocked(rmSync).mockImplementation((path, options) => {
        if (!/\/pup-gate-checkout-[^/]+$/.test(String(path))) return removeForReal(path, options);
        left.push(String(path));
        throw Object.assign(new Error('ENOTEMPTY: directory not empty, rmdir'), {
          code: 'ENOTEMPTY',
        });
      });
      const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      onTestFinished(() => {
        vi.mocked(rmSync).mockImplementation(removeForReal);
        warn.mockRestore();
        for (const path of left) removeForReal(path, { recursive: true, force: true });
      });

      const outcome = await merge(failingBuildAdapter);

      expect(outcome.status).toBe('rejected');
      expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'build', status: 'fail' });
      expect(left).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        `Could not remove ${left[0]} (ENOTEMPTY); it is left behind.`,
      );
    });
  });

  // The scratch TMPDIR went with the process, which a test worker, the suite's
  // own and the conductor's alike, outlives or leaves without an `exit`.
  describe.each([
    ['passes', () => passingAdapter, 'merged'],
    ['refuses', () => failingBuildAdapter, 'rejected'],
  ] as const)('a gate that %s (decision 100)', (_, adapter, status) => {
    it("removes its checkout and its stage children's scratch TMPDIR before it returns", async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      expect((await merge(adapter())).status).toBe(status);

      const spawned = vi
        .mocked(spawn)
        .mock.calls.map(([, , options]) => options as { cwd?: string; env?: NodeJS.ProcessEnv });
      expect(spawned.length).toBeGreaterThan(0);
      for (const { cwd, env } of spawned) {
        expect(cwd).toMatch(GATE_CHECKOUT);
        expect(existsSync(dirname(cwd as string))).toBe(false);
        expect(env?.TMPDIR).toMatch(/\/pup-gate-[^/]+$/);
        expect(existsSync(env?.TMPDIR as string)).toBe(false);
      }
    });
  });

  describe('one instrumented test run (decision 95)', () => {
    /**
     * A TypeScript repo whose `vitest` is a fake that logs each run to a file
     * of its own in the gate's toolchain cache, the one place a child writes
     * that outlives the gate (its TMPDIR goes with it, decision 100), and,
     * asked for coverage, writes a report covering line 1 of src/feature.ts.
     * Returns the logged runs' argv.
     */
    function fakeVitest(testScript: string, passes = true): () => string[] {
      const log = `vitest-runs-${Math.random().toString(36).slice(2)}`;
      const logPath = (): string => {
        const call = vi.mocked(spawn).mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
        return join(call?.env?.XDG_CACHE_HOME ?? '', log);
      };
      onTestFinished(() => {
        rmSync(logPath(), { force: true });
      });
      commitIn(repo, '.gitignore', 'node_modules\n');
      commitIn(
        repo,
        'package.json',
        JSON.stringify({
          scripts: { test: testScript },
          devDependencies: { vitest: '3.2.4', '@vitest/coverage-v8': '3.2.4' },
        }),
      );
      const report = (file: string): string =>
        JSON.stringify({
          [file]: {
            path: file,
            statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
            s: { 0: 1 },
            fnMap: {},
            f: {},
            branchMap: {},
            b: {},
          },
        });
      const bin = join(repo, 'node_modules', '.bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, 'vitest'),
        [
          '#!/bin/sh',
          `echo "$*" >> "$XDG_CACHE_HOME/${log}"`,
          'for arg in "$@"; do case "$arg" in',
          '  --coverage.reportsDirectory=*) dir=$(printf %s "$arg" | cut -d= -f2-) ;;',
          'esac; done',
          `[ -n "$dir" ] && printf '%s' '${report('@CHECKOUT@/src/feature.ts')}' | sed "s|@CHECKOUT@|$(pwd -P)|g" > "$dir/coverage-final.json"`,
          passes ? 'exit 0' : 'echo " FAIL  src/a.test.ts > breaks"; exit 1',
        ].join('\n'),
        { mode: 0o755 },
      );
      return () => {
        const path = logPath();
        return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
      };
    }

    it('runs the suite once, and takes the test stage and the coverage figure from it', async () => {
      const runs = fakeVitest('vitest run');
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      seedDebtBaseline({ coverageRatio: 0.5 });

      const outcome = await merge(typescriptAdapter);

      expect(runs()).toEqual([expect.stringMatching(/^run --coverage\.enabled /)]);
      expect(untimed(outcome.report.stages)).toContainEqual({ stage: 'test', status: 'pass' });
      expect(untimed(outcome.report.stages)).toContainEqual({
        stage: 'coverage',
        status: 'pass',
        detail: expect.stringContaining('100%'),
      });
    });

    // A script the instrumented run does not reproduce keeps its own run: the
    // test stage must pass on the run the repo declared (decision 95).
    it('keeps the declared test run apart when the script is more than a plain vitest run', async () => {
      const runs = fakeVitest('vitest run --reporter=dot');
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      seedDebtBaseline({ coverageRatio: 0.5 });

      const outcome = await merge(typescriptAdapter);

      expect(runs()).toEqual([
        'run --reporter=dot',
        expect.stringMatching(/^run --coverage\.enabled /),
      ]);
      expect(untimed(outcome.report.stages)).toContainEqual({ stage: 'test', status: 'pass' });
      expect(outcome.report.stages).toContainEqual(
        expect.objectContaining({ stage: 'coverage', status: 'pass' }),
      );
    });

    it('fails the test stage on a failing instrumented run, re-run once, and reads no coverage', async () => {
      const runs = fakeVitest('vitest', false);
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      const outcome = await merge(typescriptAdapter);

      expect(outcome.status).toBe('rejected');
      expect(runs()).toEqual([
        expect.stringMatching(/^run --coverage\.enabled /),
        expect.stringMatching(/^run --coverage\.enabled /),
      ]);
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: 'test',
        status: 'fail',
        detail: expect.stringContaining('src/a.test.ts > breaks'),
      });
      expect(outcome.report.stages.map((s) => s.stage)).not.toContain('coverage');
    });
  });

  // Each read-only stage waits for none of the others: the test stage below
  // passes only if lint and every debt capability ran while it was running.
  it('runs lint and the debt capabilities alongside the test run, reporting in order', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const markers = ['lint', 'dead-code', 'duplication', 'complexity'];
    const waitForAll =
      'i=0; while [ $i -lt 100 ]; do ' +
      `${markers.map((m) => `[ -e ${m}.ran ]`).join(' && ')} && exit 0; ` +
      'sleep 0.1; i=$((i+1)); done; echo "ran alone"; exit 2';
    const mark = (ctx: CapabilityContext, marker: string): void => {
      if (ctx.measurePath !== repo) writeFileSync(join(ctx.measurePath, `${marker}.ran`), '');
    };
    const adapter = debtAdapter({
      gateCommands: () => [
        { stage: 'build', command: 'true', args: [] },
        { stage: 'test', command: 'sh', args: ['-c', waitForAll] },
        { stage: 'lint', command: 'sh', args: ['-c', 'touch lint.ran'] },
      ],
      deadCode: (ctx) => {
        mark(ctx, 'dead-code');
        return [];
      },
      duplication: (ctx) => {
        mark(ctx, 'duplication');
        return { duplicatedLines: 0, blocks: [] };
      },
      complexity: (ctx) => {
        mark(ctx, 'complexity');
        return [];
      },
    });

    seedDebtBaseline({ deadExports: [], duplicatedLines: 0 });

    const outcome = await merge(adapter);

    expect(outcome.status).toBe('merged');
    expect(outcome.report.stages.map(({ stage, status }) => `${stage}:${status}`)).toEqual([
      'worktree-clean:pass',
      'fresh-base:pass',
      'build:pass',
      'test:pass',
      'lint:pass',
      'scope-audit:pass',
      'diff-size:pass',
      'dead-code:pass',
      'duplication:pass',
      'complexity:pass',
      'coverage:skipped',
    ]);
  });

  describe('stage wall times (decision 95)', () => {
    it('times every stage that ran something, and none that ran nothing', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const adapter = debtAdapter({
        gateCommands: () => [
          { stage: 'build', command: 'true', args: [] },
          { stage: 'test', command: 'sh', args: ['-c', 'sleep 0.3'] },
          { stage: 'lint', command: 'true', args: [] },
        ],
      });
      seedDebtBaseline({ deadExports: [], duplicatedLines: 0 });

      const outcome = await merge(adapter);

      expect(outcome.status).toBe('merged');
      const timed = outcome.report.stages.filter((s) => s.durationMs !== undefined);
      // Coverage skips as "adapter cannot measure": no capability ran.
      expect(outcome.report.stages.filter((s) => s.durationMs === undefined)).toEqual([
        expect.objectContaining({ stage: 'coverage', status: 'skipped' }),
      ]);
      expect(timed.map((s) => s.stage)).toEqual([
        'worktree-clean',
        'fresh-base',
        'build',
        'test',
        'lint',
        'scope-audit',
        'diff-size',
        'dead-code',
        'duplication',
        'complexity',
      ]);
      expect(timed.find((s) => s.stage === 'test')?.durationMs).toBeGreaterThanOrEqual(250);
    });

    it('prints each time in the report the session is steered with', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const slowFailure: Adapter = {
        id: 'fake',
        detect: () => true,
        gateCommands: () => [
          { stage: 'build', command: 'sh', args: ['-c', 'sleep 0.2; echo broke >&2; exit 1'] },
        ],
      };

      const outcome = await merge(slowFailure);

      expect(outcome.status).toBe('rejected');
      const steered = vi.mocked(steerPane).mock.calls[0]?.[1] as string;
      expect(steered).toMatch(/^- worktree-clean: PASS \(\d+\.\ds\)$/m);
      expect(steered).toMatch(/^- build: FAIL \((0\.[2-9]|[1-9]\d*\.\d)s\) — .*broke/m);
    });
  });

  // A worker's suite runs at nice 10 and the gate's at pup's own priority, but
  // a loaded host can still tip a timing-sensitive test over: the test stage
  // gets one re-run under the same lock before it counts (decision 94).
  describe('test stage re-run', () => {
    /** A stage command that fails its first run in this checkout, then `then`. */
    const failsOnce = (then: string): string =>
      'if [ -e .ran-once ]; then ' +
      then +
      '; fi; touch .ran-once; printf " FAIL  src/a.test.ts > times out under load\\n"; exit 1';

    const adapterWith = (stage: 'build' | 'test' | 'lint', script: string): Adapter => ({
      ...passingAdapter,
      gateCommands: () =>
        passingAdapter
          .gateCommands(repo)
          .map((c) =>
            c.stage === stage ? { stage, command: 'sh', args: ['-c', script, `${stage}-run`] } : c,
          ),
    });

    /** How many times the gate spawned the command marked `marker`, sandboxed or bare. */
    const runsOf = (marker: string): number =>
      vi.mocked(spawn).mock.calls.filter(([, args]) => args?.includes(marker)).length;

    it('passes a test stage that passes on its re-run, named flaky with what failed', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      const outcome = await merge(adapterWith('test', failsOnce('exit 0')));

      expect(outcome.status).toBe('merged');
      expect(runsOf('test-run')).toBe(2);
      expect(untimed(outcome.report.stages)).toContainEqual({
        stage: 'test',
        status: 'pass',
        detail:
          'flaky — failed, then passed on its one re-run; failing the first time: ' +
          'src/a.test.ts > times out under load',
      });
    });

    it('rejects a test stage that fails its re-run too, naming both runs’ failures', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      const outcome = await merge(
        adapterWith('test', failsOnce('printf "FAILED tests/b.py::test_other\\n"; exit 1')),
      );

      expect(outcome.status).toBe('rejected');
      expect(runsOf('test-run')).toBe(2);
      const stage = outcome.report.stages.at(-1);
      expect(stage).toMatchObject({ stage: 'test', status: 'fail' });
      expect(stage?.detail).toMatch(
        /^failed twice — failing the first time: src\/a\.test\.ts > times out under load; on the re-run: tests\/b\.py::test_other\n/,
      );
      expect(steerPane).toHaveBeenCalled();
    });

    // A Ctrl-C reaches the gate's child with pup itself, and a stage timeout
    // kills it with SIGTERM: a re-run that passed would turn an abort into a
    // merge, or hold the lock twice as long on a hung suite.
    it.each([
      ['killed by SIGINT', 'kill -INT $$'],
      ['killed by SIGTERM, as a stage timeout is', 'kill -TERM $$'],
      ['exiting 130 on an interrupt it caught', 'exit 130'],
      ['exiting 2, as pytest does on an interrupt', 'exit 2'],
    ])('never re-runs a test stage %s', async (_case, end) => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      const outcome = await merge(
        adapterWith('test', `if [ -e .ran-once ]; then exit 0; fi; touch .ran-once; ${end}`),
      );

      expect(outcome.status).toBe('rejected');
      expect(runsOf('test-run')).toBe(1);
      expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'test', status: 'fail' });
    });

    it('never re-runs a test stage that ran out its timeout, even one that trapped the SIGTERM', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      gateTimeout.ms = 2_000;
      onTestFinished(() => {
        gateTimeout.ms = undefined;
      });

      // The runner traps the timeout's SIGTERM and exits 1 by itself: an
      // ordinary status, told apart only by the code the timeout leaves.
      const outcome = await merge(adapterWith('test', "trap 'exit 1' TERM; sleep 10 & wait"));

      expect(outcome.status).toBe('rejected');
      expect(runsOf('test-run')).toBe(1);
      expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'test', status: 'fail' });
    });

    it.each(['build', 'lint'] as const)('never re-runs a failed %s', async (stage) => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      const outcome = await merge(adapterWith(stage, failsOnce('exit 0')));

      expect(outcome.status).toBe('rejected');
      expect(runsOf(`${stage}-run`)).toBe(1);
      expect(outcome.report.stages.at(-1)).toMatchObject({ stage, status: 'fail' });
    });

    it('runs its stages at the priority pup runs at, never under nice', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      expect((await merge(adapterWith('test', 'exit 0'))).status).toBe('merged');

      const call = vi.mocked(spawn).mock.calls.find(([, args]) => args?.includes('test-run'));
      expect(call).toBeDefined();
      const argv = [call?.[0], ...(call?.[1] ?? [])].map(String);
      expect(argv.some((word) => word === 'nice' || word.endsWith('/nice'))).toBe(false);
    });
  });

  it('steers a stage detail as plain text when the command output carries ANSI escapes', async () => {
    // Live on 2026-09-12: vitest coloured its failure, the escapes went into the
    // report whole, and the pane could not show the paste as the bytes that were
    // sent — so `pasteLanded` refused a steer to a session that was right there.
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const colouredAdapter: Adapter = {
      id: 'fake',
      detect: () => true,
      gateCommands: () => [
        {
          stage: 'build',
          command: 'sh',
          args: [
            '-c',
            'printf "\\033[31mFAIL\\033[0m expected \\033[1m1\\033[22m to be 2\\n"; exit 1',
          ],
        },
      ],
    };

    const outcome = await merge(colouredAdapter);

    expect(outcome.status).toBe('rejected');
    const steered = vi.mocked(steerPane).mock.calls[0]?.[1] as string;
    expect(steered).toContain('FAIL expected 1 to be 2');
    expect(steered).not.toContain('\u001b');
    // The operator's own print and the PR body read the stored detail, so the
    // escapes must be gone from the report too, not only from the steer.
    expect(outcome.report.stages.at(-1)?.detail).toBe('FAIL expected 1 to be 2');
  });

  it('runs gate commands without the operator secrets in pup’s own environment', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    vi.stubEnv('PUP_TEST_SECRET', 'sk-do-not-leak');
    // Fails the stage if the child inherited the secret, or lost PATH with it.
    const envProbeAdapter: Adapter = {
      id: 'fake',
      detect: () => true,
      gateCommands: () => [
        {
          stage: 'build',
          command: 'sh',
          args: ['-c', 'test -z "$PUP_TEST_SECRET" && test -n "$PATH"'],
        },
      ],
    };

    const outcome = await merge(envProbeAdapter);

    expect(outcome.status).toBe('merged');
    expect(outcome.report.stages).toContainEqual(
      expect.objectContaining({ stage: 'build', status: 'pass' }),
    );
  });

  it('does not run repo git hooks, which a session can plant unseen by the scope audit', async () => {
    const worktree = seedSession(db, repo);
    commitIn(repo, 'src/app.ts', 'export const app = 2;\n');
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    // Shared with every worktree and untracked, so nothing in the diff shows it.
    const fired = join(repo, 'hook-fired');
    const hooks = join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const hook of ['pre-rebase', 'post-checkout', 'post-rewrite', 'post-merge']) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${fired}\n`, { mode: 0o755 });
    }

    const outcome = await merge();

    // The stale branch forces the rebase path, so pre-rebase would have fired.
    expect(outcome.status).toBe('merged');
    expect(existsSync(fired)).toBe(false);
  });

  // The auto-rebase checks out every file and runs a merge driver on every
  // conflict, with the operator's environment and ahead of the sandbox that
  // confines the stages. The driver name is chosen by whoever wrote it, so
  // there is no `-c` disarm and the gate refuses instead (decision 50).
  describe('armed filter and merge drivers', () => {
    /** Written by the armed scripts if they ever run; nothing else creates it. */
    let fired: string;

    beforeEach(() => {
      fired = join(tempDir('pup-gate-fired-'), 'fired');
    });

    /** What a session can write from its worktree: both live under `.git/`. */
    function arm(): void {
      writeFileSync(join(repo, '.git', 'info', 'attributes'), '* filter=pwn merge=pwn\n');
      sh(repo, 'git', 'config', 'filter.pwn.smudge', `sh -c 'echo pwned >> ${fired}; cat'`);
      sh(repo, 'git', 'config', 'merge.pwn.driver', `sh -c 'echo pwned >> ${fired}' %A %O %B`);
    }

    it('refuses before the auto-rebase, and the smudge script never runs', async () => {
      const worktree = seedSession(db, repo);
      // A stale branch, so the gate would take the rebase path.
      commitIn(repo, 'README.md', '# hello\n');
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      arm();

      await expect(merge()).rejects.toThrow(ArmedGitDriverError);
      expect(existsSync(fired)).toBe(false);
      // Refused, not rejected: nothing here is the session's to fix by re-steer.
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
      expect(steerPane).not.toHaveBeenCalled();
    });

    it('names both surfaces so the operator knows what to clear', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      arm();

      await expect(merge()).rejects.toThrow(/info\/attributes.*filter\.pwn\.smudge/);
    });

    // `extensions.worktreeConfig` lives in the shared config, so a session can
    // turn it on and then write a driver into its own worktree's config, which
    // a read of the main checkout alone would never see — and the rebase runs
    // in that worktree.
    it("refuses a driver set in the session worktree's own config", async () => {
      const worktree = seedSession(db, repo);
      commitIn(repo, 'README.md', '# hello\n');
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      writeFileSync(join(repo, '.git', 'info', 'attributes'), '* filter=pwn\n');
      sh(worktree, 'git', 'config', 'extensions.worktreeConfig', 'true');
      sh(
        worktree,
        'git',
        'config',
        '--worktree',
        'filter.pwn.smudge',
        `sh -c 'echo pwned >> ${fired}; cat'`,
      );

      await expect(merge()).rejects.toThrow(ArmedGitDriverError);
      expect(existsSync(fired)).toBe(false);
    });

    it('merges normally once the drivers are cleared', async () => {
      const worktree = seedSession(db, repo);
      commitIn(repo, 'README.md', '# hello\n');
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      expect((await merge()).status).toBe('merged');
      expect(existsSync(fired)).toBe(false);
    });
  });

  // The gate's status and rebase run in the worktree outside any sandbox, and
  // the session can rewrite the gitfile and the commondir that choose which
  // repo's config git reads there, clean filters included (decision 101).
  describe('worktree git pointers the session rewrote', () => {
    let marker: string;

    beforeEach(() => {
      marker = join(tempDir('pup-gate-fired-'), 'fired');
    });

    /** A repo tracking `file`, with a clean filter armed on every path. */
    function armedRepo(dir: string, file: string): string {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      sh(dir, 'git', 'init', '-q');
      writeFileSync(join(dir, file), 'export const app = 1;\n');
      sh(dir, 'git', 'add', '-A');
      sh(dir, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'armed');
      sh(dir, 'git', 'config', 'filter.pwn.clean', `sh -c 'echo pwned >> ${marker}; cat'`);
      writeFileSync(join(dir, '.git/info/attributes'), '* filter=pwn\n');
      return join(dir, '.git');
    }

    /** Proves the plant live with plain git, then makes the file stale again for the gate. */
    function expectPlainGitFires(worktree: string, stale: string): void {
      const later = () => new Date(Date.now() + 60_000);
      utimesSync(stale, later(), later());
      sh(worktree, 'git', 'status', '--porcelain');
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      utimesSync(stale, later(), later());
    }

    it.each([
      ['a repointed gitfile', (worktree: string) => [join(worktree, '.git'), 'gitdir: ']],
      [
        'a rewritten commondir',
        () => [join(repo, '.git', 'worktrees', SESSION_ID, 'commondir'), ''],
      ],
    ])('refuses %s before any git runs there', async (_, pointer) => {
      const worktree = seedSession(db, repo);
      // A stale branch, so the gate would take the rebase path.
      commitIn(repo, 'README.md', '# hello\n');
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const armed = armedRepo(tempDir('pup-armed-'), 'src/app.ts');
      const [file, prefix] = pointer(worktree) as [string, string];
      writeFileSync(file, `${prefix}${armed}\n`);
      expectPlainGitFires(worktree, join(worktree, 'src/app.ts'));

      await expect(merge()).rejects.toThrow(WorktreeRepointedError);
      expect(existsSync(marker)).toBe(false);
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    it('holds the pins when the gitfile is swapped after each check', async () => {
      const worktree = seedSession(db, repo);
      commitIn(repo, 'README.md', '# hello\n');
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const gitfile = join(worktree, '.git');
      const trusted = readFileSync(gitfile, 'utf8');
      const swapped = `gitdir: ${armedRepo(tempDir('pup-armed-'), 'src/app.ts')}\n`;
      writeFileSync(gitfile, swapped);
      expectPlainGitFires(worktree, join(worktree, 'src/app.ts'));
      let checks = 0;
      pointerSwap.around = (check) => {
        writeFileSync(gitfile, trusted);
        check();
        checks += 1;
        writeFileSync(gitfile, swapped);
      };
      onTestFinished(() => {
        pointerSwap.around = undefined;
        writeFileSync(gitfile, trusted);
      });

      // Merged under the pins; only the teardown, which validates the gitfile
      // itself, refuses the swapped one, and loudly.
      await expect(merge()).rejects.toThrow(/worktree remove/);
      expect(getSession(db, SESSION_ID)?.state).toBe('merged');
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(existsSync(marker)).toBe(false);
    });

    it('runs no child git in a gitlink over a .git the session made', async () => {
      const worktree = seedSession(db, repo);
      commitIn(repo, 'README.md', '# hello\n');
      const sub = join(worktree, 'src/sub');
      armedRepo(sub, 'app.ts');
      const head = sh(sub, 'git', 'rev-parse', 'HEAD').trim();
      sh(worktree, 'git', 'update-index', '--add', '--cacheinfo', `160000,${head},src/sub`);
      sh(worktree, 'git', 'commit', '-q', '-m', 'gitlink');
      expectPlainGitFires(worktree, join(sub, 'app.ts'));

      expect((await merge()).status).toBe('merged');
      expect(existsSync(marker)).toBe(false);
    });
  });

  it('hard-fails changes outside the task scope', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'notes.txt', 'off-scope\n');

    const outcome = await merge();

    expect(outcome.status).toBe('rejected');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'scope-audit', status: 'fail' });
    expect(outcome.report.stages.at(-1)?.detail).toContain('notes.txt');
  });

  // The store is session-writable: a spec that is not JSON is a refusal naming
  // the task, with the lock released and the session left reviewable.
  it('refuses a task whose stored spec is not JSON with a typed error', async () => {
    seedSession(db, repo);
    db.prepare("UPDATE tasks SET spec = 'not json {' WHERE id = ?").run(`task-${SESSION_ID}`);

    await expect(merge()).rejects.toThrow(MalformedTaskSpecError);
    await expect(merge()).rejects.toThrow(`Task task-${SESSION_ID} has an unusable spec`);
    expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
  });

  it('hard-fails a session that edits the adapter escape-hatch config', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, '.pupitre/adapter.yml', 'test: echo ok\n');

    const outcome = await merge();

    expect(outcome.status).toBe('rejected');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'scope-audit', status: 'fail' });
    expect(outcome.report.stages.at(-1)?.detail).toContain('.pupitre/adapter.yml (protected path)');
  });

  it('hard-fails a protected .claude path even when git would C-quote its name', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, '.claude/café.md', 'smuggled hook config\n');

    const outcome = await merge();

    expect(outcome.status).toBe('rejected');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'scope-audit', status: 'fail' });
    expect(outcome.report.stages.at(-1)?.detail).toContain('café.md (protected path)');
  });

  it('resolves gate commands from the trusted main checkout, not the session worktree', async () => {
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

    await merge(recordingAdapter);

    expect(resolvedFrom).toEqual([repo]);
  });

  it('fails preflight when the worktree is dirty', async () => {
    const worktree = seedSession(db, repo);
    writeFileSync(join(worktree, 'src/uncommitted.ts'), 'export const x = 1;\n');

    const outcome = await merge();

    expect(outcome.status).toBe('rejected');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'worktree-clean', status: 'fail' });
  });

  it('flags open debt entries whose files the merged diff touched, but never its own', async () => {
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

    const outcome = await merge(passingAdapter, { reason: 'deadline', reviewBy: 'before v2' });

    expect(outcome.status).toBe('merged');
    expect(outcome.debtCandidates).toEqual([{ id: openId, description: 'shortcut in feature.ts' }]);
  });

  it('refuses an oversize diff without --accept-debt and leaves the session reviewable', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));

    const outcome = await merge();

    expect(outcome.status).toBe('refused');
    expect(outcome.report.stages).toContainEqual(
      expect.objectContaining({ stage: 'diff-size', status: 'flagged' }),
    );
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    expect(getSession(db, SESSION_ID)?.reject_count).toBe(0);
    expect(steerPane).not.toHaveBeenCalled();
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

  it('records the acceptor the request names, not a hardcoded human', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));

    const outcome = await runMergeGate(db, {
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: [passingAdapter],
      acceptDebt: { reason: 'deadline', reviewBy: 'before v2', acceptedBy: SESSION_ID },
    });

    expect(outcome.status).toBe('merged');
    expect(listLedgerEntries(db, 'proj-1')[0]?.accepted_by).toBe(SESSION_ID);
  });

  // The approver is a relay's word (`--approved-by`, decision 75); the store
  // keeps it scrubbed, whichever caller built the request.
  it('scrubs control characters out of the acceptor before the ledger keeps it', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));

    const outcome = await runMergeGate(db, {
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: [passingAdapter],
      acceptDebt: {
        reason: 'deadline',
        reviewBy: 'before v2',
        acceptedBy: 'tg:\u001b[2Jalexis\u009b',
      },
    });

    expect(outcome.status).toBe('merged');
    expect(listLedgerEntries(db, 'proj-1')[0]?.accepted_by).toBe('tg: [2Jalexis');
  });

  it('counts a lockfile-named file outside the repo root toward the diff size', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/pnpm-lock.yaml', 'generated: line\n'.repeat(700));

    const outcome = await merge();

    expect(outcome.status).toBe('refused');
    expect(outcome.report.stages).toContainEqual(
      expect.objectContaining({ stage: 'diff-size', status: 'flagged' }),
    );
  });

  // `info/attributes` is refused outright (decision 50), but `core.attributesFile`
  // in the shared config forges the same `-\t-` numstat and is no driver, so the
  // count has to survive it rather than the gate refuse it (decision 53).
  describe('with a session-written attribute telling git every file is binary', () => {
    function forgeBinary(): void {
      const attributes = join(repo, '.git', 'forged-attributes');
      writeFileSync(attributes, '* -diff\n');
      sh(repo, 'git', 'config', 'core.attributesFile', attributes);
    }

    it('recounts an oversize diff and flags it instead of passing', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));
      forgeBinary();

      const outcome = await merge();

      expect(outcome.status).toBe('refused');
      const stage = outcome.report.stages.find((s) => s.stage === 'diff-size');
      expect(stage?.status).toBe('flagged');
      expect(stage?.detail).toContain('700 changed lines exceeds the 600-line flag');
      expect(stage?.detail).toContain('src/big.ts');
    });

    it('flags a forged binary even when the recounted diff is small', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      forgeBinary();

      const outcome = await merge();

      expect(outcome.status).toBe('refused');
      expect(outcome.report.stages).toContainEqual(
        expect.objectContaining({ stage: 'diff-size', status: 'flagged' }),
      );
    });

    it('still counts a real binary as free', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/image.bin', 'x\0y\n'.repeat(700));
      forgeBinary();

      const outcome = await merge();

      expect(outcome.status).toBe('merged');
      expect(untimed(outcome.report.stages)).toContainEqual({
        stage: 'diff-size',
        status: 'pass',
        detail: '0 changed lines',
      });
    });
  });

  it('parks the session as blocked once the reject cap is reached', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    incrementRejectCount(db, SESSION_ID);
    incrementRejectCount(db, SESSION_ID);

    const outcome = await merge(failingBuildAdapter);

    expect(outcome.status).toBe('blocked');
    expect(outcome.rejectCount).toBe(3);
    expect(getSession(db, SESSION_ID)?.state).toBe('blocked');
    expect(steerPane).not.toHaveBeenCalled();
  });

  it('blocks instead of rejecting when the re-steer cannot be delivered', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    vi.mocked(steerPane).mockImplementationOnce(() => {
      throw new Error('no tmux session');
    });

    const outcome = await merge(failingBuildAdapter);

    expect(outcome.status).toBe('blocked');
    expect(getSession(db, SESSION_ID)?.state).toBe('blocked');
    // A window that is gone keeps the reason it always had.
    expect(blockedReason(db)).toBe('re-steer failed — session unreachable');
  });

  it('blocks with the refusal itself as the reason when the re-steer is not delivered', async () => {
    // A refused paste leaves a reachable session with an empty box, which
    // `session unreachable` sends the human to the wrong place (decision 45).
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    vi.mocked(steerPane).mockImplementationOnce(() => {
      throw new SteerNotDeliveredError(SESSION_ID, 1234, 'box-not-cleared');
    });

    const outcome = await merge(failingBuildAdapter);

    expect(outcome.status).toBe('blocked');
    expect(getSession(db, SESSION_ID)?.state).toBe('blocked');
    const reason = blockedReason(db);
    expect(reason).toContain(SESSION_ID);
    expect(reason).toContain('1234-char');
    expect(reason).toContain('Ctrl-U could not clear');
    expect(reason).not.toContain('unreachable');
  });

  it('blocks, and types nothing, when the session has no pane recorded to re-steer into', async () => {
    // A session target would resolve to whichever pane is active, which the
    // agent can move; with no pane pinned there is nothing to address, and the
    // gate parks the session rather than paste its report anywhere (decision 46).
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    db.prepare('UPDATE sessions SET tmux_target = NULL WHERE id = ?').run(SESSION_ID);
    vi.mocked(steerPane).mockImplementationOnce(() => {
      throw new Error('steerPane must not be reached without a pane');
    });

    const outcome = await merge(failingBuildAdapter);

    expect(outcome.status).toBe('blocked');
    expect(getSession(db, SESSION_ID)?.state).toBe('blocked');
    expect(steerPane).not.toHaveBeenCalled();
  });

  it('refuses to run while another merge holds the lock', async () => {
    seedSession(db, repo);
    mkdirSync(join(repo, '.git', 'pup-merge.lock'));

    await expect(merge()).rejects.toThrow(MergeLockHeldError);
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
  });

  it('throws for a session that is not awaiting review', async () => {
    seedSession(db, repo);
    transitionSession(db, SESSION_ID, 'running');

    await expect(merge()).rejects.toThrow(SessionNotReviewableError);
  });

  // Not "every stage skipped and merged anyway": with no adapter the hard
  // stages report "no command available" and every debt stage "adapter cannot
  // measure", so a full-looking report would sit on top of nothing measured.
  it('refuses a request that carries no adapter at all, before taking the lock', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

    await expect(merge([])).rejects.toThrow(/No adapter for/);
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
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

  it('measures the gate checkout but reads tool config from the main checkout', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    seedDebtBaseline({ deadExports: [], duplicatedLines: 0 });
    let seen: CapabilityContext | undefined;
    const adapter = debtAdapter({
      deadCode: (ctx) => {
        seen = ctx;
        return [];
      },
    });

    await merge(adapter);

    // Split on purpose: a session that edits its own manifest must not be able
    // to un-declare the tool that measures it (decision 29).
    expect(seen).toEqual({ measurePath: expect.stringMatching(GATE_CHECKOUT), configPath: repo });
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

  // Decision 58 leaves a nested package out of every root measurement on the
  // claim that its own runner covers it; decision 59 makes the gate run it.
  describe('a diff touching a nested package', () => {
    const NESTED_SCOPE = { scopeIn: ['src/**', 'tools/**'] };
    /** The real resolver: nested markers read from both checkouts' HEAD. */
    const nestedAdapter = (overrides: Partial<Adapter> = {}): Adapter => ({
      ...passingAdapter,
      touchedNestedPackages: typescriptAdapter.touchedNestedPackages,
      ...overrides,
    });
    /** Commits a nested package on main, so both checkouts carry its marker. */
    const commitNestedPackage = (scripts: Record<string, string>): void =>
      commitIn(repo, 'tools/review/package.json', JSON.stringify({ scripts }));

    // A standalone package resolves from its own directory, so it gets its own
    // environment from the main checkout, not the root's (decision 81).
    it("gives the package the main checkout's own node_modules, before any stage runs", async () => {
      commitNestedPackage({ test: 'test -e node_modules/marker', typecheck: 'true' });
      mkdirSync(join(repo, 'tools', 'review', 'node_modules'), { recursive: true });
      writeFileSync(join(repo, 'tools', 'review', 'node_modules', 'marker'), '');
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      commitIn(worktree, 'tools/review/src/r.ts', 'export const r = 1;\n');
      // The root build stage runs first and already sees the nested environment.
      const adapter = nestedAdapter({
        gateCommands: () => [
          { stage: 'build', command: 'test', args: ['-e', 'tools/review/node_modules/marker'] },
          { stage: 'test', command: 'true', args: [] },
          { stage: 'lint', command: 'true', args: [] },
        ],
      });

      expect((await merge(adapter)).status).toBe('merged');
    });

    it("refuses the merge when the package's own test script fails", async () => {
      commitNestedPackage({ test: 'echo nested-test-ran; exit 3', typecheck: 'true' });
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      commitIn(worktree, 'tools/review/src/r.ts', 'export const r = 1;\n');

      const outcome = await merge(nestedAdapter());

      expect(outcome.status).toBe('rejected');
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: 'test (tools/review)',
        status: 'fail',
        detail: expect.stringContaining('nested-test-ran'),
      });
      expect(sh(repo, 'git', 'log', '--oneline', 'main')).not.toContain('tools/review/src/r.ts');
    });

    it('runs test then typecheck in the package directory, and merges when both pass', async () => {
      commitNestedPackage({ test: 'true', typecheck: 'true' });
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      commitIn(worktree, 'tools/review/src/r.ts', 'export const r = 1;\n');

      const outcome = await merge(nestedAdapter());

      expect(outcome.status).toBe('merged');
      const stageNames = outcome.report.stages.map((s) => s.stage);
      expect(
        stageNames.slice(stageNames.indexOf('lint') + 1, stageNames.indexOf('scope-audit')),
      ).toEqual(['test (tools/review)', 'typecheck (tools/review)']);
    });

    it('runs the script with the package as its working directory', async () => {
      commitNestedPackage({ test: 'true', typecheck: 'pwd; exit 1' });
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      commitIn(worktree, 'tools/review/README.md', 'docs only\n');

      const outcome = await merge(nestedAdapter());

      expect(outcome.status).toBe('rejected');
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: 'typecheck (tools/review)',
        detail: expect.stringMatching(/\/pup-gate-checkout-[^/]+\/checkout\/tools\/review/),
      });
    });

    it('runs the script inside the gate sandbox, without the operator secrets', async () => {
      vi.stubEnv('PUP_TEST_SECRET', 'sk-do-not-leak');
      commitNestedPackage({
        test: 'test -z "$PUP_TEST_SECRET" && test -n "$PATH"',
        typecheck: 'true',
      });
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      commitIn(worktree, 'tools/review/src/r.ts', 'export const r = 1;\n');

      const outcome = await merge(nestedAdapter());

      expect(outcome.status).toBe('merged');
      expect(untimed(outcome.report.stages)).toContainEqual({
        stage: 'test (tools/review)',
        status: 'pass',
      });
    });

    it("resolves the scripts from the trusted checkout, not the session's manifest", async () => {
      commitNestedPackage({ test: 'true', typecheck: 'true' });
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      // Deleting the script in the worktree fails the stage, never skips it.
      commitIn(
        worktree,
        'tools/review/package.json',
        JSON.stringify({ scripts: { typecheck: 'true' } }),
      );

      const outcome = await merge(nestedAdapter());

      expect(outcome.status).toBe('rejected');
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: 'test (tools/review)',
        status: 'fail',
      });
    });

    it('runs nothing for a diff that stays outside every nested package', async () => {
      commitNestedPackage({ test: 'exit 1', typecheck: 'exit 1' });
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      const outcome = await merge(nestedAdapter());

      expect(outcome.status).toBe('merged');
      expect(outcome.report.stages.map((s) => s.stage)).not.toContain('test (tools/review)');
    });

    it('flags a package whose trusted manifest declares no test script', async () => {
      commitNestedPackage({ typecheck: 'true' });
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      // The session's own manifest adding the script buys nothing.
      commitIn(
        worktree,
        'tools/review/package.json',
        JSON.stringify({ scripts: { test: 'true', typecheck: 'true' } }),
      );

      const outcome = await merge(nestedAdapter());

      expect(outcome.status).toBe('refused');
      expect(outcome.report.stages).toContainEqual({
        stage: 'test (tools/review)',
        status: 'flagged',
        detail: expect.stringContaining(
          'not measured — tools/review/package.json declares no test script',
        ),
      });
      expect(untimed(outcome.report.stages)).toContainEqual({
        stage: 'typecheck (tools/review)',
        status: 'pass',
      });
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    });

    it('records the missing script as debt when the merge accepts it', async () => {
      commitNestedPackage({});
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      commitIn(worktree, 'tools/review/src/r.ts', 'export const r = 1;\n');

      const outcome = await merge(nestedAdapter(), { reason: 'tooling', reviewBy: 'next sprint' });

      expect(outcome.status).toBe('merged');
      expect(
        listLedgerEntries(db, 'proj-1').map((e) => [e.description, JSON.parse(e.files)]),
      ).toEqual([
        [
          `Nested package tools/review changed with no test script, merged from session ${SESSION_ID}`,
          ['tools/review/src/r.ts'],
        ],
        [
          `Nested package tools/review changed with no typecheck script, merged from session ${SESSION_ID}`,
          ['tools/review/src/r.ts'],
        ],
      ]);
    });

    it('names the changed files a nested package kept from the debt stages', async () => {
      commitNestedPackage({ test: 'true', typecheck: 'true' });
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      commitIn(worktree, 'tools/review/src/r.ts', 'export const r = 1;\n');
      commitIn(worktree, 'tools/review/src/s.ts', 'export const s = 1;\n');
      commitIn(worktree, 'tools/review/README.md', 'not source\n');
      seedDebtBaseline({ deadExports: [], duplicatedLines: 12, coverageRatio: 0.8 });
      const adapter = nestedAdapter({
        ...debtAdapter(),
        touchedNestedPackages: typescriptAdapter.touchedNestedPackages,
        duplication: () => ({ duplicatedLines: 8, blocks: [] }),
        coverage: () => ({ files: { 'src/app.ts': { covered: [1], instrumented: [1] } } }),
        coverableFiles: typescriptAdapter.coverableFiles,
      });

      const outcome = await merge(adapter);

      expect(outcome.status).toBe('merged');
      const note = '; 2 changed file(s) in a nested package not measured here (tools/review)';
      expect(untimed(outcome.report.stages)).toEqual(
        expect.arrayContaining([
          { stage: 'dead-code', status: 'pass', detail: `no new unused exports${note}` },
          {
            stage: 'duplication',
            status: 'pass',
            detail: `8 duplicated lines (baseline 12)${note}`,
          },
          { stage: 'coverage', status: 'pass', detail: `no instrumentable changed lines${note}` },
        ]),
      );
    });

    it('puts the note ahead of the accept hint on a flagged stage, and elides past three', async () => {
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      seedDebtBaseline({ deadExports: [], duplicatedLines: 0 });
      const pkg = (dir: string, files: number): NestedPackage => {
        const sources = Array.from({ length: files }, (_, i) => `${dir}/f${i}.ts`);
        return { dir, changedFiles: sources, droppedSources: sources, commands: [], missing: [] };
      };
      const adapter = debtAdapter({
        deadCode: () => [{ file: 'src/feature.ts', exportName: 'feature' }],
        touchedNestedPackages: () => [
          pkg('a', 1),
          pkg('b', 0),
          pkg('c', 2),
          pkg('d', 1),
          pkg('e', 1),
        ],
      });

      const outcome = await merge(adapter);

      expect(outcome.status).toBe('refused');
      expect(outcome.report.stages).toContainEqual(
        expect.objectContaining({
          stage: 'dead-code',
          status: 'flagged',
          detail:
            '1 new unused export(s): src/feature.ts#feature; 5 changed file(s) in a nested ' +
            'package not measured here (a, c, d, …). Re-run with --accept-debt "<reason>" ' +
            '--review-by "<condition>", or steer the session to address it.',
        }),
      );
    });
  });

  it('flags a touched file whose complexity rises past the threshold', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const adapter = debtAdapter({
      complexity: ({ measurePath }) => [
        { file: 'src/feature.ts', complexity: measurePath === repo ? 2 : 40 },
      ],
    });

    const outcome = await merge(adapter);

    expect(outcome.status).toBe('refused');
    expect(outcome.report.stages).toContainEqual(
      expect.objectContaining({
        stage: 'complexity',
        status: 'flagged',
        detail: expect.stringContaining('src/feature.ts (+38)'),
      }),
    );
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

  it('ratchets the stored debt baseline to the merged state', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    seedDebtBaseline({
      deadExports: [
        { file: 'src/legacy.ts', exportName: 'old' },
        { file: 'src/legacy.ts', exportName: 'older' },
      ],
      duplicatedLines: 9,
    });
    const adapter = debtAdapter({
      deadCode: () => [{ file: 'src/legacy.ts', exportName: 'old' }],
      duplication: () => ({ duplicatedLines: 5, blocks: [] }),
    });

    const outcome = await merge(adapter);

    expect(outcome.status).toBe('merged');
    const stored = JSON.parse(getProject(db, 'proj-1')?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt).toEqual({
      deadExports: [{ file: 'src/legacy.ts', exportName: 'old' }],
      duplicatedLines: 5,
      duplicationRule: DUPLICATION_RULE_ID,
    });
  });

  it('passes a fully covered patch and ratchets the stored coverage ratio', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    seedDebtBaseline({ coverageRatio: 0.8 });
    const adapter = debtAdapter({
      coverage: () => ({
        files: {
          'src/feature.ts': { covered: [1], instrumented: [1] },
          'src/app.ts': { covered: [1], instrumented: [1, 2] },
        },
      }),
    });

    const outcome = await merge(adapter);

    expect(outcome.status).toBe('merged');
    expect(outcome.report.stages).toContainEqual(
      expect.objectContaining({ stage: 'coverage', status: 'pass' }),
    );
    const stored = JSON.parse(getProject(db, 'proj-1')?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt?.coverageRatio).toBeCloseTo(2 / 3);
  });

  // A realistic coverableFiles: source, not tests, not assets.
  const coverableFiles = (_ctx: CapabilityContext, files: string[]): string[] =>
    files.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('refuses a changed source file that never reached the coverage report', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    seedDebtBaseline({ coverageRatio: 0.8 });
    // The loophole: excluded from coverage config, or shipped with no test that
    // loads it, so patch coverage sees zero instrumentable changed lines.
    const adapter = debtAdapter({
      coverableFiles,
      coverage: () => ({ files: { 'src/app.ts': { covered: [1], instrumented: [1] } } }),
    });

    const outcome = await merge(adapter);

    expect(outcome.status).toBe('refused');
    expect(outcome.report.stages).toContainEqual(
      expect.objectContaining({
        stage: 'coverage',
        status: 'flagged',
        detail: expect.stringContaining('src/feature.ts'),
      }),
    );
  });

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
    expect(outcome.prUrl).toContain('--title test goal');
    expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(mainBefore);
    expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).not.toBe('');
    expect(getSession(db, SESSION_ID)?.state).toBe('merged');
    expect(existsSync(worktree)).toBe(false);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH).trim()).toBe('');
    // The target has not moved, so the bar must not either — the post-PR audit ratchets.
    const stored = JSON.parse(getProject(db, 'proj-1')?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt?.deadExports).toEqual([{ file: 'src/legacy.ts', exportName: 'old' }]);
  });

  it('with openPr pushes to the configured origin URL past a rewrite in the shared config', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const bare = addOrigin();
    const elsewhere = tempDir('pup-elsewhere-');
    sh(elsewhere, 'git', 'init', '--bare', '-b', 'main');
    // Written from the session's worktree into the config every checkout
    // shares. Matching the whole URL, it outranks the operator's rewrite on any
    // push that reads this config, by name or by literal URL alike.
    sh(worktree, 'git', 'config', `url.${elsewhere}.insteadOf`, ORIGIN_URL);
    sh(worktree, 'git', 'config', `url.${elsewhere}.pushInsteadOf`, ORIGIN_URL);

    const outcome = await withFakeGh(fakeGh([]), () =>
      runMergeGate(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [passingAdapter],
        openPr: true,
      }),
    );

    expect(outcome.status).toBe('merged');
    expect(outcome.prUrl).toContain('--repo github.com/owner/repo');
    expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).not.toBe('');
    expect(sh(elsewhere, 'git', 'branch', '--list', BRANCH).trim()).toBe('');
  });

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

  it('with openPr refuses when the project has no recorded push target at all', async () => {
    seedSession(db, repo);
    // Origin still resolves to the local bare repo: with the guard removed this
    // test must push somewhere offline, not at the real github.com/owner/repo.
    addOrigin();
    db.prepare('UPDATE projects SET origin_url = NULL WHERE id = ?').run('proj-1');

    await expect(
      withFakeGh(fakeGh([]), () =>
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [passingAdapter],
          openPr: true,
        }),
      ),
    ).rejects.toThrow('No push target is recorded');
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
  });

  it('with openPr pushes to a moved origin once the operator has re-recorded it', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const bare = addOrigin();
    const moved = secondRemote(bare, 'owner', 'renamed');
    const movedUrl = 'git@github.com:owner/renamed.git';
    sh(repo, 'git', 'config', 'remote.origin.url', movedUrl);
    // What `pup init --origin-moved` writes from the trusted checkout.
    saveProjectOriginUrl(db, 'proj-1', movedUrl);

    const outcome = await withFakeGh(fakeGh([]), () =>
      runMergeGate(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [passingAdapter],
        openPr: true,
      }),
    );

    expect(outcome.status).toBe('merged');
    expect(outcome.prUrl).toContain('--repo github.com/owner/renamed');
    expect(sh(moved, 'git', 'rev-parse', BRANCH).trim()).not.toBe('');
    expect(sh(bare, 'git', 'branch', '--list', BRANCH).trim()).toBe('');
  });

  it("pipes the remote-tracking probe's stderr instead of leaking it, while the push stays inherited", async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    seedDebtBaseline({});
    addOrigin();
    const execFileSyncMock = vi.mocked(execFileSync);

    const outcome = await withFakeGh(fakeGh([]), () =>
      runMergeGate(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [debtAdapter({ deadCode: () => [] })],
        openPr: true,
      }),
    );

    expect(outcome.status).toBe('merged');
    const probeCall = execFileSyncMock.mock.calls.find(([, callArgs]) =>
      (callArgs as string[] | undefined)?.includes('--verify'),
    );
    const pushCall = execFileSyncMock.mock.calls.find(([, callArgs]) =>
      (callArgs as string[] | undefined)?.includes('push'),
    );
    // A missing remote-tracking ref is the expected first-push case: its
    // "fatal: Needed a single revision" must not leak to the operator
    // console, so the probe's stderr is piped (captured) rather than
    // inherited from the parent process.
    expect((probeCall?.[2] as { stdio?: unknown } | undefined)?.stdio).toEqual([
      'ignore',
      'pipe',
      'pipe',
    ]);
    // The push itself must keep its stderr visible to the operator. Without
    // the existence guard, a vanished push call would make the optional chain
    // yield undefined and the stdio assertion pass vacuously.
    expect(pushCall).toBeDefined();
    expect((pushCall?.[2] as { stdio?: unknown } | undefined)?.stdio).toBeUndefined();
  });

  it('with openPr retries cleanly after gh dies post-push, without duplicate ledger entries', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));
    addOrigin();
    const request = {
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: [passingAdapter],
      acceptDebt: { reason: 'deadline', reviewBy: 'before v2', acceptedBy: 'human' },
      openPr: true,
    };

    // First attempt: the probe finds no PR, the push lands, `pr create` dies.
    const ghDyingOnCreate = `${fakeGh([])}\nexit 1\n`;
    await expect(withFakeGh(ghDyingOnCreate, () => runMergeGate(db, request))).rejects.toThrow();
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    expect(listLedgerEntries(db, 'proj-1')).toHaveLength(1);

    const outcome = await withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request));

    expect(outcome.status).toBe('merged');
    expect(outcome.prUrl).toBe(openPrOnMain.url);
    expect(listLedgerEntries(db, 'proj-1')).toHaveLength(1);
  });

  // The body vouches for the commit the gate pushed; a head anything else put
  // there is refused loudly, naming both (decision 82).
  it('with openPr refuses a PR whose head is not the pushed sha, naming both', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));
    addOrigin();
    const pinned = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();
    const elsewhere = 'f'.repeat(40);

    const refusal = await (async () => {
      try {
        await withFakeGh(fakeGh([], elsewhere), () =>
          runMergeGate(db, {
            repoPath: repo,
            sessionId: SESSION_ID,
            adapters: [passingAdapter],
            acceptDebt: { reason: 'deadline', reviewBy: 'before v2', acceptedBy: 'human' },
            openPr: true,
          }),
        );
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(refusal).toContain(`has its head at ${elsewhere}, not at ${pinned}`);
    expect(refusal).toContain('The accepted-debt ledger entry was kept for the retry');
    expect(ghCalls()).toContainEqual(expect.stringContaining('pr view'));
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    expect(listEvents(db, SESSION_ID).some((event) => event.type === 'merge')).toBe(false);
  });

  it('with openPr passes a PR whose head reads back as the pushed sha', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    addOrigin();
    const pinned = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();

    const outcome = await withFakeGh(fakeGh([openPrOnMain], pinned), () =>
      runMergeGate(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [passingAdapter],
        openPr: true,
      }),
    );

    expect(outcome.status).toBe('merged');
    expect(ghCalls()).toContainEqual(
      `pr view ${openPrOnMain.url} --repo github.com/owner/repo --json headRefOid`,
    );
  });

  // The approver can differ between the conductor's attempt and the operator's
  // retry (decision 75); the debt is the same debt, and the first approver stands.
  it('with openPr retries under another approver without filing the debt twice', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));
    addOrigin();
    const debt = { reason: 'deadline', reviewBy: 'before v2' };
    const ghDyingOnCreate = `${fakeGh([])}\nexit 1\n`;
    await expect(
      withFakeGh(ghDyingOnCreate, () =>
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [passingAdapter],
          acceptDebt: { ...debt, acceptedBy: 'tg:alexis' },
          openPr: true,
        }),
      ),
    ).rejects.toThrow();

    const outcome = await withFakeGh(fakeGh([openPrOnMain]), () =>
      runMergeGate(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [passingAdapter],
        acceptDebt: { ...debt, acceptedBy: 'human' },
        openPr: true,
      }),
    );

    expect(outcome.status).toBe('merged');
    expect(listLedgerEntries(db, 'proj-1').map((e) => e.accepted_by)).toEqual(['tg:alexis']);
  });

  it('with openPr retries after the target moved, when the rebase rewrote the pushed branch', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    addOrigin();
    const request = {
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: [passingAdapter],
      openPr: true,
    };
    const ghDyingOnCreate = `${fakeGh([])}\nexit 1\n`;
    await expect(withFakeGh(ghDyingOnCreate, () => runMergeGate(db, request))).rejects.toThrow();

    // main moves, so the retry's auto-rebase rewrites the already-pushed branch.
    commitIn(repo, 'README.md', '# moved on\n');
    const outcome = await withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request));

    expect(outcome.status).toBe('merged');
    expect(outcome.prUrl).toBe(openPrOnMain.url);
  });

  it('with openPr refuses an open PR that has auto-merge armed', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const bare = addOrigin();

    await expect(
      withFakeGh(fakeGh([{ ...openPrOnMain, autoMergeRequest: { enabledAt: 'now' } }]), () =>
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [passingAdapter],
          openPr: true,
        }),
      ),
    ).rejects.toThrow('auto-merge');
    expect(sh(bare, 'git', 'branch', '--list', BRANCH).trim()).toBe('');
  });

  it('with openPr settles adoption before the gate runs, writing no ledger entry', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));
    addOrigin();

    await expect(
      withFakeGh(fakeGh([{ ...openPrOnMain, baseRefName: 'release' }]), () =>
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [passingAdapter],
          acceptDebt: { reason: 'deadline', reviewBy: 'before v2', acceptedBy: 'human' },
          openPr: true,
        }),
      ),
    ).rejects.toThrow('release');
    // Ten minutes of stages and a debt entry for a merge that cannot happen.
    expect(listLedgerEntries(db, 'proj-1')).toEqual([]);
    expect(ghCalls().filter((call) => call.startsWith('pr'))).toHaveLength(1);
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

  it('with openPr refuses an open PR that targets a different base', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    addOrigin();

    await expect(
      withFakeGh(fakeGh([{ ...openPrOnMain, baseRefName: 'release' }]), () =>
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [passingAdapter],
          openPr: true,
        }),
      ),
    ).rejects.toThrow('release');
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
  });

  it('with openPr refuses to guess when several open PRs share the head branch', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    addOrigin();

    await expect(
      withFakeGh(
        fakeGh([openPrOnMain, { ...openPrOnMain, url: 'https://github.com/owner/repo/pull/8' }]),
        () =>
          runMergeGate(db, {
            repoPath: repo,
            sessionId: SESSION_ID,
            adapters: [passingAdapter],
            openPr: true,
          }),
      ),
    ).rejects.toThrow('Several open pull requests');
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
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

  it('with openPr requires an origin remote', async () => {
    seedSession(db, repo);

    await expect(
      withFakeGh('#!/bin/sh\nexit 0\n', () =>
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [passingAdapter],
          openPr: true,
        }),
      ),
    ).rejects.toThrow('origin');
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
  });
});

describe('withMergeLock', () => {
  it('keeps node listening for SIGINT and SIGTERM while the lock is held, and only then', async () => {
    const repo = tempDir('pup-lock-');
    mkdirSync(join(repo, '.git'));
    const before = { int: process.listeners('SIGINT'), term: process.listeners('SIGTERM') };
    let during: { int: number; term: number } | undefined;

    await expect(
      withMergeLock(repo, () => {
        during = {
          int: process.listeners('SIGINT').length,
          term: process.listeners('SIGTERM').length,
        };
        throw new Error('interrupted');
      }),
    ).rejects.toThrow('interrupted');

    expect(during).toEqual({ int: before.int.length + 1, term: before.term.length + 1 });
    expect(process.listeners('SIGINT')).toEqual(before.int);
    expect(process.listeners('SIGTERM')).toEqual(before.term);
    expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
  });
});
