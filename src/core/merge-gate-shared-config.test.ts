import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

// The real spawn every gate stage runs through, so a test can count them, and
// the real execFileSync every git call runs through, so one can read its argv.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    spawn: vi.fn(actual.spawn),
  };
});

// Set by the tests of a session racing the gate: it clears the key right
// before each of the gate's checks (of the shared config's key and of
// per-worktree config) and sets it again right after, so every git call after
// the first check finds it armed.
const keyRace = vi.hoisted(() => ({
  around: undefined as (<T>(name: string, check: () => T) => T) | undefined,
}));
vi.mock('./git-diff.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-diff.client.js')>();
  const raced =
    <A extends unknown[], T>(name: string, check: (...args: A) => T) =>
    (...args: A): T =>
      keyRace.around ? keyRace.around(name, () => check(...args)) : check(...args);
  return {
    ...actual,
    assertNoSharedWorktreeKey: raced('key', actual.assertNoSharedWorktreeKey),
    assertNoWorktreeConfig: raced('per-worktree', actual.assertNoWorktreeConfig),
    verifiedWorktreeGitEnv: raced('session-worktree', actual.verifiedWorktreeGitEnv),
  };
});

import {
  BRANCH,
  commitIn,
  debtAdapter,
  passingAdapter,
  SESSION_ID,
  seedSession,
  sh,
  untimed,
} from '@test/helpers/merge-gate.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { nestedPackageDirs } from '../adapters/git-tree.client.js';
import type { Adapter, CapabilityContext } from '../adapters/types/adapter.types.js';
import { openStore } from './db.client.js';
import { SharedWorktreeKeyError, WorktreeConfigError } from './git-diff.client.js';
import { listLedgerEntries } from './ledger.repository.js';
import { DUPLICATION_RULE_ID } from './merge-gate.constants.js';
import { runMergeGate } from './merge-gate.service.js';
import { projectId } from './paths.utils.js';
import { TOOLCHAIN_CACHE_DIRNAME } from './sandbox.utils.js';
import { getSession, saveProjectBaseline, saveProjectOriginUrl } from './session.repository.js';
import { HELD_SLOT_ENV } from './test-slot.service.js';
import type { DebtBaseline } from './types/init.types.js';

/**
 * Git takes `core.worktree` from the main checkout's own `.git/config`, which a
 * session can write and no diff shows, before any `-c` of pup's applies. Aimed
 * at the checkout's parent, it has every git run in the checkout from the
 * subdirectory `repo/`: a plain `ls-tree` lists nothing, a pathspec matches
 * nothing, and with `diff.relative` every diff lists nothing, so each stage
 * would measure an empty branch. The gate refuses the key before any stage
 * runs; and for a session that sets it after the last check, every listing a
 * stage reads is anchored at the root.
 */
describe('the merge gate under a shared-config core.worktree and diff.relative', {
  timeout: 20_000,
}, () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    // Inside a parent of its own, which the key aims at.
    const host = tempDir('pup-shared-key-');
    repo = join(host, 'repo');
    mkdirSync(repo);
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
    // As inside a slot already held, so a gate here never queues behind the
    // machine's real test runs (decision 96).
    vi.stubEnv(HELD_SLOT_ENV, 'merge-gate-shared-config.test');
  });

  afterEach(() => {
    keyRace.around = undefined;
    vi.unstubAllEnvs();
  });

  const arm = () => {
    sh(repo, 'git', 'config', 'core.worktree', dirname(repo));
    sh(repo, 'git', 'config', 'diff.relative', 'true');
  };

  /**
   * The same keys through per-worktree config the session turns on, which
   * `.git/config` holds no `core.worktree` for. Written from outside the repo:
   * once armed, git run inside it is shifted.
   */
  const armPerWorktree = () => {
    const config = join(repo, '.git', 'config');
    const perWorktree = join(repo, '.git', 'config.worktree');
    sh('/', 'git', 'config', '--file', config, 'extensions.worktreeConfig', 'true');
    sh('/', 'git', 'config', '--file', perWorktree, 'core.worktree', dirname(repo));
    sh('/', 'git', 'config', '--file', perWorktree, 'diff.relative', 'true');
  };

  const disarm = () => {
    const config = join(repo, '.git', 'config');
    for (const key of ['core.worktree', 'diff.relative', 'extensions.worktreeConfig']) {
      try {
        sh('/', 'git', 'config', '--file', config, '--unset-all', key);
      } catch {
        // not set
      }
    }
    rmSync(join(repo, '.git', 'config.worktree'), { force: true });
  };

  /**
   * The session racing the checks `races` picks, by name and by how many of
   * that name ran before: clear before each, set again after it. A check it
   * does not pick finds the keys set.
   */
  const raceTheChecks = (
    armWith = arm,
    races: (name: string, nth: number) => boolean = () => true,
  ) => {
    const seen = new Map<string, number>();
    keyRace.around = <T>(name: string, check: () => T): T => {
      const nth = seen.get(name) ?? 0;
      seen.set(name, nth + 1);
      if (!races(name, nth)) return check();
      disarm();
      try {
        return check();
      } finally {
        armWith();
      }
    };
  };

  const merge = (
    adapter: Adapter = passingAdapter,
    acceptDebt?: { reason: string; reviewBy: string },
  ) =>
    runMergeGate(db, {
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: [adapter],
      acceptDebt: acceptDebt && { acceptedBy: 'human', ...acceptDebt },
    });

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

  const stage = (outcome: Awaited<ReturnType<typeof merge>>, name: string) =>
    untimed(outcome.report.stages).find((s) => s.stage === name);

  // The control: armed, a plain git in the checkout lists none of the branch.
  it('is a key that empties a plain diff and ls-tree of the branch', () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    arm();

    expect(sh(repo, 'git', 'diff', '--name-only', 'main...pup/s1')).toBe('');
    expect(sh(repo, 'git', 'ls-tree', '-r', '--name-only', 'pup/s1')).toBe('');
  });

  // The branch is stale, so a fresh-base stage that ran would rebase it.
  it('refuses the key before any stage runs, leaving the session reviewable', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    commitIn(repo, 'src/later.ts', 'export const later = 1;\n');
    const tip = sh(repo, 'git', 'rev-parse', 'pup/s1');
    arm();

    await expect(merge()).rejects.toThrow(SharedWorktreeKeyError);
    await expect(merge()).rejects.toThrow(
      `core.worktree is set in ${join(repo, '.git', 'config')}`,
    );
    expect(sh(repo, 'git', 'rev-parse', 'pup/s1')).toBe(tip);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(getSession(db, SESSION_ID)).toMatchObject({ state: 'awaiting-review', reject_count: 0 });
  });

  // Empty, the key stops every git in the repo, the driver check's included.
  it('refuses an empty key by name, not with the git error it causes', async () => {
    seedSession(db, repo);
    sh(repo, 'git', 'config', 'core.worktree', '');

    await expect(merge()).rejects.toThrow(SharedWorktreeKeyError);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  // Per-worktree config can carry the key too, and a live session can turn it
  // on long after its launch was asked.
  it('refuses per-worktree config before any stage runs', async () => {
    seedSession(db, repo);
    sh(repo, 'git', 'config', 'extensions.worktreeConfig', 'true');

    await expect(merge()).rejects.toThrow(WorktreeConfigError);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  // Turned on after `planMerge`'s checks, per-worktree config carries the key
  // past a check of `.git/config` alone: the cut under the lock asks both,
  // before it adds the gate's checkout.
  it('refuses per-worktree config turned on after the plan, before any stage runs', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    raceTheChecks(armPerWorktree, (name, nth) => name !== 'per-worktree' || nth === 0);

    await expect(merge()).rejects.toThrow(WorktreeConfigError);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  // The listing each stage below reads, with the key set after the last check.
  it('audits the scope of every changed path', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    commitIn(worktree, 'notes.txt', 'off-scope\n');
    raceTheChecks();

    const outcome = await merge();

    expect(stage(outcome, 'scope-audit')).toEqual({
      stage: 'scope-audit',
      status: 'fail',
      detail: 'Out-of-scope changes:\n  notes.txt (outside scope-in)',
    });
  });

  // Each line here comes from a read the key would shift: the numstat, the
  // grep for an importer of a test file, the tree's links, and the grep of a
  // dependency file naming Docusaurus, which makes Markdown under docs/ code.
  it('sizes the diff over every changed path, reading the whole tree', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'docs/**', 'package.json'] });
    commitIn(worktree, 'src/helper.test.ts', 'export const h = 1;\n'.repeat(3));
    commitIn(worktree, 'src/use.ts', "export * from './helper.test.js';\n");
    commitIn(worktree, 'src/real.test.ts', 'const r = 1;\n'.repeat(2));
    symlinkSync('real.test.ts', join(worktree, 'src', 'alias.ts'));
    sh(worktree, 'git', 'add', '.');
    sh(worktree, 'git', 'commit', '-m', 'link');
    commitIn(worktree, 'package.json', '{ "devDependencies": { "@docusaurus/core": "3" } }\n');
    commitIn(worktree, 'docs/guide.md', 'A line of prose.\n'.repeat(2));
    raceTheChecks();

    const outcome = await merge();

    expect(stage(outcome, 'diff-size')).toEqual({
      stage: 'diff-size',
      status: 'pass',
      detail: '10 source + 0 test + 0 docs changed lines',
    });
  });

  it('flags dead code in a checkout holding every committed file', async () => {
    const worktree = seedSession(db, repo, { scopeIn: ['src/**', 'lib.ts'] });
    commitIn(worktree, 'lib.ts', 'export const lib = 1;\n');
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    seedDebtBaseline({ deadExports: [], duplicatedLines: 0 });
    raceTheChecks();
    const adapter = debtAdapter({
      deadCode: ({ measurePath }: CapabilityContext) =>
        ['lib.ts', 'src/feature.ts']
          .filter((file) => existsSync(join(measurePath, file)))
          .map((file) => ({ file, exportName: 'unused' })),
    });

    const outcome = await merge(adapter);

    expect(stage(outcome, 'dead-code')).toMatchObject({
      status: 'flagged',
      detail: expect.stringContaining(
        '2 new unused export(s): lib.ts#unused, src/feature.ts#unused',
      ),
    });
  });

  // The ledger entry names the changed files a duplicated block touches; with
  // no changed path seen it would name none.
  it('files a duplication flag against the changed files its blocks touch', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    seedDebtBaseline({ deadExports: [], duplicatedLines: 0 });
    raceTheChecks();
    const adapter = debtAdapter({
      duplication: () => ({
        duplicatedLines: 8,
        blocks: [
          {
            locations: [
              { file: 'src/app.ts', line: 1 },
              { file: 'src/feature.ts', line: 1 },
            ],
          },
        ],
      }),
    });

    const outcome = await merge(adapter, { reason: 'deadline', reviewBy: 'before v2' });

    expect(stage(outcome, 'duplication')).toMatchObject({ status: 'flagged' });
    const [entry] = listLedgerEntries(db, 'proj-1');
    expect(JSON.parse(entry?.files ?? '[]')).toEqual(['src/feature.ts']);
  });

  // The capability is asked about every changed path, and a rename is judged
  // against its source (decision 145), both read from the branch diff.
  it('judges complexity over every changed path, a rename against its source', async () => {
    const plain = Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};\n`).join('');
    commitIn(repo, 'src/legacy.ts', plain + 'if (a) b();\n'.repeat(10));
    const worktree = seedSession(db, repo);
    sh(worktree, 'git', 'mv', 'src/legacy.ts', 'src/renamed.ts');
    commitIn(worktree, 'src/renamed.ts', plain + 'if (a) b();\n'.repeat(50));
    raceTheChecks();
    const adapter = debtAdapter({
      complexity: ({ measurePath }: CapabilityContext, files: string[]) =>
        files
          .filter((file) => existsSync(join(measurePath, file)))
          .map((file) => ({
            file,
            complexity: readFileSync(join(measurePath, file), 'utf8').split('if (').length - 1,
          })),
    });

    const outcome = await merge(adapter);

    expect(stage(outcome, 'complexity')?.detail).toContain(
      'complexity rose sharply in 1 touched file(s): src/renamed.ts (+40)',
    );
  });

  // A file the target holds is judged by its rise, not as new (decision 157):
  // an unanchored `ls-tree` of the target would list nothing under `repo/`.
  it('reads the target tree whole, judging an existing file by its rise', async () => {
    commitIn(repo, 'src/kept.ts', 'export const kept = 1;\n');
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/kept.ts', 'if (a) b();\n'.repeat(20));
    raceTheChecks();
    const adapter = debtAdapter({
      complexity: ({ measurePath }: CapabilityContext, files: string[]) =>
        measurePath === repo ? [] : files.map((file) => ({ file, complexity: 20 })),
    });

    const outcome = await merge(adapter);

    expect(stage(outcome, 'complexity')?.detail).toContain(
      'complexity rose sharply in 1 touched file(s): src/kept.ts (+20).',
    );
  });

  // Patch coverage reads each changed file's hunks by a pathspec, which the
  // key would look up under `repo/` and find none: "no instrumentable lines".
  it('measures patch coverage over the hunks of every changed path', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const a = 1;\nexport const b = 2;\n');
    seedDebtBaseline({ deadExports: [], duplicatedLines: 0, coverageRatio: 0.8 });
    raceTheChecks();
    const adapter = debtAdapter({
      coverableFiles: (_ctx: CapabilityContext, files: string[]) =>
        files.filter((file) => file.endsWith('.ts')),
      coverage: () => ({
        files: { 'src/feature.ts': { covered: [1], instrumented: [1, 2] } },
      }),
    });

    const outcome = await merge(adapter);

    expect(stage(outcome, 'coverage')?.detail).toContain('50%');
  });

  // A change to listed paths alone skips the test stage unless the branch's
  // tree holds one in another case (decision 139). The tree's spellings come
  // from an `ls-tree` in the main checkout, after the build stage: unanchored,
  // it lists nothing under `repo/`, so no path folds onto another.
  it('runs the test stage when the tree holds the changed path in another case', async () => {
    commitIn(repo, 'docs/x.MD', '# x\n');
    const worktree = seedSession(db, repo, { scopeIn: ['**'] });
    // Through the index, since a case-folding disk would overwrite x.MD; the
    // same bytes keep the folded working tree clean.
    writeFileSync(join(worktree, 'docs', 'x.md'), '# x\n');
    const blob = sh(worktree, 'git', 'hash-object', '-w', '--', 'docs/x.md').trim();
    sh(worktree, 'git', 'update-index', '--add', '--cacheinfo', `100644,${blob},docs/x.md`);
    sh(worktree, 'git', 'commit', '-m', 'add docs/x.md');
    raceTheChecks();
    const adapter = debtAdapter({
      gateCommands: () => [
        { stage: 'build', command: 'true', args: [] },
        { stage: 'test', command: 'false', args: [] },
        { stage: 'lint', command: 'true', args: [] },
      ],
    });

    const outcome = await merge(adapter);

    expect(stage(outcome, 'test')?.status).toBe('fail');
  });

  // The trusted listing of nested packages fails while the session holds
  // `.git/config` broken, which it mends before the gate's last check: an empty
  // trusted set would run no nested package's own stages, so the gate refuses.
  it('refuses when the trusted listing of nested packages fails, running no stage', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    const config = join(repo, '.git', 'config');
    const adapter = debtAdapter({
      touchedNestedPackages: (ctx: CapabilityContext) => {
        const kept = readFileSync(config, 'utf8');
        writeFileSync(config, '[core\n');
        try {
          nestedPackageDirs(ctx);
          return [];
        } finally {
          writeFileSync(config, kept);
        }
      },
    });

    await expect(merge(adapter)).rejects.toThrow();
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
  });

  /** A stage that sets the key while it runs, after every check before the stages. */
  const armingAdapter = (armWith: () => void): Adapter =>
    debtAdapter({
      deadCode: () => {
        armWith();
        return [];
      },
    });

  // The key in `.git/config`, or through per-worktree config the session turns
  // on, which `.git/config` holds no `core.worktree` for.
  const ROUTES = [
    { route: 'the shared config', armWith: () => arm(), refusal: SharedWorktreeKeyError },
    {
      route: 'per-worktree config',
      armWith: () => armPerWorktree(),
      refusal: WorktreeConfigError,
    },
  ];

  it.each(ROUTES)(
    'refuses the fast-forward when a stage set the key in $route, merging nothing',
    async ({ armWith, refusal }) => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      seedDebtBaseline({ deadExports: [], duplicatedLines: 0 });
      const mainTip = sh(repo, 'git', 'rev-parse', 'main');

      await expect(merge(armingAdapter(armWith))).rejects.toThrow(refusal);

      expect(sh(repo, 'git', 'rev-parse', 'main')).toBe(mainTip);
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    },
  );

  it.each(ROUTES)(
    'refuses the PR push when a stage set the key in $route, pushing nothing',
    async ({ armWith, refusal }) => {
      const worktree = seedSession(db, repo);
      commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      seedDebtBaseline({ deadExports: [], duplicatedLines: 0 });
      // Origin is GitHub-shaped so the --repo pin can be derived, and rewritten
      // by the operator's global config onto a local bare repo (decision 56).
      const host = tempDir('pup-origin-');
      const bare = join(host, 'owner', 'repo.git');
      mkdirSync(bare, { recursive: true });
      sh(bare, 'git', 'init', '--bare', '-b', 'main');
      const originUrl = 'git@github.com:owner/repo.git';
      sh(repo, 'git', 'remote', 'add', 'origin', originUrl);
      saveProjectOriginUrl(db, 'proj-1', originUrl);
      const globalConfig = join(host, 'gitconfig');
      writeFileSync(globalConfig, `[url "${host}/"]\n\tinsteadOf = git@github.com:\n`);
      vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
      // A gh that knows no open PR and answers nothing else.
      const ghDir = tempDir('pup-gh-');
      writeFileSync(
        join(ghDir, 'gh'),
        [
          '#!/bin/sh',
          '[ "$1" = "--version" ] && exit 0',
          `if [ "$2" = "list" ]; then echo '[]'; exit 0; fi`,
          'echo "gh $* was not expected" >&2; exit 1',
        ].join('\n'),
        { mode: 0o755 },
      );
      vi.stubEnv('PATH', `${ghDir}:${process.env.PATH}`);

      await expect(
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [armingAdapter(armWith)],
          openPr: true,
        }),
      ).rejects.toThrow(refusal);

      expect(sh(bare, 'git', 'for-each-ref', `refs/heads/${BRANCH}`)).toBe('');
      expect(getSession(db, SESSION_ID)?.state).toBe('awaiting-review');
    },
  );

  // Under git's default rename detection `--name-only` lists a rename's new
  // path alone, and the deletion of an out-of-scope file passed the audit.
  it('audits the out-of-scope source of a file renamed into scope', async () => {
    commitIn(repo, 'notes/secret.ts', 'export const secret = 1;\n'.repeat(4));
    const worktree = seedSession(db, repo);
    mkdirSync(join(worktree, 'src'), { recursive: true });
    sh(worktree, 'git', 'mv', 'notes/secret.ts', 'src/secret.ts');
    sh(worktree, 'git', 'commit', '-m', 'move into scope');

    const outcome = await merge();

    expect(stage(outcome, 'scope-audit')).toEqual({
      stage: 'scope-audit',
      status: 'fail',
      detail: 'Out-of-scope changes:\n  notes/secret.ts (outside scope-in)',
    });
  });

  // `diff.relative=false` in GIT_SAFE_CONFIG would hide a diff that dropped the
  // flag, so each gate diff's argv is read: the flag must hold on its own.
  it('passes --no-relative to every diff the gate runs', async () => {
    const worktree = seedSession(db, repo);
    commitIn(worktree, 'src/feature.ts', 'export const a = 1;\nexport const b = 2;\n');
    seedDebtBaseline({ deadExports: [], duplicatedLines: 0, coverageRatio: 0.8 });
    const adapter = debtAdapter({
      complexity: () => [],
      coverableFiles: (_ctx: CapabilityContext, files: string[]) => files,
      coverage: () => ({
        files: { 'src/feature.ts': { covered: [1], instrumented: [1, 2] } },
      }),
    });

    await merge(adapter);

    const diffs = vi
      .mocked(execFileSync)
      .mock.calls.filter(([file, args]) => file === 'git' && (args as string[]).includes('diff'))
      .map(([, args]) => args as string[]);
    // The scope audit's listing, the numstat, the raw pairing and a file's hunks.
    for (const shape of ['--name-only', '--numstat', '--raw', '-U0']) {
      expect(diffs.some((args) => args.includes(shape))).toBe(true);
    }
    expect(diffs.filter((args) => !args.includes('--no-relative'))).toEqual([]);
  });
});
