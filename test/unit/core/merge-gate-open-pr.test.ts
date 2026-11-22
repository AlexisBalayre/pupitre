import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
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
vi.mock('@src/core/constants/merge-gate.constants.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@src/core/constants/merge-gate.constants.js')>();
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
vi.mock('@src/core/git-diff.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/core/git-diff.client.js')>();
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
vi.mock('@src/core/test-slot.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/core/test-slot.service.js')>();
  return {
    ...actual,
    get GATE_SLOT_WAIT_MS() {
      return slotWait.ms ?? actual.GATE_SLOT_WAIT_MS;
    },
  };
});

import { GateStage } from '@src/adapters/enums/gate-stage.enums.js';
import type { Adapter, CapabilityContext } from '@src/adapters/types/adapter.types.js';
import { typescriptAdapter } from '@src/adapters/typescript.adapter.js';
import { SteerNotDeliveredError } from '@src/claude/errors/session-runtime.errors.js';
import { steerPane } from '@src/claude/session-runtime.service.js';
import { DUPLICATION_RULE_ID } from '@src/core/constants/merge-gate.constants.js';
import { openStore } from '@src/core/db.client.js';
import { EventType } from '@src/core/enums/event-type.enums.js';
import { GateStageStatus } from '@src/core/enums/gate-stage-status.enums.js';
import { MergeStatus } from '@src/core/enums/merge-status.enums.js';
import { SessionState } from '@src/core/enums/session-state.enums.js';
import { SlotHolderKind } from '@src/core/enums/slot-holder-kind.enums.js';
import { ArmedGitDriverError } from '@src/core/errors/git-diff.errors.js';
import {
  MergeLockHeldError,
  SessionNotReviewableError,
} from '@src/core/errors/merge-gate.errors.js';
import { insertLedgerEntry, listLedgerEntries } from '@src/core/ledger.repository.js';
import { runMergeGate as runGate } from '@src/core/merge-gate.service.js';
import { projectPaths } from '@src/core/paths.utils.js';
import {
  getProject,
  getSession,
  listEvents,
  saveProjectBaseline,
  saveProjectOriginUrl,
  transitionSession,
} from '@src/core/session.repository.js';
import { GATE_SLOT_WAIT_MS, HELD_SLOT_ENV, withTestSlot } from '@src/core/test-slot.service.js';
import type { DebtBaseline, ProjectBaseline } from '@src/core/types/init.types.js';
import {
  BRANCH,
  blockedReason,
  commitIn,
  debtAdapter,
  failingBuildAdapter,
  GATE_CHECKOUT,
  initRepoCopier,
  passingAdapter,
  SESSION_ID,
  seedSession,
  sh,
  untimed,
} from '@test/helpers/merge-gate.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';

const newRepo = initRepoCopier();

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
    repo = newRepo();
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
   * the PR as `state` onto main. GitHub reads that head, not a git under pup's
   * pin, so the read drops the transports `pinnedGitEnv` turns off.
   */
  const fakeGh = (openPrs: unknown[], head?: string, state = 'OPEN'): string =>
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${ghLog}`,
      '[ "$1" = "--version" ] && exit 0',
      `if [ "$2" = "list" ]; then echo '${JSON.stringify(openPrs)}'; exit 0; fi`,
      'if [ "$2" = "view" ]; then',
      head === undefined
        ? `  head=$(cd / && unset GIT_ALLOW_PROTOCOL && GIT_CONFIG_COUNT=0 git ls-remote "git@\${5%%/*}:\${5#*/}.git" refs/heads/${BRANCH} | cut -f1)`
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

  // git names a worktree's admin dir after its basename, so a gate checkout named
  // `checkout` would take `checkout1` beside the conductor's, and the pinned
  // read-tree would refuse its own checkout (decision 101).
  it('merges while another worktree already holds the admin dir named checkout', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    sh(repo, 'git', 'worktree', 'add', '-q', '--detach', join(repo, '.pup', 'checkout'));

    const outcome = await merge();

    expect(outcome.status).toBe(MergeStatus.Merged);
    expect(sh(repo, 'git', 'log', '--oneline', 'main')).toContain('edit src/feature.ts');
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
              { stage: GateStage.Build, command: 'sh', args: ['-c', build] },
              ...passingAdapter.gateCommands(repoPath).filter((c) => c.stage !== GateStage.Build),
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

      expect(outcome.status).toBe(MergeStatus.Merged);
      expect(untimed(outcome.report.stages)).toContainEqual({
        stage: GateStage.Build,
        status: GateStageStatus.Pass,
      });
      expect(measured).toBe('export const feature = 1;\n');
      expectDropped(checkout());
    });

    it('drops the checkout after a pass', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const { adapter, checkout } = adapterAfterCut('test -f src/feature.ts');

      expect((await merge(adapter)).status).toBe(MergeStatus.Merged);

      expectDropped(checkout());
    });

    it('drops the checkout after a failed stage', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const { adapter, checkout } = adapterAfterCut('exit 1');

      expect((await merge(adapter)).status).toBe(MergeStatus.Rejected);

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

      expect((await merge(adapter)).status).toBe(MergeStatus.Merged);

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

      expect((await merge(adapter)).status).toBe(MergeStatus.Merged);
    });

    it('checks out every committed file past a planted core.sparseCheckout', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      sh(repo, 'git', 'config', 'core.sparseCheckout', 'true');
      writeFileSync(join(repo, '.git', 'info', 'sparse-checkout'), '/src/app.ts\n');

      expect((await merge(adapterAfterCut('test -f src/feature.ts').adapter)).status).toBe(
        MergeStatus.Merged,
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

      expect((await merge(adapter)).status).toBe(MergeStatus.Merged);

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
          { stage: GateStage.Build, command: 'test', args: ['-e', 'node_modules/vendored'] },
        ],
      };

      expect((await merge(adapter)).status).toBe(MergeStatus.Merged);
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

      expect(getSession(db, SESSION_ID)?.state).toBe(SessionState.AwaitingReview);
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

      expect((await merge()).status).toBe(MergeStatus.Merged);
    });
  });

  // The scratch TMPDIR went with the process, which a test worker, the suite's
  // own and the conductor's alike, outlives or leaves without an `exit`.
  describe.each([
    ['passes', () => passingAdapter, MergeStatus.Merged],
    ['refuses', () => failingBuildAdapter, MergeStatus.Rejected],
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
        { stage: GateStage.Build, command: 'true', args: [] },
        { stage: GateStage.Test, command: 'sh', args: ['-c', waitForAll] },
        { stage: GateStage.Lint, command: 'sh', args: ['-c', 'touch lint.ran'] },
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

    expect(outcome.status).toBe(MergeStatus.Merged);
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

  // A worker's suite runs at nice 10 and the gate's at pup's own priority, but
  // a loaded host can still tip a timing-sensitive test over: the test stage
  // gets one re-run under the same lock before it counts (decision 94).
  describe('test stage re-run', () => {
    /** A stage command that fails its first run in this checkout, then `then`. */
    const failsOnce = (then: string): string =>
      'if [ -e .ran-once ]; then ' +
      then +
      '; fi; touch .ran-once; printf " FAIL  src/a.test.ts > times out under load\\n"; exit 1';

    // The failed tests named as a TypeScript repo's are, from vitest's summary.
    const adapterWith = (stage: GateStage, script: string): Adapter => ({
      ...passingAdapter,
      failingTests: typescriptAdapter.failingTests,
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

    /**
     * The gated session's directory under a home of the test's own, made as
     * pup makes it when it launches the session; answers the test stage's
     * kept output there.
     */
    const ownSessionDir = (): string => {
      vi.stubEnv('HOME', tempDir('pup-output-home-'));
      const dir = projectPaths(repo).sessionDir(SESSION_ID);
      mkdirSync(dir, { recursive: true });
      return join(dir, 'test-output.log');
    };

    /**
     * A suite that fails `src/a.test.ts > adds` and all of `src/b.test.ts`,
     * then prints 2700 chars of a fixture's git on stderr, and ends with `end`.
     */
    const failsUnderNoise = (end: string): string =>
      'printf " FAIL  src/a.test.ts > adds\\n FAIL  src/b.test.ts [ src/b.test.ts ]\\n"; ' +
      'i=0; while [ $i -lt 100 ]; do echo "fatal: no merge base found" >&2; i=$((i+1)); done; ' +
      end;

    it('passes a test stage that passes on its re-run, named flaky with what failed', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      const kept = ownSessionDir();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      onTestFinished(() => errors.mockRestore());

      const outcome = await merge(adapterWith(GateStage.Test, failsOnce('exit 0')));

      expect(outcome.status).toBe(MergeStatus.Merged);
      expect(runsOf('test-run')).toBe(2);
      // A passed report is the PR's body, so it names no path on this machine.
      expect(untimed(outcome.report.stages)).toContainEqual({
        stage: GateStage.Test,
        status: GateStageStatus.Pass,
        detail:
          'flaky — failed, then passed on its one re-run; failing the first time: ' +
          'src/a.test.ts > times out under load',
      });
      expect(errors).toHaveBeenCalledWith(
        `The test stage failed, then passed on its re-run (full output: ${kept}).`,
      );
      expect(readFileSync(kept, 'utf8')).toBe('FAIL  src/a.test.ts > times out under load\n');
    });

    it('rejects a test stage that fails its re-run too, naming both runs’ failures', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      const outcome = await merge(
        adapterWith(GateStage.Test, failsOnce('printf " FAIL  src/b.test.ts > other\\n"; exit 1')),
      );

      expect(outcome.status).toBe(MergeStatus.Rejected);
      expect(runsOf('test-run')).toBe(2);
      const stage = outcome.report.stages.at(-1);
      expect(stage).toMatchObject({ stage: GateStage.Test, status: GateStageStatus.Fail });
      expect(stage?.detail).toMatch(
        /^failed twice — failing the first time: src\/a\.test\.ts > times out under load; on the re-run: src\/b\.test\.ts > other\nfull output not kept: no directory at /,
      );
      expect(steerPane).toHaveBeenCalled();
    });

    // The tail a detail keeps was a fixture's git noise, which named no test
    // (#325): the adapter reads the runner's summary from the whole output, and
    // the whole output is kept in the session's directory, named in the detail.
    it('names the failing test files and tests of a failed test stage and keeps its whole output', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const kept = ownSessionDir();

      const outcome = await merge(adapterWith(GateStage.Test, failsUnderNoise('exit 1')));

      expect(outcome.status).toBe(MergeStatus.Rejected);
      const detail = outcome.report.stages.at(-1)?.detail ?? '';
      const named = 'src/a.test.ts > adds; src/b.test.ts';
      expect(detail.split('\n').slice(0, 2)).toEqual([
        `failed twice — failing the first time: ${named}; on the re-run: ${named}`,
        `full output: ${kept}`,
      ]);
      // The tail itself holds only the noise.
      expect(detail).not.toMatch(/FAIL {2}src/);
      const output = readFileSync(kept, 'utf8');
      expect(output).toMatch(/^--- run 1 of 2 ---\nFAIL {2}src\/a\.test\.ts > adds\n/);
      expect(output).toContain('\n\n--- run 2 of 2 ---\nFAIL  src/a.test.ts > adds\n');
      expect(output.match(/fatal: no merge base found/g)).toHaveLength(200);
    });

    it('names the failing tests of a test stage it does not re-run, and keeps its output', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const kept = ownSessionDir();

      const outcome = await merge(adapterWith(GateStage.Test, failsUnderNoise('exit 2')));

      expect(runsOf('test-run')).toBe(1);
      expect(outcome.report.stages.at(-1)?.detail?.split('\n').slice(0, 2)).toEqual([
        'failing: src/a.test.ts > adds; src/b.test.ts',
        `full output: ${kept}`,
      ]);
      expect(readFileSync(kept, 'utf8')).toMatch(/^FAIL {2}src\/a\.test\.ts > adds\n/);
    });

    it('says a test stage’s adapter that cannot read its runner’s summary names none', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      const outcome = await merge({
        ...adapterWith(GateStage.Test, failsUnderNoise('exit 2')),
        failingTests: undefined,
      });

      expect(outcome.report.stages.at(-1)?.detail).toMatch(
        /^failing: none named — its adapter cannot read the runner's summary\nfull output not kept: /,
      );
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
        adapterWith(
          GateStage.Test,
          `if [ -e .ran-once ]; then exit 0; fi; touch .ran-once; ${end}`,
        ),
      );

      expect(outcome.status).toBe(MergeStatus.Rejected);
      expect(runsOf('test-run')).toBe(1);
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: GateStage.Test,
        status: GateStageStatus.Fail,
      });
    });

    /**
     * Every load the gate reads during the test is `load`, or what `load`
     * answers when it is read; the machine's after it.
     */
    const loadAt = (load: number | (() => number)): void => {
      const realLoad = vi.mocked(loadavg).getMockImplementation();
      vi.mocked(loadavg).mockImplementation(() => {
        const now = typeof load === 'number' ? load : load();
        return [now, now, now];
      });
      onTestFinished(() => {
        vi.mocked(loadavg).mockImplementation(realLoad as never);
      });
    };

    /** A slot or wait record as the slots module writes one. */
    const slotRecord = (label: string, pid: number, kind = SlotHolderKind.Worker): string =>
      JSON.stringify({ kind, label, pid, token: 't0' });

    /**
     * The machine's test slots under a home of the test's own, so the gate
     * takes a real one; with `holder`, slot 0 is held by a worker run so
     * labelled, a live process that is not this one, leaving the other for the
     * gate. Answers the slots directory.
     */
    const ownSlots = (holder?: string): string => {
      const home = tempDir('pup-slot-home-');
      vi.stubEnv('HOME', home);
      vi.stubEnv(HELD_SLOT_ENV, '');
      const slots = join(home, '.pupitre', 'slots');
      mkdirSync(slots, { recursive: true });
      if (holder !== undefined) {
        writeFileSync(join(slots, 'slot-0.lock'), slotRecord(holder, process.ppid));
      }
      return slots;
    };

    /**
     * The refusal a test run timed out under `load` throws (decision 138); a
     * re-run's names what failed the first time, `firstFailures`.
     */
    const underLoad = (load: number, firstFailures?: string): string =>
      `The test stage timed out under load ${load.toFixed(1)}, at or over the machine's ` +
      `${availableParallelism()} cores, with other test runs going` +
      (firstFailures === undefined
        ? ''
        : `, on its re-run; failing the first time: ${firstFailures}`) +
      '; nothing was merged; run pup merge again when the load falls; full output';

    /** Loaded only once the gate has started the test run: the run's own load. */
    const loadedByTheRun = (): number => (runsOf('test-run') > 0 ? availableParallelism() * 4 : 0);

    /** A stage cap of 2 s, which `timesOut` runs past. */
    const shortTimeout = (): void => {
      gateTimeout.ms = 2_000;
      onTestFinished(() => {
        gateTimeout.ms = undefined;
      });
    };
    // The runner traps the timeout's SIGTERM and exits 1 by itself: an
    // ordinary status, told apart only by the code the timeout leaves.
    const timesOut = "trap 'exit 1' TERM; sleep 10 & wait";

    /** A pid no live process has: past any kernel's pid range. */
    const DEAD_PID = 2 ** 31 - 2;

    it('never re-runs a test stage that ran out its timeout under the cores, even one that trapped the SIGTERM, and rejects it', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      shortTimeout();
      loadAt(availableParallelism() - 0.5);

      const outcome = await merge(adapterWith(GateStage.Test, timesOut));

      expect(outcome.status).toBe(MergeStatus.Rejected);
      expect(runsOf('test-run')).toBe(1);
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: GateStage.Test,
        status: GateStageStatus.Fail,
      });
      expect(steerPane).toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.reject_count).toBe(1);
    });

    // At that load the suite outruns its cap whatever the branch holds, so the
    // timeout says nothing about the code (decision 138).
    it('refuses a test stage that ran out its timeout on a machine loaded before it and by other test runs, climbing no rung and injecting nothing', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const before = sh(repo, 'git', 'rev-parse', 'main').trim();
      shortTimeout();
      const slots = ownSlots('s-other');
      const cores = availableParallelism();
      loadAt(cores);

      await expect(merge(adapterWith(GateStage.Test, timesOut))).rejects.toThrow(underLoad(cores));

      expect(runsOf('test-run')).toBe(1);
      expect(steerPane).not.toHaveBeenCalled();
      const session = getSession(db, SESSION_ID);
      expect(session?.state).toBe(SessionState.AwaitingReview);
      expect(session?.reject_count).toBe(0);
      expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(before);
      expect(existsSync(worktree)).toBe(true);
      // The gate's slot freed and no wait left behind; the other run's kept.
      expect(readdirSync(slots)).toEqual(['slot-0.lock']);
      // The merge lock released: the next run takes it and merges.
      expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
      gateTimeout.ms = undefined;
      expect((await merge()).status).toBe(MergeStatus.Merged);
    });

    // The first run failed on its own, so it gets its re-run; the re-run is
    // what the load ran out, and it is judged as a first run would be. The
    // first run's failures are real, so the refusal still names them.
    it('refuses a test stage whose re-run ran out its timeout under load, after a first run that failed, naming its failures', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      shortTimeout();
      const slots = ownSlots('s-other');
      const cores = availableParallelism();
      loadAt(cores);

      await expect(merge(adapterWith(GateStage.Test, failsOnce(timesOut)))).rejects.toThrow(
        underLoad(cores, 'src/a.test.ts > times out under load'),
      );

      expect(runsOf('test-run')).toBe(2);
      expect(steerPane).not.toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.reject_count).toBe(0);
      expect(readdirSync(slots)).toEqual(['slot-0.lock']);
      expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
    });

    it('still rejects a test stage whose re-run ran out its timeout under load with no other test run', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      shortTimeout();
      ownSlots();
      loadAt(availableParallelism());

      const outcome = await merge(adapterWith(GateStage.Test, failsOnce(timesOut)));

      expect(outcome.status).toBe(MergeStatus.Rejected);
      expect(runsOf('test-run')).toBe(2);
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: GateStage.Test,
        status: GateStageStatus.Fail,
      });
      expect(steerPane).toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.reject_count).toBe(1);
    });

    // `testRunsElsewhere` counts an unreadable slots directory as a run, to
    // keep its wait; the gate's own read counts it as none, since here it
    // would spare a rejection (decision 138). Root reads any directory.
    it.skipIf(process.getuid?.() === 0)(
      'rejects a timeout under load once the slots directory cannot be listed',
      async () => {
        const worktree = seedSession(db, repo);
        commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
        shortTimeout();
        const slots = ownSlots('s-other');
        const restore = (): void => chmodSync(slots, 0o755);
        onTestFinished(restore);
        const cores = availableParallelism();
        // Listing refused, writes and unlinks by name still allowed, from the
        // run's start: the gate still frees its slot by name.
        let unlisted = false;
        loadAt(() => {
          if (!unlisted && runsOf('test-run') > 0) {
            chmodSync(slots, 0o300);
            unlisted = true;
          }
          return cores;
        });

        const outcome = await merge(adapterWith(GateStage.Test, timesOut));
        restore();

        expect(outcome.status).toBe(MergeStatus.Rejected);
        expect(outcome.report.stages.at(-1)).toMatchObject({
          stage: GateStage.Test,
          status: GateStageStatus.Fail,
        });
        expect(steerPane).toHaveBeenCalled();
        expect(getSession(db, SESSION_ID)?.reject_count).toBe(1);
      },
    );

    it("counts another gate's wait, named as the slots module names one, as another test run", async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      shortTimeout();
      const slots = ownSlots(SESSION_ID);
      writeFileSync(
        join(slots, `gate-${process.ppid}-k3x9q.wait`),
        slotRecord('s-other', process.ppid, SlotHolderKind.Gate),
      );
      const cores = availableParallelism();
      loadAt(cores);

      await expect(merge(adapterWith(GateStage.Test, timesOut))).rejects.toThrow(underLoad(cores));
      expect(steerPane).not.toHaveBeenCalled();
    });

    it('with openPr pushes nothing and writes nothing to a PR when it refuses a timeout under load', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const bare = addOrigin();
      shortTimeout();
      ownSlots('s-other');
      const cores = availableParallelism();
      loadAt(cores);

      await expect(
        withFakeGh(fakeGh([]), () =>
          runMergeGate(db, {
            repoPath: repo,
            sessionId: SESSION_ID,
            adapters: [adapterWith(GateStage.Test, timesOut)],
            openPr: true,
          }),
        ),
      ).rejects.toThrow(underLoad(cores));

      expect(ghCalls().some((call) => /^pr (create|edit|comment)/.test(call))).toBe(false);
      expect(sh(bare, 'git', 'branch', '--list', BRANCH).trim()).toBe('');
      expect(steerPane).not.toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.state).toBe(SessionState.AwaitingReview);
    });

    // A session's own tests can fill the cores until the cap; only load that
    // was there before the run, with another session's or gate's test run
    // going, is evidence the session cannot make alone (decision 138).
    it.each([
      ['quiet before its run and loaded only by it, with no other test run', loadedByTheRun],
      [
        'quiet before its run and loaded only during it, with another test run',
        loadedByTheRun,
        's-other',
      ],
      ['loaded before and during its run, with no other test run', availableParallelism],
      [
        'loaded before and during its run, with the only other slot held by the gated session itself',
        availableParallelism,
        SESSION_ID,
      ],
    ] as [string, () => number, string?][])(
      'still rejects a test stage that ran out its timeout %s',
      async (_case, load, holder) => {
        const worktree = seedSession(db, repo);
        commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
        shortTimeout();
        ownSlots(holder);
        loadAt(load);

        const outcome = await merge(adapterWith(GateStage.Test, timesOut));

        expect(outcome.status).toBe(MergeStatus.Rejected);
        expect(runsOf('test-run')).toBe(1);
        expect(outcome.report.stages.at(-1)).toMatchObject({
          stage: GateStage.Test,
          status: GateStageStatus.Fail,
        });
        expect(steerPane).toHaveBeenCalled();
        expect(getSession(db, SESSION_ID)?.reject_count).toBe(1);
      },
    );

    // The gated session's own slot keeps `testRunsElsewhere` true, so only
    // the planted record could make the evidence, and none may: each reads as
    // no other test run, and the timeout stays a rejection (decision 138). The
    // first three sit in a slot the slots module never reads, so its own
    // reclaim cannot remove them before the gate's read does.
    it.each([
      ['malformed JSON', (slots: string) => writeFileSync(join(slots, 'slot-2.lock'), '{"pid":')],
      [
        'a symlinked record',
        (slots: string) => {
          const target = join(tempDir('pup-slot-target-'), 'record');
          writeFileSync(target, slotRecord('s-other', process.ppid));
          symlinkSync(target, join(slots, 'slot-2.lock'));
        },
      ],
      [
        'a dead pid',
        (slots: string) =>
          writeFileSync(join(slots, 'slot-2.lock'), slotRecord('s-other', DEAD_PID)),
      ],
      [
        'a stale wait',
        (slots: string) => {
          const path = join(slots, `gate-${process.ppid}-k3x9q.wait`);
          writeFileSync(path, slotRecord('s-other', process.ppid, SlotHolderKind.Gate));
          const past = (Date.now() - GATE_SLOT_WAIT_MS - 60_000) / 1000;
          utimesSync(path, past, past);
        },
      ],
      [
        "the gate's own pid",
        (slots: string) =>
          writeFileSync(
            join(slots, `gate-${process.pid}-k3x9q.wait`),
            slotRecord('s-other', process.pid, SlotHolderKind.Gate),
          ),
      ],
      [
        'a wait whose name is not the slots module’s',
        (slots: string) =>
          writeFileSync(
            join(slots, 'planted.wait'),
            slotRecord('s-other', process.ppid, SlotHolderKind.Gate),
          ),
      ],
      [
        'a wait whose name names another pid',
        (slots: string) =>
          writeFileSync(
            join(slots, `gate-${DEAD_PID}-k3x9q.wait`),
            slotRecord('s-other', process.ppid, SlotHolderKind.Gate),
          ),
      ],
    ])('rejects a timeout under load whose only other run is %s', async (_case, plant) => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      shortTimeout();
      plant(ownSlots(SESSION_ID));
      loadAt(availableParallelism());

      const outcome = await merge(adapterWith(GateStage.Test, timesOut));

      expect(outcome.status).toBe(MergeStatus.Rejected);
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: GateStage.Test,
        status: GateStageStatus.Fail,
      });
      expect(steerPane).toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.reject_count).toBe(1);
    });

    it('still rejects a real test failure at a load over the cores', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      loadAt(availableParallelism() * 4);

      const outcome = await merge(
        adapterWith(GateStage.Test, failsOnce('printf "FAILED tests/b.py::test_other\\n"; exit 1')),
      );

      expect(outcome.status).toBe(MergeStatus.Rejected);
      expect(runsOf('test-run')).toBe(2);
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: GateStage.Test,
        status: GateStageStatus.Fail,
      });
      expect(steerPane).toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.reject_count).toBe(1);
    });

    it.each([GateStage.Build, GateStage.Lint])('never re-runs a failed %s', async (stage) => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      const outcome = await merge(adapterWith(stage, failsOnce('exit 0')));

      expect(outcome.status).toBe(MergeStatus.Rejected);
      expect(runsOf(`${stage}-run`)).toBe(1);
      expect(outcome.report.stages.at(-1)).toMatchObject({ stage, status: GateStageStatus.Fail });
    });

    it('runs its stages at the priority pup runs at, never under nice', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

      expect((await merge(adapterWith(GateStage.Test, 'exit 0'))).status).toBe(MergeStatus.Merged);

      const call = vi.mocked(spawn).mock.calls.find(([, args]) => args?.includes('test-run'));
      expect(call).toBeDefined();
      const argv = [call?.[0], ...(call?.[1] ?? [])].map(String);
      expect(argv.some((word) => word === 'nice' || word.endsWith('/nice'))).toBe(false);
    });
  });

  it('hard-fails a protected .claude path even when git would C-quote its name', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, '.claude/café.md', 'smuggled hook config\n');

    const outcome = await merge();

    expect(outcome.status).toBe(MergeStatus.Rejected);
    expect(outcome.report.stages.at(-1)).toMatchObject({
      stage: 'scope-audit',
      status: GateStageStatus.Fail,
    });
    expect(outcome.report.stages.at(-1)?.detail).toContain('café.md (protected path)');
  });

  it('fails preflight when the worktree is dirty', async () => {
    const worktree = seedSession(db, repo);
    writeFileSync(join(worktree, 'src/uncommitted.ts'), 'export const x = 1;\n');

    const outcome = await merge();

    expect(outcome.status).toBe(MergeStatus.Rejected);
    expect(outcome.report.stages.at(-1)).toMatchObject({
      stage: 'worktree-clean',
      status: GateStageStatus.Fail,
    });
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

    expect(outcome.status).toBe(MergeStatus.Merged);
    expect(outcome.debtCandidates).toEqual([{ id: openId, description: 'shortcut in feature.ts' }]);
  });

  it('refuses an oversize diff without --accept-debt and leaves the session reviewable', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.ts', 'const line = 1;\n'.repeat(700));

    const outcome = await merge();

    expect(outcome.status).toBe(MergeStatus.Refused);
    expect(outcome.report.stages).toContainEqual(
      expect.objectContaining({ stage: 'diff-size', status: GateStageStatus.Flagged }),
    );
    expect(getSession(db, SESSION_ID)?.state).toBe(SessionState.AwaitingReview);
    expect(getSession(db, SESSION_ID)?.reject_count).toBe(0);
    expect(steerPane).not.toHaveBeenCalled();
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

    expect(outcome.status).toBe(MergeStatus.Merged);
    expect(listLedgerEntries(db, 'proj-1')[0]?.accepted_by).toBe('tg: [2Jalexis');
  });

  // A script, a YAML list or a serverless handler spells the name between
  // punctuation no specifier uses, before or after it, or with an export after it.
  it.each([
    ['package.json', '{ "scripts": { "start": "tsx src/big.test.ts;" } }\n'],
    ['run.sh', 'node dist/big.test.js&&true\n'],
    ['src/start.sh', '(node ./big.test.js)\n'],
    ['entries.yml', 'entries: [src/big.test.ts]\n'],
    ['serverless.yml', 'handler: src/big.test.handler\n'],
    ['lint.sh', 'eslint a.ts,big.test.ts\n'],
    ['list.yml', 'files: [big.test.ts]\n'],
  ])('counts a test file %s names as source', async (file, content) => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', file] });
    commitIn(worktree, 'src/big.test.ts', 'export const handler = 1;\n'.repeat(5));
    commitIn(worktree, file, content);

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: GateStageStatus.Pass,
      detail: '6 source + 0 test + 0 docs changed lines',
    });
  });

  // Quadratic matching here would hold the merge lock for minutes; the test
  // timeout is the bound.
  it('reads a 1 MB unspaced line in an importer without stalling', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.test.ts', 'export const v = 1;\n');
    commitIn(worktree, 'src/use.ts', `${'x'.repeat(1_000_000)}\nexport * from './big.test.js';\n`);

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: GateStageStatus.Pass,
      detail: '3 source + 0 test + 0 docs changed lines',
    });
  });

  // `git grep` never reads a link's blob, so a link is read from the tree:
  // what it reaches is code under another name.
  it('counts the doc, test or directory a symlink reaches as source', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'docs/**'] });
    commitIn(worktree, 'docs/impl.md', 'print(1)\n'.repeat(5));
    commitIn(worktree, 'src/big.test.ts', 'export const v = 1;\n'.repeat(3));
    commitIn(worktree, 'docs/guide/a.md', 'prose\n'.repeat(2));
    commitIn(worktree, 'docs/other.md', 'prose\n'.repeat(4));
    commitIn(worktree, 'src/plain.test.ts', 'x\n');
    mkdirSync(join(worktree, 'src/pkg'));
    symlinkSync('../../docs/impl.md', join(worktree, 'src/pkg/impl.py'));
    symlinkSync('big.test.ts', join(worktree, 'src/impl.ts'));
    symlinkSync('../docs/guide', join(worktree, 'src/guide'));
    sh(worktree, 'git', 'add', '.');
    sh(worktree, 'git', 'commit', '-m', 'link into docs and a test');

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: GateStageStatus.Pass,
      detail: '13 source + 1 test + 4 docs changed lines',
    });
  });

  // The gate's filesystem (APFS) opens `DOCS/impl.md` as `docs/impl.md`.
  it('counts the doc or test a symlink reaches in another case as source', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'docs/**'] });
    commitIn(worktree, 'docs/impl.md', 'print(1)\n'.repeat(5));
    commitIn(worktree, 'src/big.test.ts', 'export const v = 1;\n'.repeat(3));
    commitIn(worktree, 'docs/other.md', 'prose\n'.repeat(4));
    mkdirSync(join(worktree, 'src/pkg'));
    symlinkSync('../../DOCS/impl.md', join(worktree, 'src/pkg/impl.py'));
    symlinkSync('Big.test.ts', join(worktree, 'src/impl.ts'));
    sh(worktree, 'git', 'add', '.');
    sh(worktree, 'git', 'commit', '-m', 'link into docs and a test in another case');

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: GateStageStatus.Pass,
      detail: '10 source + 0 test + 4 docs changed lines',
    });
  });

  // Docusaurus compiles `.md` under root docs/ as MDX, which can export code.
  // The gate's filesystem finds its config in any case, and `--config` takes
  // one under any name, so a manifest naming Docusaurus counts too, and so
  // does a lockfile, which spells the name plainly however a manifest escapes it.
  it.each([
    ['docusaurus.config.ts', 'export default {};\n'],
    ['Docusaurus.config.js', 'module.exports = {};\n'],
    ['website/Package.json', '{ "dependencies": { "@docusaurus/core": "3.0.0" } }\n'],
    ['website/package.yaml', "dependencies: { '@docusaurus/core': 3.0.0 }\n"],
    ['website/package.json5', "{ dependencies: { '@docusaurus/core': '3.0.0' } }\n"],
    ['website/pnpm-lock.yaml', "  '@docusaurus/core': 3.0.0\n"],
    ['website/package-lock.json', '{ "packages": { "node_modules/@docusaurus/core": {} } }\n'],
    ['website/yarn.lock', '"@docusaurus/core@^3.0.0":\n'],
  ])('counts Markdown under docs/ as source beside %s', async (file, content) => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'docs/**', file] });
    commitIn(worktree, file, content);
    commitIn(worktree, 'docs/big.md', 'export const v = 1;\n'.repeat(5));
    commitIn(worktree, 'docs/notes.rst', 'prose\n'.repeat(2));

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: GateStageStatus.Pass,
      detail: '6 source + 0 test + 2 docs changed lines',
    });
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

      expect(outcome.status).toBe(MergeStatus.Refused);
      const stage = outcome.report.stages.find((s) => s.stage === 'diff-size');
      expect(stage?.status).toBe(GateStageStatus.Flagged);
      expect(stage?.detail).toContain(
        '700 source + 0 test + 0 docs changed lines: source exceeds the 600-line flag',
      );
      expect(stage?.detail).toContain('src/big.ts');
    });

    it('flags a forged binary even when the recounted diff is small', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      forgeBinary();

      const outcome = await merge();

      expect(outcome.status).toBe(MergeStatus.Refused);
      expect(outcome.report.stages).toContainEqual(
        expect.objectContaining({ stage: 'diff-size', status: GateStageStatus.Flagged }),
      );
    });

    it('still counts a real binary as free', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/icon.ico', `\0\0\x01\0${'x\0y\n'.repeat(700)}`);
      forgeBinary();

      const outcome = await merge();

      expect(outcome.status).toBe(MergeStatus.Merged);
      expect(untimed(outcome.report.stages)).toContainEqual({
        stage: 'diff-size',
        status: GateStageStatus.Pass,
        detail: '0 source + 0 test + 0 docs changed lines',
      });
    });
  });

  it('blocks instead of rejecting when the re-steer cannot be delivered', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    vi.mocked(steerPane).mockImplementationOnce(() => {
      throw new Error('no tmux session');
    });

    const outcome = await merge(failingBuildAdapter);

    expect(outcome.status).toBe(MergeStatus.Blocked);
    expect(getSession(db, SESSION_ID)?.state).toBe(SessionState.Blocked);
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

    expect(outcome.status).toBe(MergeStatus.Blocked);
    expect(getSession(db, SESSION_ID)?.state).toBe(SessionState.Blocked);
    const reason = blockedReason(db);
    expect(reason).toContain(SESSION_ID);
    expect(reason).toContain('1234-char');
    expect(reason).toContain('Ctrl-U could not clear');
    expect(reason).not.toContain('unreachable');
  });

  describe('a merge lock that records its holder (decision 88)', () => {
    const lock = () => join(repo, '.git', 'pup-merge.lock');
    const holdLock = (pid: string) => {
      mkdirSync(lock());
      writeFileSync(join(lock(), 'pid'), pid);
    };
    /** A pid that was alive a moment ago and is not now. */
    const deadPid = () => execFileSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim();

    it('reclaims a lock whose holder died and merges, leaving no lock', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      holdLock(`${deadPid()}\n`);

      expect((await merge()).status).toBe(MergeStatus.Merged);
      expect(existsSync(lock())).toBe(false);
      expect(readdirSync(join(repo, '.git')).filter((n) => n.startsWith('pup-merge'))).toEqual([]);
    });

    it.each([
      ['held by a live pid', () => `${process.pid}\n`],
      ['whose pid file is not a pid', () => 'not a pid\n'],
      ['whose pid file is empty', () => ''],
    ])('refuses a lock %s, leaving it as it was', async (_, pid) => {
      seedSession(db, repo);
      holdLock(pid());

      await expect(merge()).rejects.toThrow(MergeLockHeldError);
      expect(readFileSync(join(lock(), 'pid'), 'utf8')).toBe(pid());
      expect(getSession(db, SESSION_ID)?.state).toBe(SessionState.AwaitingReview);
    });

    // Removing a lock a live run holds would let two merges run at once.
    it('tells the operator not to remove a lock a live pid holds', async () => {
      seedSession(db, repo);
      holdLock(`${process.pid}\n`);

      await expect(merge()).rejects.toThrow(
        `Another merge is in progress: pid ${process.pid} holds the lock at ${lock()}. Do not ` +
          'remove it; retry once that run ends.',
      );
    });

    it('waits, when asked, for a live holder to release it, then merges', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      holdLock(`${process.pid}\n`);
      const realLoad = vi.mocked(loadavg).getMockImplementation();
      vi.mocked(loadavg).mockImplementation(() => [0, 0, 0]);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      onTestFinished(() => {
        errors.mockRestore();
        vi.mocked(loadavg).mockImplementation(realLoad as never);
      });
      setTimeout(() => rmSync(lock(), { recursive: true }), 200);

      const outcome = await runMergeGate(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [passingAdapter],
        wait: true,
      });

      expect(outcome.status).toBe(MergeStatus.Merged);
      const waits = errors.mock.calls.flat().filter((line) => String(line).includes('merge lock'));
      expect(waits).toEqual([
        expect.stringMatching(
          new RegExp(`^Waiting for the merge lock, held by pid ${process.pid}, for up to `),
        ),
      ]);
    });

    // What the run before the wait read is stale once the holder has run: the
    // gate plans again under the lock, as a run started then would.
    describe('plans again once a wait ends', () => {
      /** A merge asked to wait, with the holder's run `meanwhile` done as it releases the lock. */
      const mergeAfter = (meanwhile: () => void) => {
        holdLock(`${process.pid}\n`);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        onTestFinished(() => errors.mockRestore());
        setTimeout(() => {
          meanwhile();
          rmSync(lock(), { recursive: true });
        }, 200);
        return runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [passingAdapter],
          wait: true,
        });
      };

      it('refuses a session the holder rejected and re-steered, leaving main where it was', async () => {
        const worktree = seedSession(db, repo);
        commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
        const mainBefore = sh(repo, 'git', 'rev-parse', 'main').trim();

        await expect(
          mergeAfter(() => {
            transitionSession(db, SESSION_ID, SessionState.Rejected);
            transitionSession(db, SESSION_ID, SessionState.Running);
          }),
        ).rejects.toThrow(SessionNotReviewableError);

        expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(mainBefore);
        expect(getSession(db, SESSION_ID)?.state).toBe(SessionState.Running);
        expect(getSession(db, SESSION_ID)?.reject_count).toBe(0);
        expect(
          listEvents(db, SESSION_ID).filter((event) => event.type === EventType.Merge),
        ).toEqual([]);
      });

      // No wait at all: the holder released while this run read GitHub, or
      // died and was reclaimed, after changing the session.
      it('plans again when the session changed between the plan and the take', async () => {
        const worktree = seedSession(db, repo);
        commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
        // The pid write is the take's, after the plan read the session.
        const pidFile = join(repo, '.git', 'pup-merge.lock', 'pid');
        const real = vi.mocked(writeFileSync).getMockImplementation();
        let rejected = false;
        vi.mocked(writeFileSync).mockImplementation(((
          ...args: Parameters<typeof writeFileSync>
        ) => {
          if (!rejected && args[0] === pidFile) {
            rejected = true;
            transitionSession(db, SESSION_ID, SessionState.Rejected);
            transitionSession(db, SESSION_ID, SessionState.Running);
          }
          return real?.(...args);
        }) as never);
        onTestFinished(() => {
          vi.mocked(writeFileSync).mockImplementation(real as never);
        });

        await expect(merge()).rejects.toThrow(SessionNotReviewableError);
        expect(rejected).toBe(true);
        expect(
          listEvents(db, SESSION_ID).filter((event) => event.type === EventType.Merge),
        ).toEqual([]);
      });

      // The plan's own gh calls, before it has settled anything: the mark
      // must predate them, or the change is in the plan's mark too.
      it('plans again when the session changed while the plan read GitHub', async () => {
        const worktree = seedSession(db, repo);
        commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
        seedDebtBaseline({});
        addOrigin();
        const real = vi.mocked(execFileSync).getMockImplementation();
        let rejected = false;
        vi.mocked(execFileSync).mockImplementation(((
          file: string,
          args: string[],
          opts: object,
        ) => {
          const output = real?.(file, args, opts as never);
          if (!rejected && file === 'gh' && args[1] === 'list') {
            rejected = true;
            transitionSession(db, SESSION_ID, SessionState.Rejected);
            transitionSession(db, SESSION_ID, SessionState.Running);
          }
          return output;
        }) as never);
        onTestFinished(() => {
          vi.mocked(execFileSync).mockImplementation(real as never);
        });

        await expect(
          withFakeGh(fakeGh([]), () =>
            runMergeGate(db, {
              repoPath: repo,
              sessionId: SESSION_ID,
              adapters: [passingAdapter],
              openPr: true,
            }),
          ),
        ).rejects.toThrow(SessionNotReviewableError);
        expect(rejected).toBe(true);
        expect(ghCalls().some((call) => call.includes('pr create'))).toBe(false);
        expect(
          listEvents(db, SESSION_ID).filter((event) => event.type === EventType.Merge),
        ).toEqual([]);
      });

      it('refuses a session the holder merged, recording no second merge', async () => {
        const worktree = seedSession(db, repo);
        commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

        await expect(
          mergeAfter(() => transitionSession(db, SESSION_ID, SessionState.Merged)),
        ).rejects.toThrow(SessionNotReviewableError);

        expect(
          listEvents(db, SESSION_ID).filter((event) => event.type === EventType.Merge),
        ).toEqual([]);
      });
    });
  });

  // Not "every stage skipped and merged anyway": with no adapter the hard
  // stages report "no command available" and every debt stage "adapter cannot
  // measure", so a full-looking report would sit on top of nothing measured.
  it('refuses a request that carries no adapter at all, before taking the lock', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

    await expect(merge([])).rejects.toThrow(/No adapter for/);
    expect(getSession(db, SESSION_ID)?.state).toBe(SessionState.AwaitingReview);
    expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
  });

  it('measures the gate checkout but reads tool config from the main checkout', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const head = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();
    const target = sh(repo, 'git', 'rev-parse', 'HEAD').trim();
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
    // to un-declare the tool that measures it (decision 29). The pinned sha
    // rides along, for what git reads of it from the main checkout's repo
    // (decision 101), and so does the target sha the lock pinned, which the
    // main checkout's committed tree is read at, never at its HEAD (decision 161).
    expect(seen).toEqual({
      measurePath: expect.stringMatching(GATE_CHECKOUT),
      configPath: repo,
      measureSha: head,
      configSha: target,
    });
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

    expect(outcome.status).toBe(MergeStatus.Merged);
    const stored = JSON.parse(getProject(db, 'proj-1')?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt).toEqual({
      deadExports: [{ file: 'src/legacy.ts', exportName: 'old' }],
      duplicatedLines: 5,
      duplicationRule: DUPLICATION_RULE_ID,
    });
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

    expect(outcome.status).toBe(MergeStatus.Merged);
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

    expect(outcome.status).toBe(MergeStatus.Merged);
    expect(listLedgerEntries(db, 'proj-1').map((e) => e.accepted_by)).toEqual(['tg:alexis']);
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
    expect(getSession(db, SESSION_ID)?.state).toBe(SessionState.AwaitingReview);
  });

  describe("the gate's test run takes a test slot (decision 96)", () => {
    let slots: string;

    beforeEach(() => {
      const home = tempDir('pup-slot-home-');
      vi.stubEnv('HOME', home);
      vi.stubEnv(HELD_SLOT_ENV, '');
      slots = join(home, '.pupitre', 'slots');
      mkdirSync(slots, { recursive: true });
      // Both slots held by a live process that is not this one.
      for (const index of [0, 1]) {
        writeFileSync(
          join(slots, `slot-${index}.lock`),
          JSON.stringify({
            kind: SlotHolderKind.Worker,
            label: 's-other',
            pid: process.ppid,
            token: `t${index}`,
          }),
        );
      }
    });

    const settledWithin = async (gate: Promise<unknown>, ms: number): Promise<boolean> => {
      let settled = false;
      void gate.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, ms));
      return settled;
    };

    it('waits while every slot is held, saying for whom, and merges once one frees', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      onTestFinished(() => errors.mockRestore());

      const gate = merge();

      expect(await settledWithin(gate, 1500)).toBe(false);
      expect(errors.mock.calls.flat().join('\n')).toContain(
        `Waiting for a test slot, held by session s-other (pid ${process.ppid}) and session ` +
          `s-other (pid ${process.ppid}).`,
      );
      rmSync(join(slots, 'slot-1.lock'));
      expect((await gate).status).toBe(MergeStatus.Merged);
      expect(existsSync(join(slots, 'slot-1.lock'))).toBe(false);
    });

    it('is served the freed slot before a worker that was waiting first', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let workerRan = false;
      const worker = withTestSlot(
        { kind: SlotHolderKind.Worker, label: 's-waiting' },
        async () => {
          workerRan = true;
        },
        { pollMs: 10 },
      );

      const gate = merge();
      while (!readdirSync(slots).some((name) => name.endsWith('.wait'))) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      rmSync(join(slots, 'slot-1.lock'));
      // The worker polls a hundred times faster than the gate, and still waits.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(workerRan).toBe(false);

      expect((await gate).status).toBe(MergeStatus.Merged);
      await worker;
      expect(workerRan).toBe(true);
    });

    it("waits for a slot for a nested package's suite when the root has none", async () => {
      const scripts = { test: 'true', typecheck: 'true' };
      commitIn(repo, 'tools/review/package.json', JSON.stringify({ scripts }));
      const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'tools/**'] });
      commitIn(worktree, 'tools/review/src/r.ts', 'export const r = 1;\n');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const adapter: Adapter = {
        ...passingAdapter,
        gateCommands: () => [{ stage: GateStage.Build, command: 'true', args: [] }],
        touchedNestedPackages: typescriptAdapter.touchedNestedPackages,
      };

      const gate = merge(adapter);
      while (!readdirSync(slots).some((name) => name.endsWith('.wait'))) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      rmSync(join(slots, 'slot-1.lock'));

      const outcome = await gate;
      expect(outcome.status).toBe(MergeStatus.Merged);
      expect(outcome.report.stages.map((stage) => stage.stage)).toContain('test (tools/review)');
    });

    it('runs its tests without a slot once its wait runs out, saying so', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      onTestFinished(() => errors.mockRestore());
      slotWait.ms = 1000;
      onTestFinished(() => {
        slotWait.ms = undefined;
      });

      expect((await merge()).status).toBe(MergeStatus.Merged);
      expect(errors.mock.calls.flat().join('\n')).toContain(
        'No test slot came free in 1.0s; the gate runs its tests without one.',
      );
      // Both still held by their live holder, and no wait left behind.
      expect(readdirSync(slots).sort()).toEqual(['slot-0.lock', 'slot-1.lock']);
    });

    it('runs its tests without a slot when a session planted a file where the slots go', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      onTestFinished(() => errors.mockRestore());
      rmSync(slots, { recursive: true });
      writeFileSync(slots, '');

      expect((await merge()).status).toBe(MergeStatus.Merged);
      expect(errors.mock.calls.flat().join('\n')).toMatch(
        /The test slots could not be used \(.+\); the gate runs its tests without one\./,
      );
    });
  });
});
