import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  initRepo,
  LAUNCH_PANE,
  passingAdapter,
  SESSION_ID,
  seedSession,
  sh,
  untimed,
} from '@test/helpers/merge-gate.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Adapter, CapabilityContext, NestedPackage } from '../adapters/types/adapter.types.js';
import { typescriptAdapter } from '../adapters/typescript.adapter.js';
import { killSession, steerPane } from '../claude/session-runtime.service.js';
import { runUtility } from '../claude/utility.service.js';
import { openStore } from './db.client.js';
import { ArmedGitDriverError, WorktreeConfigError } from './git-diff.client.js';
import { listLedgerEntries } from './ledger.repository.js';
import { DUPLICATION_RULE_ID } from './merge-gate.constants.js';
import { runMergeGate as runGate } from './merge-gate.service.js';
import {
  getProject,
  getSession,
  incrementRejectCount,
  listBacklogTasks,
  listEvents,
  saveProjectBaseline,
  saveProjectOriginUrl,
} from './session.repository.js';
import { HELD_SLOT_ENV } from './test-slot.service.js';
import type { DebtBaseline, ProjectBaseline } from './types/init.types.js';

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
  const _coverableFiles = (_ctx: CapabilityContext, files: string[]): string[] =>
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
    // Per-worktree config is refused before the driver check reads it.
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

      await expect(merge()).rejects.toThrow(WorktreeConfigError);
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

  // Running code lives under docs/ too (Docusaurus, Sphinx's conf.py), and a
  // link can point anywhere, so it and the prose it reaches count as source.
  it('counts only prose under docs/ as docs, and a link there as source', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'docs/**'] });
    commitIn(worktree, 'docs/guide.md', 'prose\n'.repeat(3));
    commitIn(worktree, 'docs/notes.rst', 'prose\n'.repeat(5));
    commitIn(worktree, 'docs/impl.ts', 'export const impl = 1;\n'.repeat(2));
    commitIn(worktree, 'docs/page.mdx', '# page\n'.repeat(4));
    commitIn(worktree, 'docs/requirements.txt', 'sphinx\n');
    commitIn(worktree, 'src/docs/h.md', 'prose\n');
    symlinkSync('guide.md', join(worktree, 'docs/link.md'));
    sh(worktree, 'git', 'add', '.');
    sh(worktree, 'git', 'commit', '-m', 'link docs/link.md');

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '12 source + 0 test + 5 docs changed lines',
    });
  });

  // Shared config a session can write: coloured `git grep -l` output would
  // shift every path, and every importer would go unread.
  it('finds the importer with grep colour forced on in the shared config', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.test.ts', 'export const v = 1;\n'.repeat(5));
    commitIn(worktree, 'src/use.ts', "export { v } from './big.test.js';\n");
    sh(repo, 'git', 'config', 'color.ui', 'always');
    sh(repo, 'git', 'config', 'color.grep', 'always');

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '6 source + 0 test + 0 docs changed lines',
    });
  });

  // Lexically `src/x.py` lands on the decoy `src/impl.md`, which is where the
  // gate's link check reads it; through `src/l` it lands on `docs/impl.md`. No
  // lexical reading knows, so the link reaches everything.
  it('reads a link with a .. after a named segment as reaching every path', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'docs/**'] });
    commitIn(worktree, 'docs/sub/a.md', 'prose\n');
    commitIn(worktree, 'docs/impl.md', 'print(1)\n'.repeat(5));
    commitIn(worktree, 'src/impl.md', 'decoy\n');
    commitIn(worktree, 'src/a.test.ts', 'x\n'.repeat(2));
    symlinkSync('../docs/sub', join(worktree, 'src/l'));
    symlinkSync('l/../impl.md', join(worktree, 'src/x.py'));
    sh(worktree, 'git', 'add', '.');
    sh(worktree, 'git', 'commit', '-m', 'link through a link');

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '11 source + 0 test + 0 docs changed lines',
    });
  });

  describe('with a source file renamed onto a test name', () => {
    /** `count` distinct lines from `from`, so git can tell a rename from a rewrite. */
    function numbered(count: number, from = 0): string {
      return Array.from({ length: count }, (_, i) => `export const v${from + i} = 1;\n`).join('');
    }

    function renameOntoTest(worktree: string): void {
      sh(worktree, 'git', 'mv', 'src/big.ts', 'src/big.test.ts');
      // 400 of 1000 lines rewritten: still similar enough for git to pair them.
      writeFileSync(join(worktree, 'src/big.test.ts'), numbered(600) + numbered(400, 5000));
      sh(worktree, 'git', 'commit', '-qam', 'rename src/big.ts');
    }

    it('counts the rewrite as source', async () => {
      commitIn(repo, 'src/big.ts', numbered(1000));
      const worktree = seedSession(db, repo);
      renameOntoTest(worktree);

      const outcome = await merge();

      expect(outcome.status).toBe('refused');
      expect(outcome.report.stages.find((s) => s.stage === 'diff-size')?.detail).toContain(
        '800 source + 0 test + 0 docs changed lines: source exceeds the 600-line flag',
      );
    });

    // `diff.renames` is shared config a session can write; with it off the
    // rename must still be seen, so the new name does not read as a test. The
    // numstat pins rename detection on too (decision 113), hence the same 800.
    it('counts it as source with rename detection switched off in the shared config', async () => {
      commitIn(repo, 'src/big.ts', numbered(1000));
      const worktree = seedSession(db, repo);
      renameOntoTest(worktree);
      sh(repo, 'git', 'config', 'diff.renames', 'false');

      const outcome = await merge();

      expect(outcome.report.stages.find((s) => s.stage === 'diff-size')?.detail).toContain(
        '800 source + 0 test + 0 docs changed lines',
      );
    });

    // `diff.renameLimit` is shared config too: at 1, a second added file
    // skipped the inexact pairing. The numstat leaves the limit to that config,
    // so it lists the rename as a delete and an add, both counted as source.
    it('counts it as source with the rename limit lowered in the shared config', async () => {
      commitIn(repo, 'src/big.ts', numbered(1000));
      const worktree = seedSession(db, repo);
      renameOntoTest(worktree);
      commitIn(worktree, 'src/extra.ts', 'x\n');
      sh(repo, 'git', 'config', 'diff.renameLimit', '1');

      const outcome = await merge();

      expect(outcome.report.stages.find((s) => s.stage === 'diff-size')?.detail).toContain(
        '2001 source + 0 test + 0 docs changed lines',
      );
    });

    it('still counts a test renamed onto another test name as test', async () => {
      commitIn(repo, 'src/old.test.ts', numbered(100));
      const worktree = seedSession(db, repo);
      sh(worktree, 'git', 'mv', 'src/old.test.ts', 'src/new.test.ts');
      writeFileSync(join(worktree, 'src/new.test.ts'), numbered(90) + numbered(10, 5000));
      sh(worktree, 'git', 'commit', '-qam', 'rename src/old.test.ts');

      const outcome = await merge();

      expect(untimed(outcome.report.stages)).toContainEqual({
        stage: 'diff-size',
        status: 'pass',
        detail: '0 source + 20 test + 0 docs changed lines',
      });
    });
  });

  it('passes a large test-only diff that the old count flagged', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.test.ts', 'const line = 1;\n'.repeat(700));

    const outcome = await merge();

    expect(outcome.status).toBe('merged');
    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '0 source + 700 test + 0 docs changed lines',
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

    // The checkout's admin dir sits beside the sessions' own, and a session
    // can rewrite its HEAD or `commondir` once the cut is checked. Read through
    // it, a HEAD at a commit without the marker leaves the package out and
    // runs none of its stages, and a `commondir` naming a repo of the
    // session's reads its config: a promisor remote whose `uploadpack` runs on
    // the lazy fetch of the commit it lacks (decision 101). A HEAD git refuses
    // to open stops the gate's own pinned listing of the links first.
    it.each([
      ['its HEAD moved to a commit without the marker', 'HEAD', 'BEFORE'],
      ["its commondir naming a repo of the session's", 'commondir', 'PLANTED'],
    ])('runs the package stages with %s after the cut', async (_, pointer, content) => {
      const before = sh(repo, 'git', 'rev-parse', 'HEAD').trim();
      commitNestedPackage({ test: 'true', typecheck: 'true' });
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      commitIn(worktree, 'tools/review/src/r.ts', 'export const r = 1;\n');
      const fired = join(tempDir('pup-marker-'), 'fired');
      const planted = tempDir('pup-planted-');
      sh(planted, 'git', 'init', '-q');
      for (const [key, value] of [
        ['core.repositoryformatversion', '1'],
        ['extensions.partialClone', 'evil'],
        ['remote.evil.promisor', 'true'],
        ['remote.evil.url', repo],
        ['remote.evil.uploadpack', `sh -c 'echo pwned >> ${fired}; exit 1' --`],
      ] as const) {
        sh(planted, 'git', 'config', key, value);
      }
      const written = content.replace('BEFORE', before).replace('PLANTED', join(planted, '.git'));
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const gitDir = tempDir('pup-git-');
      writeFileSync(
        join(gitDir, 'git'),
        [
          '#!/bin/sh',
          `${realGit} "$@" || exit $?`,
          'case " $* " in *" read-tree "*)',
          `  case "$GIT_DIR" in */worktrees/pup-gate-checkout-*) echo ${written} > "$GIT_DIR/${pointer}" ;; esac ;;`,
          'esac',
        ].join('\n'),
        { mode: 0o755 },
      );
      const originalPath = process.env.PATH;
      process.env.PATH = `${gitDir}:${originalPath}`;
      onTestFinished(() => {
        process.env.PATH = originalPath;
      });

      const outcome = await merge(nestedAdapter());

      expect(outcome.status).toBe('merged');
      const stageNames = outcome.report.stages.map((s) => s.stage);
      expect(stageNames).toContain('test (tools/review)');
      expect(stageNames).toContain('typecheck (tools/review)');
      expect(existsSync(fired)).toBe(false);
    });

    it('runs the script with the package as its working directory', async () => {
      commitNestedPackage({ test: 'true', typecheck: 'pwd; exit 1' });
      const worktree = seedSession(db, repo, NESTED_SCOPE);
      commitIn(worktree, 'tools/review/README.md', 'docs only\n');

      const outcome = await merge(nestedAdapter());

      expect(outcome.status).toBe('rejected');
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: 'typecheck (tools/review)',
        detail: expect.stringMatching(/\/(pup-gate-checkout-[^/]+)\/\1\/tools\/review/),
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
});
