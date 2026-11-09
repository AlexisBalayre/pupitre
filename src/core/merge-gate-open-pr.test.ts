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
  blockedReason,
  commitIn,
  debtAdapter,
  failingBuildAdapter,
  GATE_CHECKOUT,
  initRepo,
  passingAdapter,
  SESSION_ID,
  seedSession,
  sh,
  untimed,
} from '@test/helpers/merge-gate.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Adapter, CapabilityContext } from '../adapters/types/adapter.types.js';
import { typescriptAdapter } from '../adapters/typescript.adapter.js';
import { SteerNotDeliveredError, steerPane } from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { ArmedGitDriverError } from './git-diff.client.js';
import { insertLedgerEntry, listLedgerEntries } from './ledger.repository.js';
import { DUPLICATION_RULE_ID } from './merge-gate.constants.js';
import { MergeLockHeldError, SessionNotReviewableError } from './merge-gate.errors.js';
import { runMergeGate as runGate } from './merge-gate.service.js';
import {
  getProject,
  getSession,
  listEvents,
  saveProjectBaseline,
  saveProjectOriginUrl,
  transitionSession,
} from './session.repository.js';
import { GATE_SLOT_WAIT_MS, HELD_SLOT_ENV, withTestSlot } from './test-slot.service.js';
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

  // git names a worktree's admin dir after its basename, so a gate checkout named
  // `checkout` would take `checkout1` beside the conductor's, and the pinned
  // read-tree would refuse its own checkout (decision 101).
  it('merges while another worktree already holds the admin dir named checkout', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    sh(repo, 'git', 'worktree', 'add', '-q', '--detach', join(repo, '.pup', 'checkout'));

    const outcome = await merge();

    expect(outcome.status).toBe('merged');
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
    const slotRecord = (label: string, pid: number, kind = 'worker'): string =>
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

    /** The refusal a test run timed out under `load` throws (decision 138). */
    const underLoad = (load: number): string =>
      `The test stage timed out under load ${load.toFixed(1)}, at or over the machine's ` +
      `${availableParallelism()} cores, with other test runs going; nothing was merged; run ` +
      'pup merge again when the load falls.';

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

      const outcome = await merge(adapterWith('test', timesOut));

      expect(outcome.status).toBe('rejected');
      expect(runsOf('test-run')).toBe(1);
      expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'test', status: 'fail' });
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

      await expect(merge(adapterWith('test', timesOut))).rejects.toThrow(underLoad(cores));

      expect(runsOf('test-run')).toBe(1);
      expect(steerPane).not.toHaveBeenCalled();
      const session = getSession(db, SESSION_ID);
      expect(session?.state).toBe('awaiting-review');
      expect(session?.reject_count).toBe(0);
      expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(before);
      expect(existsSync(worktree)).toBe(true);
      // The gate's slot freed and no wait left behind; the other run's kept.
      expect(readdirSync(slots)).toEqual(['slot-0.lock']);
      // The merge lock released: the next run takes it and merges.
      expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
      gateTimeout.ms = undefined;
      expect((await merge()).status).toBe('merged');
    });

    // The first run failed on its own, so it gets its re-run; the re-run is
    // what the load ran out, and it is judged as a first run would be.
    it('refuses a test stage whose re-run ran out its timeout under load, after a first run that failed', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      shortTimeout();
      const slots = ownSlots('s-other');
      const cores = availableParallelism();
      loadAt(cores);

      await expect(merge(adapterWith('test', failsOnce(timesOut)))).rejects.toThrow(
        underLoad(cores),
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

      const outcome = await merge(adapterWith('test', failsOnce(timesOut)));

      expect(outcome.status).toBe('rejected');
      expect(runsOf('test-run')).toBe(2);
      expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'test', status: 'fail' });
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

        const outcome = await merge(adapterWith('test', timesOut));
        restore();

        expect(outcome.status).toBe('rejected');
        expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'test', status: 'fail' });
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
        slotRecord('s-other', process.ppid, 'gate'),
      );
      const cores = availableParallelism();
      loadAt(cores);

      await expect(merge(adapterWith('test', timesOut))).rejects.toThrow(underLoad(cores));
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
            adapters: [adapterWith('test', timesOut)],
            openPr: true,
          }),
        ),
      ).rejects.toThrow(underLoad(cores));

      expect(ghCalls().some((call) => /^pr (create|edit|comment)/.test(call))).toBe(false);
      expect(sh(bare, 'git', 'branch', '--list', BRANCH).trim()).toBe('');
      expect(steerPane).not.toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
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

        const outcome = await merge(adapterWith('test', timesOut));

        expect(outcome.status).toBe('rejected');
        expect(runsOf('test-run')).toBe(1);
        expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'test', status: 'fail' });
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
          writeFileSync(path, slotRecord('s-other', process.ppid, 'gate'));
          const past = (Date.now() - GATE_SLOT_WAIT_MS - 60_000) / 1000;
          utimesSync(path, past, past);
        },
      ],
      [
        "the gate's own pid",
        (slots: string) =>
          writeFileSync(
            join(slots, `gate-${process.pid}-k3x9q.wait`),
            slotRecord('s-other', process.pid, 'gate'),
          ),
      ],
      [
        'a wait whose name is not the slots module’s',
        (slots: string) =>
          writeFileSync(join(slots, 'planted.wait'), slotRecord('s-other', process.ppid, 'gate')),
      ],
      [
        'a wait whose name names another pid',
        (slots: string) =>
          writeFileSync(
            join(slots, `gate-${DEAD_PID}-k3x9q.wait`),
            slotRecord('s-other', process.ppid, 'gate'),
          ),
      ],
    ])('rejects a timeout under load whose only other run is %s', async (_case, plant) => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      shortTimeout();
      plant(ownSlots(SESSION_ID));
      loadAt(availableParallelism());

      const outcome = await merge(adapterWith('test', timesOut));

      expect(outcome.status).toBe('rejected');
      expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'test', status: 'fail' });
      expect(steerPane).toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.reject_count).toBe(1);
    });

    it('still rejects a real test failure at a load over the cores', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      loadAt(availableParallelism() * 4);

      const outcome = await merge(
        adapterWith('test', failsOnce('printf "FAILED tests/b.py::test_other\\n"; exit 1')),
      );

      expect(outcome.status).toBe('rejected');
      expect(runsOf('test-run')).toBe(2);
      expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'test', status: 'fail' });
      expect(steerPane).toHaveBeenCalled();
      expect(getSession(db, SESSION_ID)?.reject_count).toBe(1);
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

  it('hard-fails a protected .claude path even when git would C-quote its name', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    commitIn(worktree, '.claude/café.md', 'smuggled hook config\n');

    const outcome = await merge();

    expect(outcome.status).toBe('rejected');
    expect(outcome.report.stages.at(-1)).toMatchObject({ stage: 'scope-audit', status: 'fail' });
    expect(outcome.report.stages.at(-1)?.detail).toContain('café.md (protected path)');
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
      status: 'pass',
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
      status: 'pass',
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
      status: 'pass',
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
      status: 'pass',
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
      status: 'pass',
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

      expect(outcome.status).toBe('refused');
      const stage = outcome.report.stages.find((s) => s.stage === 'diff-size');
      expect(stage?.status).toBe('flagged');
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

      expect((await merge()).status).toBe('merged');
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
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
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

      expect(outcome.status).toBe('merged');
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
            transitionSession(db, SESSION_ID, 'rejected');
            transitionSession(db, SESSION_ID, 'running');
          }),
        ).rejects.toThrow(SessionNotReviewableError);

        expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(mainBefore);
        expect(getSession(db, SESSION_ID)?.state).toBe('running');
        expect(getSession(db, SESSION_ID)?.reject_count).toBe(0);
        expect(listEvents(db, SESSION_ID).filter((event) => event.type === 'merge')).toEqual([]);
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
            transitionSession(db, SESSION_ID, 'rejected');
            transitionSession(db, SESSION_ID, 'running');
          }
          return real?.(...args);
        }) as never);
        onTestFinished(() => {
          vi.mocked(writeFileSync).mockImplementation(real as never);
        });

        await expect(merge()).rejects.toThrow(SessionNotReviewableError);
        expect(rejected).toBe(true);
        expect(listEvents(db, SESSION_ID).filter((event) => event.type === 'merge')).toEqual([]);
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
            transitionSession(db, SESSION_ID, 'rejected');
            transitionSession(db, SESSION_ID, 'running');
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
        expect(listEvents(db, SESSION_ID).filter((event) => event.type === 'merge')).toEqual([]);
      });

      it('refuses a session the holder merged, recording no second merge', async () => {
        const worktree = seedSession(db, repo);
        commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');

        await expect(mergeAfter(() => transitionSession(db, SESSION_ID, 'merged'))).rejects.toThrow(
          SessionNotReviewableError,
        );

        expect(listEvents(db, SESSION_ID).filter((event) => event.type === 'merge')).toEqual([]);
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
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);
  });

  it('measures the gate checkout but reads tool config from the main checkout', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const head = sh(worktree, 'git', 'rev-parse', 'HEAD').trim();
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
    // (decision 101).
    expect(seen).toEqual({
      measurePath: expect.stringMatching(GATE_CHECKOUT),
      configPath: repo,
      measureSha: head,
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

    expect(outcome.status).toBe('merged');
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
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
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
            kind: 'worker',
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
      expect((await gate).status).toBe('merged');
      expect(existsSync(join(slots, 'slot-1.lock'))).toBe(false);
    });

    it('is served the freed slot before a worker that was waiting first', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let workerRan = false;
      const worker = withTestSlot(
        { kind: 'worker', label: 's-waiting' },
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

      expect((await gate).status).toBe('merged');
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
        gateCommands: () => [{ stage: 'build', command: 'true', args: [] }],
        touchedNestedPackages: typescriptAdapter.touchedNestedPackages,
      };

      const gate = merge(adapter);
      while (!readdirSync(slots).some((name) => name.endsWith('.wait'))) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      rmSync(join(slots, 'slot-1.lock'));

      const outcome = await gate;
      expect(outcome.status).toBe('merged');
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

      expect((await merge()).status).toBe('merged');
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

      expect((await merge()).status).toBe('merged');
      expect(errors.mock.calls.flat().join('\n')).toMatch(
        /The test slots could not be used \(.+\); the gate runs its tests without one\./,
      );
    });
  });
});
