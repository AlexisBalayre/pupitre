import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
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

// The real rmSync and renameSync, wrapped so a test can follow the gate
// checkout to the name it is removed under and fail that removal, and the real
// writeFileSync, so one can fail the merge lock's pid write.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: vi.fn(actual.rmSync),
    renameSync: vi.fn(actual.renameSync),
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
import { steerPane } from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { ArmedGitDriverError, WorktreeRepointedError } from './git-diff.client.js';
import { insertLedgerEntry, listLedgerEntries } from './ledger.repository.js';
import { DUPLICATION_RULE_ID } from './merge-gate.constants.js';
import { SessionNotReviewableError } from './merge-gate.errors.js';
import { runMergeGate as runGate } from './merge-gate.service.js';
import { GateInterruptedError } from './sandbox.utils.js';
import {
  getProject,
  getSession,
  listEvents,
  MalformedTaskSpecError,
  saveProjectBaseline,
  saveProjectOriginUrl,
  transitionSession,
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

  it.runIf(process.platform === 'darwin')('ignores the declaration on darwin', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    vi.stubEnv('PUP_SANDBOX', 'vm');

    const outcome = await merge();

    expect(outcome.report.sandbox).toMatch(
      /^sandbox-exec \(macOS\)$|^inherited \(pup is itself sandboxed\)$/,
    );
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
      const { rmSync: removeForReal, renameSync: renameForReal } =
        await vi.importActual<typeof import('node:fs')>('node:fs');
      // The checkout is removed under the name it was moved aside to (decision 155).
      const checkouts = new Map<string, string>();
      vi.mocked(renameSync).mockImplementation((from, to) => {
        if (/\/pup-gate-checkout-[^/]+$/.test(String(from)))
          checkouts.set(String(to), String(from));
        renameForReal(from, to);
      });
      const left: string[] = [];
      vi.mocked(rmSync).mockImplementation((path, options) => {
        const checkout = checkouts.get(String(path));
        if (!checkout) return removeForReal(path, options);
        left.push(checkout);
        throw Object.assign(new Error('ENOTEMPTY: directory not empty, rmdir'), {
          code: 'ENOTEMPTY',
        });
      });
      const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      onTestFinished(() => {
        vi.mocked(rmSync).mockImplementation(removeForReal);
        vi.mocked(renameSync).mockImplementation(renameForReal);
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

  // Git's sequencer takes the first `pull.twohead` it reads, the shared
  // config's before the `-c` pin, and runs any strategy but ort as
  // `git merge-<name>`, which a slash makes a path from the worktree.
  it('rebases with ort whatever pull.twohead the session wrote, running none of its own', async () => {
    const worktree = seedSession(db, repo);
    commitIn(repo, 'src/app.ts', 'export const app = 2;\n');
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const dir = tempDir('pup-twohead-');
    const fired = join(dir, 'fired');
    writeFileSync(join(dir, 'planted.sh'), `#!/bin/sh\ntouch '${fired}'\nexit 2\n`, {
      mode: 0o755,
    });
    // Empty, so the worktree stays clean; the climb lands at the root.
    mkdirSync(join(worktree, 'git-merge-'));
    sh(repo, 'git', 'config', 'pull.twohead', `/..${'/..'.repeat(32)}${dir}/planted.sh`);

    const outcome = await merge();

    expect(outcome.status).toBe('merged');
    expect(existsSync(fired)).toBe(false);
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

    // The gate's checkout gets its admin dir beside the sessions' own, so the
    // add must leave nothing for git to do before the pointers are checked.
    it('refuses its checkout when the commondir is rewritten between the add and the read-tree', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const armed = armedRepo(tempDir('pup-armed-'), 'src/app.ts');
      sh(armed, 'git', 'config', 'filter.pwn.smudge', `sh -c 'echo pwned >> ${marker}; cat'`);
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const gitDir = tempDir('pup-git-');
      const listing = join(gitDir, 'listing');
      writeFileSync(
        join(gitDir, 'git'),
        [
          '#!/bin/sh',
          `${realGit} "$@" || exit $?`,
          'prev=; add=; dir=',
          'for a in "$@"; do',
          '  if [ -n "$add" ] && [ -z "$dir" ]; then case "$a" in -*) ;; *) dir=$a ;; esac; fi',
          '  [ "$prev $a" = "worktree add" ] && add=1',
          '  prev=$a',
          'done',
          '[ -n "$dir" ] || exit 0',
          `ls -A "$dir" > ${listing}`,
          `echo ${armed} > "${join(repo, '.git', 'worktrees')}/$(basename "$dir")/commondir"`,
        ].join('\n'),
        { mode: 0o755 },
      );
      const originalPath = process.env.PATH;
      process.env.PATH = `${gitDir}:${originalPath}`;
      onTestFinished(() => {
        process.env.PATH = originalPath;
      });

      await expect(merge()).rejects.toThrow(WorktreeRepointedError);
      // The add checked nothing out, so no git read the rewritten pointer.
      expect(readFileSync(listing, 'utf8')).toBe('.git\n');
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

      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      onTestFinished(() => errors.mockRestore());

      // Merged under the pins; only the teardown, which validates the gitfile
      // itself, refuses the swapped one, and loudly: the worktree is kept and
      // git's refusal printed (decision 88).
      const outcome = await merge();
      expect(outcome).toMatchObject({ status: 'merged', keptWorktree: worktree });
      expect(errors.mock.calls.flat().join('\n')).toContain(
        `git worktree remove refused ${worktree}:`,
      );
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

    // A per-submodule `ignore` outranks diff.ignoreSubmodules from any config;
    // only the gate's own --ignore-submodules=all beats it. Committed, it rides
    // the rebase to the scope audit; in the index alone, the worktree-clean
    // stage refuses it.
    it.each([
      ['committed on the branch', true],
      ['in the index alone', false],
    ])('runs no child git in a gitlink under a .gitmodules override %s', async (_, committed) => {
      const worktree = seedSession(db, repo);
      commitIn(repo, 'README.md', '# hello\n');
      const sub = join(worktree, 'src/sub');
      armedRepo(sub, 'app.ts');
      const head = sh(sub, 'git', 'rev-parse', 'HEAD').trim();
      sh(worktree, 'git', 'update-index', '--add', '--cacheinfo', `160000,${head},src/sub`);
      const blob = join(dirname(marker), 'gitmodules');
      writeFileSync(blob, '[submodule "sub"]\n\tpath = src/sub\n\tignore = none\n');
      const id = sh(worktree, 'git', 'hash-object', '-w', '--', blob).trim();
      if (committed)
        sh(worktree, 'git', 'update-index', '--add', '--cacheinfo', `100644,${id},.gitmodules`);
      sh(worktree, 'git', 'commit', '-q', '-m', 'gitlink');
      if (!committed)
        sh(worktree, 'git', 'update-index', '--add', '--cacheinfo', `100644,${id},.gitmodules`);
      const later = () => new Date(Date.now() + 60_000);
      utimesSync(join(sub, 'app.ts'), later(), later());
      sh(worktree, 'git', '-c', 'diff.ignoreSubmodules=all', 'status', '--porcelain');
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      utimesSync(join(sub, 'app.ts'), later(), later());

      expect((await merge()).status).toBe('rejected');
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

  it('counts a lockfile-named file outside the repo root toward the diff size', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/pnpm-lock.yaml', 'generated: line\n'.repeat(700));

    const outcome = await merge();

    expect(outcome.status).toBe('refused');
    expect(outcome.report.stages).toContainEqual(
      expect.objectContaining({ stage: 'diff-size', status: 'flagged' }),
    );
  });

  // Only `.test.ts` is a spelling a vitest include is trusted to collect
  // (decision 39); the rest import as production code and nothing fails. A
  // name holding anything but a letter, a digit or `_ . $ + @ -` is never one
  // whole token, and one outside ASCII has forms no byte search finds, so no
  // name search could find what imports it.
  it('counts every test spelling but .test.ts, and a name no token spells, as source', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/a.spec.ts', 'x\n');
    commitIn(worktree, 'src/b.test.mts', 'x\n');
    commitIn(worktree, 'src/c.test.tsx', 'x\n');
    commitIn(worktree, 'src/d.test.js', 'x\n');
    commitIn(worktree, 'src/test_e.py', 'x\n');
    commitIn(worktree, 'src/f_test.py', 'x\n');
    commitIn(worktree, 'src/test_helpers/g.ts', 'x\n');
    commitIn(worktree, 'src/h.test.ts', 'x\n');
    commitIn(worktree, 'src/i j.test.ts', 'x\n');
    commitIn(worktree, 'src/k#l.test.ts', 'x\n');
    commitIn(worktree, 'src/m=n.test.ts', 'x\n');
    commitIn(worktree, 'src/é.test.ts', 'x\n');
    commitIn(worktree, 'src/[id].test.ts', 'x\n');
    commitIn(worktree, 'src/+page.test.ts', 'x\n');

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '12 source + 2 test + 0 docs changed lines',
    });
  });

  // `require` reads a `#` in a directory literally, so cutting the token at
  // it would leave only the directory's name.
  it('reads a ?raw or #fragment specifier, and a # in a directory, as naming the test file', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/raw.test.ts', 'export const r = 1;\n'.repeat(2));
    commitIn(worktree, 'src/use.ts', "import text from './raw.test.js?raw';\n");
    commitIn(worktree, 'src/frag.test.ts', 'export const f = 1;\n');
    commitIn(worktree, 'src/other.ts', "export * from './frag.test.js#x';\n");
    commitIn(worktree, 'src/x#y/deep.test.ts', 'exports.d = 1;\n'.repeat(2));
    commitIn(worktree, 'src/req.ts', "module.exports = require('./x#y/deep.test.js');\n");

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '8 source + 0 test + 0 docs changed lines',
    });
  });

  // Resolved, the specifier would land on the decoy and the test file would
  // go unnamed.
  it('names a test file whatever sits at the literal path', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/big.test.ts', 'export const v = 1;\n'.repeat(5));
    commitIn(worktree, 'src/big.test.js', 'export {};\n');
    commitIn(worktree, 'src/use.ts', "export { v } from './big.test.js';\n");

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '7 source + 0 test + 0 docs changed lines',
    });
  });

  // A million tokens times 200 targets of one name held the merge lock for
  // minutes; the test timeout is the bound.
  it('weighs a name once per file however many tokens and targets share it', async () => {
    const worktree = seedSession(db, repo);
    for (let i = 0; i < 200; i++) {
      mkdirSync(join(worktree, `src/d${i}`), { recursive: true });
      writeFileSync(join(worktree, `src/d${i}/x.test.ts`), 'x\n');
    }
    commitIn(worktree, 'src/use.ts', `${'x.test '.repeat(1_000_000)}\n`);

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '201 source + 0 test + 0 docs changed lines',
    });
  });

  // `git grep` never reads a link's blob, so a manifest that is a link names
  // Docusaurus whatever it points at.
  it('counts Markdown under docs/ as source beside a package.json that is a symlink', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'docs/**', 'package.json'] });
    commitIn(worktree, 'src/deps.json', '{ "dependencies": { "@docusaurus/core": "3.0.0" } }\n');
    commitIn(worktree, 'docs/big.md', 'export const v = 1;\n'.repeat(5));
    commitIn(worktree, 'docs/notes.rst', 'prose\n'.repeat(2));
    symlinkSync('src/deps.json', join(worktree, 'package.json'));
    sh(worktree, 'git', 'add', '.');
    sh(worktree, 'git', 'commit', '-m', 'link the manifest');

    const outcome = await merge();

    expect(untimed(outcome.report.stages)).toContainEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '7 source + 0 test + 2 docs changed lines',
    });
  });

  it('throws for a session that is not awaiting review', async () => {
    seedSession(db, repo);
    transitionSession(db, SESSION_ID, 'running');

    await expect(merge()).rejects.toThrow(SessionNotReviewableError);
  });

  // Decision 88: the merge has landed by the teardown, so a worktree git will
  // not remove is kept and named rather than thrown past the ratchet.
  it('still ratchets when the post-merge worktree remove fails, and names the kept worktree', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    seedDebtBaseline({ deadExports: [], duplicatedLines: 9 });
    const adapter = debtAdapter({
      deadCode: () => [],
      duplication: () => ({ duplicatedLines: 5, blocks: [] }),
    });
    const real = vi.mocked(execFileSync).getMockImplementation();
    vi.mocked(execFileSync).mockImplementation(((file: string, args: string[], opts: object) => {
      if (file === 'git' && args.includes('worktree') && args.includes('remove')) {
        throw Object.assign(new Error('git worktree remove failed'), {
          stderr: 'fatal: cannot remove a locked working tree',
        });
      }
      return real?.(file, args, opts as never);
    }) as never);
    onTestFinished(() => {
      vi.mocked(execFileSync).mockImplementation(real as never);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => errors.mockRestore());

    const outcome = await merge(adapter);

    expect(outcome).toMatchObject({ status: 'merged', keptWorktree: worktree });
    const stored = JSON.parse(getProject(db, 'proj-1')?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt?.duplicatedLines).toBe(5);
    expect(existsSync(worktree)).toBe(true);
    // The branch stays with the worktree that has it checked out.
    expect(sh(repo, 'git', 'branch', '--list', BRANCH).trim()).not.toBe('');
    expect(errors.mock.calls.flat().join('\n')).toContain(
      `git worktree remove refused ${worktree}: fatal: cannot remove a locked working tree`,
    );
    expect(listEvents(db, SESSION_ID).some((event) => event.type === 'merge')).toBe(true);
  });

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

  describe('a stale branch an open PR holds (decision 105)', () => {
    const request = () => ({
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: [passingAdapter],
      openPr: true,
    });

    /** A gate that pushed the branch and died opening its PR: the PR stands open. */
    const pushedOnce = async (worktree: string): Promise<{ bare: string; pushed: string }> => {
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const bare = addOrigin();
      const ghDyingOnCreate = `${fakeGh([])}\nexit 1\n`;
      await expect(
        withFakeGh(ghDyingOnCreate, () => runMergeGate(db, request())),
      ).rejects.toThrow();
      return { bare, pushed: sh(bare, 'git', 'rev-parse', BRANCH).trim() };
    };

    const pushCalls = (): string[][] =>
      vi
        .mocked(execFileSync)
        .mock.calls.map(([, callArgs]) => (callArgs ?? []) as string[])
        .filter((callArgs) => callArgs.includes('push'));

    it('merges the target in, keeps every pushed commit, and pushes without force', async () => {
      const worktree = seedSession(db, repo);
      const { bare, pushed } = await pushedOnce(worktree);
      commitIn(repo, 'README.md', '# moved on\n');
      const targetSha = sh(repo, 'git', 'rev-parse', 'main').trim();
      vi.mocked(execFileSync).mockClear();

      const outcome = await withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request()));

      expect(outcome.status).toBe('merged');
      expect(outcome.prUrl).toBe(openPrOnMain.url);
      expect(outcome.report.stages).toContainEqual(
        expect.objectContaining({
          stage: 'fresh-base',
          status: 'pass',
          detail: 'auto-merged main',
        }),
      );
      const head = sh(bare, 'git', 'rev-parse', BRANCH).trim();
      expect(head).not.toBe(pushed);
      // Every commit the PR held is still on it, and the target came in as a merge.
      expect(sh(bare, 'git', 'rev-list', BRANCH)).toContain(pushed);
      expect(sh(bare, 'git', 'rev-list', '--parents', '-n', '1', BRANCH).trim().split(' ')).toEqual(
        [head, pushed, targetSha],
      );
      const pushes = pushCalls();
      expect(pushes).toHaveLength(1);
      expect(pushes[0]?.join(' ')).not.toMatch(/--force|\+[0-9a-f]{40}:/);
    });

    it("titles the adopted PR with the session's commit, never the merge the gate wrote", async () => {
      const worktree = seedSession(db, repo);
      await pushedOnce(worktree);
      commitIn(repo, 'README.md', '# moved on\n');

      const outcome = await withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request()));

      expect(outcome.status).toBe('merged');
      const edit = ghCalls()
        .filter((call) => call.startsWith('pr edit'))
        .at(-1);
      expect(edit).toContain('--title edit src/feature.ts --body-file');
      expect(edit).not.toContain('Merge main');
    });

    it('re-steers the session when the merge conflicts, leaving the PR as it was', async () => {
      const worktree = seedSession(db, repo);
      const { bare, pushed } = await pushedOnce(worktree);
      commitIn(repo, 'src/feature.ts', 'export const feature = 2;\n');
      vi.mocked(steerPane).mockClear();
      vi.mocked(execFileSync).mockClear();

      const outcome = await withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request()));

      expect(outcome.status).toBe('rejected');
      expect(outcome.rejectCount).toBe(1);
      expect(getSession(db, SESSION_ID)?.state).toBe('running');
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: 'fresh-base',
        status: 'fail',
        detail: expect.stringContaining('Auto-merge of main hit conflicts'),
      });
      // git's report a line each, as the worker reads it.
      expect(outcome.report.stages.at(-1)?.detail).toMatch(
        /^CONFLICT \(add\/add\): Merge conflict in src\/feature\.ts$/m,
      );
      const steer = vi.mocked(steerPane).mock.calls[0]?.[1];
      expect(steer).toContain('`git merge refs/heads/main`');
      expect(steer).not.toContain('rebase');
      // Aborted: the worktree is back on the pushed commit, with no merge in progress.
      expect(sh(worktree, 'git', 'rev-parse', 'HEAD').trim()).toBe(pushed);
      expect(sh(worktree, 'git', 'status', '--porcelain')).toBe('');
      expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
      expect(pushCalls()).toEqual([]);
    });

    it('refuses a branch the session rewrote past what the PR holds', async () => {
      const worktree = seedSession(db, repo);
      const { bare, pushed } = await pushedOnce(worktree);
      sh(worktree, 'git', 'commit', '--amend', '-m', 'rewritten');
      vi.mocked(steerPane).mockClear();

      const outcome = await withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request()));

      expect(outcome.status).toBe('rejected');
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: 'fresh-base',
        status: 'fail',
        detail: expect.stringContaining(`no longer contains ${pushed}`),
      });
      expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
    });

    // The porcelain `git merge` reads `branch.<name>.mergeOptions` from the
    // shared config after the `-c` pins: `-S` would run a `gpg.program` of the
    // session's outside the sandbox, `-F` would put any file it names in the
    // message pushed to the PR. Planted on the session's branch and on a branch
    // the worktree was switched to, since the porcelain reads HEAD's.
    it.each([
      ['-S', false],
      ['-S', true],
      ['-F', false],
      ['-F', true],
    ])('reads no %s from mergeOptions (worktree switched away: %s)', async (option, switched) => {
      const worktree = seedSession(db, repo);
      const { bare, pushed } = await pushedOnce(worktree);
      commitIn(repo, 'README.md', '# moved on\n');
      const plants = tempDir('pup-merge-options-');
      const marker = join(plants, 'gpg-ran');
      const secret = join(plants, 'secret');
      writeFileSync(secret, 'TOP-SECRET-CONTENTS\n');
      const gpg = join(plants, 'gpg');
      writeFileSync(gpg, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
      sh(repo, 'git', 'config', 'gpg.program', gpg);
      if (switched) sh(worktree, 'git', 'checkout', '-q', '-b', 'pup/elsewhere');
      for (const branch of [BRANCH, 'pup/elsewhere']) {
        sh(
          repo,
          'git',
          'config',
          `branch.${branch}.mergeOptions`,
          option === '-S' ? '-S' : `-F ${secret}`,
        );
      }

      const outcome = await withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request()));

      expect(outcome.status).toBe('merged');
      expect(existsSync(marker)).toBe(false);
      const message = sh(bare, 'git', 'log', '-1', '--format=%B', BRANCH);
      expect(message).not.toContain('TOP-SECRET');
      expect(message.trim()).toBe(`Merge main into ${BRANCH}`);
      expect(sh(bare, 'git', 'rev-list', BRANCH)).toContain(pushed);
    });

    it('brings the worktree on the branch to the merge, index and files', async () => {
      const worktree = seedSession(db, repo);
      await pushedOnce(worktree);
      commitIn(repo, 'README.md', '# moved on\n');
      // A failing build keeps the worktree, so what the merge left in it can be read.
      const outcome = await withFakeGh(fakeGh([openPrOnMain]), () =>
        runMergeGate(db, { ...request(), adapters: [failingBuildAdapter] }),
      );

      expect(outcome.status).toBe('rejected');
      expect(outcome.report.stages).toContainEqual(
        expect.objectContaining({
          stage: 'fresh-base',
          status: 'pass',
          detail: 'auto-merged main',
        }),
      );
      expect(sh(worktree, 'git', 'rev-parse', 'HEAD').trim()).toBe(
        sh(repo, 'git', 'rev-parse', BRANCH).trim(),
      );
      expect(sh(worktree, 'git', 'status', '--porcelain')).toBe('');
      expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('# moved on\n');
    });

    /** Run `act` once, right before the first git call whose argv `matches`. */
    const beforeGit = (matches: (args: string[]) => boolean, act: () => void): void => {
      const real = vi.mocked(execFileSync).getMockImplementation();
      let done = false;
      vi.mocked(execFileSync).mockImplementation(((file: string, args: string[], opts: object) => {
        if (!done && file === 'git' && matches(args)) {
          done = true;
          act();
        }
        return real?.(file, args, opts as never);
      }) as never);
      onTestFinished(() => {
        vi.mocked(execFileSync).mockImplementation(real as never);
      });
    };

    it('fails fresh-base when the branch moves under the compare-and-swap, pushing nothing', async () => {
      const worktree = seedSession(db, repo);
      const { bare, pushed } = await pushedOnce(worktree);
      commitIn(repo, 'README.md', '# moved on\n');
      const moved = sh(repo, 'git', 'rev-parse', `${pushed}~1`).trim();
      beforeGit(
        (args) => args.includes('update-ref') && args.includes('pup merge: merge main'),
        () => sh(repo, 'git', 'update-ref', `refs/heads/${BRANCH}`, moved),
      );
      vi.mocked(execFileSync).mockClear();

      const outcome = await withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request()));

      expect(outcome.status).toBe('rejected');
      expect(outcome.report.stages.at(-1)).toMatchObject({
        stage: 'fresh-base',
        status: 'fail',
        detail: expect.stringContaining(
          `${BRANCH} moved from ${pushed} while the gate merged main`,
        ),
      });
      expect(sh(repo, 'git', 'rev-parse', BRANCH).trim()).toBe(moved);
      expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
      expect(pushCalls()).toEqual([]);
    });

    it('merges the branch of a worktree with a detached HEAD and leaves the worktree alone', async () => {
      const worktree = seedSession(db, repo);
      const { pushed } = await pushedOnce(worktree);
      sh(worktree, 'git', 'checkout', '-q', '--detach');
      commitIn(repo, 'README.md', '# moved on\n');
      const targetSha = sh(repo, 'git', 'rev-parse', 'main').trim();

      // A failing build keeps the worktree, so what the merge left in it can be read.
      const outcome = await withFakeGh(fakeGh([openPrOnMain]), () =>
        runMergeGate(db, { ...request(), adapters: [failingBuildAdapter] }),
      );

      expect(outcome.status).toBe('rejected');
      expect(outcome.report.stages).toContainEqual(
        expect.objectContaining({
          stage: 'fresh-base',
          status: 'pass',
          detail: 'auto-merged main',
        }),
      );
      expect(sh(repo, 'git', 'rev-parse', `${BRANCH}^1`, `${BRANCH}^2`).trim().split('\n')).toEqual(
        [pushed, targetSha],
      );
      expect(sh(worktree, 'git', 'rev-parse', 'HEAD').trim()).toBe(pushed);
      expect(existsSync(join(worktree, 'README.md'))).toBe(false);
      expect(sh(worktree, 'git', 'status', '--porcelain')).toBe('');
    });

    /** A file of the session's, written after the worktree-clean stage, at a path main adds. */
    const untrackedInTheWay = (worktree: string): void =>
      beforeGit(
        (args) => args.includes('merge-tree'),
        () => {
          mkdirSync(join(worktree, 'dist'));
          writeFileSync(join(worktree, 'dist', 'app.js'), 'stale\n');
        },
      );

    // Left on the merge, the worktree's HEAD would sit over the pushed commit's
    // files and status would stage main's changes reversed for the next commit.
    it.each([
      [
        'an edit made after the worktree-clean stage',
        (worktree: string) =>
          beforeGit(
            (args) => args.includes('merge-tree'),
            () => writeFileSync(join(worktree, 'src/app.ts'), 'export const app = 3;\n'),
          ),
        'src/app.ts',
        ' M src/app.ts\n',
      ],
      ['a new file at a path main adds', untrackedInTheWay, 'dist/app.js', '?? dist/\n'],
    ])(
      'puts the branch back when %s refuses the merge, pushing nothing',
      async (_, block, path, status) => {
        const worktree = seedSession(db, repo);
        const { bare, pushed } = await pushedOnce(worktree);
        commitIn(repo, 'src/app.ts', 'export const app = 2;\n');
        commitIn(repo, 'dist/app.js', 'built\n');
        block(worktree);
        vi.mocked(execFileSync).mockClear();

        const outcome = await withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request()));

        expect(outcome.status).toBe('rejected');
        expect(outcome.report.stages.at(-1)).toMatchObject({
          stage: 'fresh-base',
          status: 'fail',
          detail: expect.stringContaining(
            `The merge of main failed in this worktree, and ${BRANCH} is back on ${pushed} ` +
              'without it.',
          ),
        });
        expect(outcome.report.stages.at(-1)?.detail).toContain(path);
        expect(sh(repo, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
        expect(sh(worktree, 'git', 'rev-parse', 'HEAD').trim()).toBe(pushed);
        expect(sh(worktree, 'git', 'status', '--porcelain')).toBe(status);
        expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
        expect(pushCalls()).toEqual([]);
      },
    );

    it("throws the undo's own failure when the branch cannot be put back", async () => {
      const worktree = seedSession(db, repo);
      const { pushed } = await pushedOnce(worktree);
      commitIn(repo, 'dist/app.js', 'built\n');
      untrackedInTheWay(worktree);
      const moved = sh(repo, 'git', 'rev-parse', `${pushed}~1`).trim();
      let merged = '';
      beforeGit(
        (args) => args.includes('pup merge: undo merge of main'),
        () => {
          merged = sh(repo, 'git', 'rev-parse', BRANCH).trim();
          sh(repo, 'git', 'update-ref', `refs/heads/${BRANCH}`, moved);
        },
      );
      vi.mocked(steerPane).mockClear();

      const failure = await withFakeGh(fakeGh([openPrOnMain]), () =>
        runMergeGate(db, request()),
      ).then(
        () => '',
        (error: unknown) => (error as Error).message,
      );

      expect(failure).toContain(`putting ${BRANCH} back from the merge ${merged} on ${pushed}`);
      expect(failure).toContain(`but expected ${merged}`);
      expect(failure).toContain('dist/app.js');
      expect(vi.mocked(steerPane)).not.toHaveBeenCalled();
      expect(sh(repo, 'git', 'rev-parse', BRANCH).trim()).toBe(moved);
    });

    // A Ctrl-C reaches the read-tree as well as node, and the interrupt unwinds
    // the gate only once the branch is back.
    it('puts the branch back before rethrowing a read-tree an interrupt killed', async () => {
      const worktree = seedSession(db, repo);
      const { bare, pushed } = await pushedOnce(worktree);
      commitIn(repo, 'README.md', '# moved on\n');
      beforeGit(
        (args) => args.includes('read-tree') && args.includes('-m'),
        () => {
          throw Object.assign(new Error('Command failed: git read-tree'), {
            signal: 'SIGINT',
            status: null,
          });
        },
      );
      vi.mocked(steerPane).mockClear();
      vi.mocked(execFileSync).mockClear();

      await expect(
        withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request())),
      ).rejects.toThrow('Command failed: git read-tree');
      expect(vi.mocked(steerPane)).not.toHaveBeenCalled();
      expect(sh(repo, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
      expect(sh(worktree, 'git', 'status', '--porcelain')).toBe('');
      expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
      expect(pushCalls()).toEqual([]);
    });

    // A session can hang only the pinned worktree git (an `includeIf` path at a
    // FIFO), so the operator's Ctrl-C lands on the HEAD read: it must come
    // before the branch moves.
    it('leaves the branch where it was when an interrupt kills the worktree HEAD read', async () => {
      const worktree = seedSession(db, repo);
      const { bare, pushed } = await pushedOnce(worktree);
      commitIn(repo, 'README.md', '# moved on\n');
      beforeGit(
        (args) => args.includes('symbolic-ref') && args.includes(worktree),
        () => {
          throw Object.assign(new Error('Command failed: git symbolic-ref'), {
            signal: 'SIGINT',
            status: null,
          });
        },
      );
      vi.mocked(steerPane).mockClear();
      vi.mocked(execFileSync).mockClear();

      await expect(
        withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request())),
      ).rejects.toThrow('Command failed: git symbolic-ref');
      expect(vi.mocked(steerPane)).not.toHaveBeenCalled();
      expect(sh(repo, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
      expect(sh(worktree, 'git', 'status', '--porcelain')).toBe('');
      expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
      expect(pushCalls()).toEqual([]);
    });

    /** A driver of the session's, armed in the shared config right before the git call `at` matches. */
    const armBefore = (at: (args: string[]) => boolean, key: string, attribute: string): string => {
      const marker = join(tempDir('pup-armed-'), 'ran');
      beforeGit(at, () => {
        sh(repo, 'git', 'config', key, `touch '${marker}'; cat`);
        mkdirSync(join(repo, '.git', 'info'), { recursive: true });
        writeFileSync(join(repo, '.git', 'info', 'attributes'), `* ${attribute}\n`);
      });
      return marker;
    };

    const ran = (command: string): boolean =>
      vi
        .mocked(execFileSync)
        .mock.calls.some(([, callArgs]) => ((callArgs ?? []) as string[]).includes(command));

    // The check before the lock is minutes old by then: a live session can arm
    // a driver while the gh calls and the lock wait run.
    it('refuses a merge driver armed after the first check, before merge-tree can run it', async () => {
      const worktree = seedSession(db, repo);
      const { bare, pushed } = await pushedOnce(worktree);
      // Both sides changed the file, which merge-tree would hand the driver.
      commitIn(repo, 'src/feature.ts', 'export const feature = 2;\n');
      // The worktree-clean stage's status, the gate's first git under the lock.
      const marker = armBefore((args) => args.includes('status'), 'merge.pwn.driver', 'merge=pwn');
      vi.mocked(steerPane).mockClear();
      vi.mocked(execFileSync).mockClear();

      await expect(
        withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request())),
      ).rejects.toThrow(ArmedGitDriverError);
      expect(ran('status')).toBe(true);
      expect(ran('merge-tree')).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(vi.mocked(steerPane)).not.toHaveBeenCalled();
      expect(sh(repo, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
      expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
    });

    it('refuses a smudge filter armed after merge-tree, putting the branch back', async () => {
      const worktree = seedSession(db, repo);
      const { bare, pushed } = await pushedOnce(worktree);
      commitIn(repo, 'README.md', '# moved on\n');
      const marker = armBefore(
        (args) => args.includes('commit-tree'),
        'filter.pwn.smudge',
        'filter=pwn',
      );
      vi.mocked(steerPane).mockClear();
      vi.mocked(execFileSync).mockClear();

      await expect(
        withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request())),
      ).rejects.toThrow(ArmedGitDriverError);
      expect(ran('commit-tree')).toBe(true);
      expect(ran('read-tree')).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(vi.mocked(steerPane)).not.toHaveBeenCalled();
      expect(sh(repo, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
      expect(sh(worktree, 'git', 'rev-parse', 'HEAD').trim()).toBe(pushed);
      expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
    });

    // A session can move the lock away while the gate runs: the run refuses
    // before it moves the branch, as before every ref it moves (decision 88).
    it('refuses to merge the target in once its lock was moved away, moving nothing', async () => {
      const worktree = seedSession(db, repo);
      const { bare, pushed } = await pushedOnce(worktree);
      commitIn(repo, 'README.md', '# moved on\n');
      const lock = join(repo, '.git', 'pup-merge.lock');
      beforeGit(
        (args) => args.includes('commit-tree'),
        () => renameSync(lock, `${lock}.moved`),
      );
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      onTestFinished(() => errors.mockRestore());
      vi.mocked(steerPane).mockClear();
      vi.mocked(execFileSync).mockClear();

      await expect(
        withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request())),
      ).rejects.toThrow(`the merge of main into ${BRANCH} was refused`);
      expect(vi.mocked(steerPane)).not.toHaveBeenCalled();
      expect(sh(repo, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
      expect(sh(worktree, 'git', 'rev-parse', 'HEAD').trim()).toBe(pushed);
      expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
      expect(pushCalls()).toEqual([]);
    });

    // Only exit 1 is a conflict: git with no `--write-tree` (before 2.38) dies
    // with 128 on every merge, which no re-steer can fix.
    it('throws to the operator when merge-tree fails other than on a conflict', async () => {
      const worktree = seedSession(db, repo);
      const { bare, pushed } = await pushedOnce(worktree);
      commitIn(repo, 'README.md', '# moved on\n');
      beforeGit(
        (args) => args.includes('merge-tree'),
        () => {
          throw Object.assign(new Error('fatal: Not a valid object name --write-tree'), {
            status: 128,
          });
        },
      );
      vi.mocked(steerPane).mockClear();
      vi.mocked(execFileSync).mockClear();

      await expect(
        withFakeGh(fakeGh([openPrOnMain]), () => runMergeGate(db, request())),
      ).rejects.toThrow('Not a valid object name --write-tree');
      expect(vi.mocked(steerPane)).not.toHaveBeenCalled();
      expect(sh(repo, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
      expect(sh(bare, 'git', 'rev-parse', BRANCH).trim()).toBe(pushed);
      expect(pushCalls()).toEqual([]);
    });

    it('still rebases a stale branch never pushed, opening its PR on linear history', async () => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      const bare = addOrigin();
      commitIn(repo, 'README.md', '# moved on\n');
      const targetSha = sh(repo, 'git', 'rev-parse', 'main').trim();

      const outcome = await withFakeGh(fakeGh([]), () => runMergeGate(db, request()));

      expect(outcome.status).toBe('merged');
      expect(outcome.prWasAdopted).toBe(false);
      expect(outcome.report.stages).toContainEqual(
        expect.objectContaining({ stage: 'fresh-base', detail: 'auto-rebased onto main' }),
      );
      expect(sh(bare, 'git', 'rev-list', '--merges', BRANCH).trim()).toBe('');
      expect(sh(bare, 'git', 'rev-parse', `${BRANCH}~1`).trim()).toBe(targetSha);
    });
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
