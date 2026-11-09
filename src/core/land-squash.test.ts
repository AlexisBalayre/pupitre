import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endSandboxRun } from './sandbox.utils.js';

vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  steerPane: vi.fn(),
}));
// The real diff, so a test can fail one call of it and no other.
vi.mock('./git-diff.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-diff.client.js')>();
  return { ...actual, gitDiffPaths: vi.fn(actual.gitDiffPaths) };
});
// The real scratch git dir, so a test can fail one git call made in it.
vi.mock('./merge-gate.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./merge-gate.service.js')>();
  return { ...actual, withScratchGitDir: vi.fn(actual.withScratchGitDir) };
});
// The real audit, so a test can make the one after a land throw.
vi.mock('./audit.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./audit.service.js')>();
  return { ...actual, auditProject: vi.fn(actual.auditProject) };
});

import { BRANCH, commitIn, ORIGIN_URL, PR_URL, SESSION_ID, sh } from '@test/helpers/land.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { auditProject } from './audit.service.js';
import { openStore } from './db.client.js';
import { landSession } from './land.service.js';
import { withScratchGitDir } from './merge-gate.service.js';
import { projectId } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  getProject,
  insertSession,
  insertTask,
  listEvents,
  saveProjectOriginUrl,
  transitionSession,
} from './session.repository.js';

// Real git repos, a bare origin and a sandboxed audit per test.
// The gate children this file runs outside a gate start a sandbox run the
// gate would have ended, and a test worker exits without the `exit` event
// that ends it otherwise (decision 100).
afterAll(() => {
  endSandboxRun();
});

const passingAdapter: Adapter = {
  id: 'fake',
  detect: () => true,
  gateCommands: () => [
    { stage: 'build', command: 'true', args: [] },
    { stage: 'test', command: 'true', args: [] },
    { stage: 'lint', command: 'true', args: [] },
  ],
};

describe('landSession', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;
  let origin: string;
  let worktree: string;
  /** The commit the gate pinned and pushed: the branch tip. */
  let pinned: string;
  let ghLog: string;
  let originalPath: string | undefined;
  /** The audit stores the baseline under the id the repo path gives. */
  let pid: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = tempDir('pup-land-repo-');
    sh(repo, 'git', 'init', '-q', '-b', 'main');
    commitIn(repo, 'src/app.ts', 'export const app = 1;\n');
    // GitHub-shaped origin, rewritten by the operator's global config into a
    // local bare repo so the land's real fetch stays offline.
    const host = tempDir('pup-land-origin-');
    origin = join(host, 'owner', 'repo.git');
    mkdirSync(origin, { recursive: true });
    sh(origin, 'git', 'init', '-q', '--bare', '-b', 'main');
    sh(repo, 'git', 'remote', 'add', 'origin', ORIGIN_URL);
    sh(repo, 'git', 'push', '-q', origin, 'main');
    const globalConfig = join(host, 'gitconfig');
    writeFileSync(globalConfig, `[url "${host}/"]\n\tinsteadOf = git@github.com:\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);

    pid = projectId(repo);
    ensureProject(db, pid, repo);
    saveProjectOriginUrl(db, pid, ORIGIN_URL);
    insertTask(db, { id: 'task-s1', projectId: pid, spec: '{}' });
    worktree = join(repo, '.worktrees', SESSION_ID);
    sh(repo, 'git', 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'HEAD');
    pinned = commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    sh(repo, 'git', 'push', '-q', origin, BRANCH);
    insertSession(db, {
      id: SESSION_ID,
      taskId: 'task-s1',
      worktreePath: worktree,
      branch: BRANCH,
      profileHash: 'hash',
    });
    transitionSession(db, SESSION_ID, 'running');
    transitionSession(db, SESSION_ID, 'awaiting-review');

    ghLog = join(host, 'gh-calls');
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.unstubAllEnvs();
  });

  /** What the gate's `--pr` merge leaves: the session merged, its PR on the event. */
  function seedPrMerge(prUrl: string | null = PR_URL): void {
    transitionSession(db, SESSION_ID, 'merged');
    appendEvent(db, SESSION_ID, 'merge', {
      branch: BRANCH,
      sha: pinned,
      target: 'main',
      files: ['src/feature.ts'],
      ...(prUrl === null ? {} : { prUrl }),
    });
  }

  /** GitHub's merge button: a merge commit of origin's main and `head` on origin's main. */
  function mergeOnGitHub(head = pinned): string {
    const base = sh(origin, 'git', 'rev-parse', 'main');
    const merge = sh(
      origin,
      'git',
      '-c',
      'user.email=gh@test',
      '-c',
      'user.name=github',
      'commit-tree',
      `${head}^{tree}`,
      '-p',
      base,
      '-p',
      head,
      '-m',
      'Merge pull request #7',
    );
    sh(origin, 'git', 'update-ref', 'refs/heads/main', merge);
    return merge;
  }

  /** A gh on PATH that records its argv and answers `pr view` with this JSON. */
  function fakeGh(answer: unknown): void {
    const dir = tempDir('pup-land-gh-');
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${ghLog}\necho '${JSON.stringify(answer)}'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${originalPath}`;
  }

  const land = () =>
    landSession(db, { repoPath: repo, sessionId: SESSION_ID, adapters: [passingAdapter] });
  const mainSha = () => sh(repo, 'git', 'rev-parse', 'main');
  const hasTrackingRef = () => sh(repo, 'git', 'for-each-ref', 'refs/remotes/origin/main') !== '';
  const landedEvents = () => listEvents(db, SESSION_ID).filter((row) => row.type === 'landed');

  /** Nothing a refusal may touch moved. */
  function expectNothingChanged(mainBefore: string): void {
    expect(mainSha()).toBe(mainBefore);
    expect(existsSync(worktree)).toBe(true);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH)).not.toBe('');
    expect(landedEvents()).toEqual([]);
    expect(getProject(db, pid)?.baseline).toBeNull();
  }

  /** The refusal of a merge commit whose tree is not the pinned content merged onto its base. */
  const refusal = (merge: string) =>
    `${merge}, the commit GitHub says merged ${PR_URL}, does not have the tree git gives ` +
    `merging ${pinned}, the commit the gate pinned`;

  /** A clone of origin, where GitHub's side of a squash or rebase merge is made. */
  function cloneOrigin(): string {
    const clone = tempDir('pup-land-clone-');
    sh(clone, 'git', 'clone', '-q', origin, '.');
    return clone;
  }

  /** Another PR merged first: origin's main moves past the base the gate rebased onto. */
  function moveOriginMain(clone: string): string {
    const moved = commitIn(clone, 'src/other.ts', 'export const other = 1;\n');
    sh(clone, 'git', 'push', '-q', 'origin', 'HEAD:main');
    return moved;
  }

  /** GitHub's squash button onto origin's main, `edit` run on the squash before its commit. */
  function squashOnGitHub(clone: string, edit: () => void = () => undefined): string {
    sh(clone, 'git', 'merge', '--squash', '-q', `origin/${BRANCH}`);
    edit();
    sh(clone, 'git', 'add', '-A');
    sh(
      clone,
      'git',
      '-c',
      'user.email=gh@test',
      '-c',
      'user.name=github',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'Squashed (#7)',
    );
    sh(clone, 'git', 'push', '-q', 'origin', 'HEAD:main');
    return sh(clone, 'git', 'rev-parse', 'HEAD');
  }

  // Decision 88: `pup land` waits for a merge lock a live run holds rather
  // than hand the retry to the operator.
  it('waits, when asked, for a merge lock a live run holds, then lands', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });
    const lock = join(repo, '.git', 'pup-merge.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setTimeout(() => rmSync(lock, { recursive: true }), 200);

    try {
      const outcome = await landSession(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [passingAdapter],
        wait: true,
      });

      expect(outcome).toMatchObject({ targetSha: merge, fastForwarded: true });
      expect(errors.mock.calls.flat()).toContainEqual(
        expect.stringMatching(/^Waiting for the merge lock, held by pid \d+, for up to /),
      );
      expect(existsSync(lock)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('lands without the audit when asked, leaving the baseline for pup audit (decision 132)', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });
    vi.mocked(auditProject).mockClear();

    const outcome = await landSession(db, {
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: [],
      audit: false,
    });

    expect(outcome.audit).toBeUndefined();
    expect(auditProject).not.toHaveBeenCalled();
    expect(mainSha()).toBe(merge);
    expect(existsSync(worktree)).toBe(false);
    expect(landedEvents()).toHaveLength(1);
  });

  it('refuses a second land of the same session', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });
    await land();

    await expect(land()).rejects.toThrow('has already landed');
    expect(landedEvents()).toHaveLength(1);
  });

  // The gate's teardown keeps a branch that moved past the pin; so does the land.
  it('keeps a branch holding commits main does not', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    commitIn(worktree, 'src/later.ts', 'export const later = 1;\n');
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });

    const outcome = await land();

    expect(outcome.keptBranch).toBe(BRANCH);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH)).not.toBe('');
    expect(mainSha()).toBe(merge);
  });

  it('refuses a merge that opened no PR, changing nothing', async () => {
    seedPrMerge(null);
    const before = mainSha();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: pinned },
    });

    await expect(land()).rejects.toThrow('opened no pull request');
    expectNothingChanged(before);
    expect(existsSync(ghLog)).toBe(false);
  });

  // The audit runs after the land; with nothing to measure the land must not start.
  it('refuses with no adapter, changing nothing', async () => {
    seedPrMerge();
    mergeOnGitHub();
    const before = mainSha();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: pinned },
    });

    await expect(
      landSession(db, { repoPath: repo, sessionId: SESSION_ID, adapters: [] }),
    ).rejects.toThrow(`No adapter for ${repo}; the audit after the land would measure nothing.`);
    expectNothingChanged(before);
    expect(existsSync(ghLog)).toBe(false);
  });

  // The checkout the fast-forward writes must be the target's, as at the gate.
  it('refuses when the main checkout is on another branch, moving nothing, the tracking ref included', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    sh(repo, 'git', 'checkout', '-q', '-b', 'elsewhere');
    const before = mainSha();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });

    await expect(land()).rejects.toThrow('The main checkout is on elsewhere, not main');
    expectNothingChanged(before);
    expect(hasTrackingRef()).toBe(false);
  });

  it('refuses a merge commit over a head that moved past the pin, changing nothing', async () => {
    seedPrMerge();
    const later = commitIn(worktree, 'src/late.ts', 'export const late = 1;\n');
    sh(repo, 'git', 'push', '-q', origin, BRANCH);
    const merge = mergeOnGitHub(later);
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: later,
      mergeCommit: { oid: merge },
    });
    const mainBefore = mainSha();

    await expect(land()).rejects.toThrow(
      /merged with its head at .* not .* the commit the gate pinned; .* re-gated with `pup merge s1 --pr`/,
    );

    expectNothingChanged(mainBefore);
    expect(hasTrackingRef()).toBe(false);
  });

  it("refuses a row whose branch is not the session's own, asking gh nothing", async () => {
    seedPrMerge();
    db.prepare('UPDATE sessions SET branch = ? WHERE id = ?').run('main', SESSION_ID);
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: pinned },
    });
    const mainBefore = mainSha();

    await expect(land()).rejects.toThrow(/names a worktree or branch that is not its own/);

    expect(mainSha()).toBe(mainBefore);
    expect(sh(repo, 'git', 'branch', '--list', 'main')).not.toBe('');
    expect(existsSync(ghLog)).toBe(false);
  });

  // The url is store text: one outside origin's repo would land on another PR's word.
  it("refuses a PR url outside origin's repo, asking gh nothing", async () => {
    seedPrMerge('https://github.com/elsewhere/repo/pull/7');
    const before = mainSha();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: pinned },
    });

    await expect(land()).rejects.toThrow('is not a pull request of github.com/owner/repo');
    expectNothingChanged(before);
    expect(existsSync(ghLog)).toBe(false);
  });

  it.each(['OPEN', 'CLOSED'])(
    'refuses when gh says the PR is %s, changing nothing',
    async (state) => {
      seedPrMerge();
      mergeOnGitHub();
      const before = mainSha();
      fakeGh({ state, mergeCommit: null });

      await expect(land()).rejects.toThrow(`${PR_URL} is ${state} on GitHub, not MERGED`);
      expectNothingChanged(before);
      expect(hasTrackingRef()).toBe(false);
    },
  );

  // Decision 131: GitHub's squash merges the pinned content onto a main that
  // moved, so main holds the content the gate measured but not the pinned sha.
  it('lands a squash of the pinned content onto a moved main, fast-forwarding and auditing', async () => {
    seedPrMerge();
    const clone = cloneOrigin();
    moveOriginMain(clone);
    const squash = squashOnGitHub(clone);
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: squash },
    });

    const outcome = await land();

    expect(outcome).toMatchObject({
      mergeCommit: squash,
      targetSha: squash,
      fastForwarded: true,
      removedWorktree: true,
    });
    expect(outcome.keptBranch).toBeUndefined();
    expect(mainSha()).toBe(squash);
    expect(sh(repo, 'git', 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, 'src/feature.ts'), 'utf8')).toContain('feature');
    expect(readFileSync(join(repo, 'src/other.ts'), 'utf8')).toContain('other');
    expect(sh(repo, 'git', 'rev-parse', 'refs/remotes/origin/main')).toBe(squash);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH)).toBe('');
    expect(getProject(db, pid)?.baseline).not.toBeNull();
    expect(landedEvents().map((row) => JSON.parse(row.payload))).toEqual([
      { sha: squash, target: 'main', prUrl: PR_URL },
    ]);
  });

  it.each([
    ['an extra change', (clone: string) => writeFileSync(join(clone, 'src/extra.ts'), 'x;\n')],
    ['a missing change', (clone: string) => rmSync(join(clone, 'src/feature.ts'))],
    [
      'an altered change',
      (clone: string) =>
        writeFileSync(join(clone, 'src/feature.ts'), 'export const feature = 2;\n'),
    ],
  ])('refuses a squash with %s the gate never measured, changing nothing', async (_, edit) => {
    seedPrMerge();
    const clone = cloneOrigin();
    moveOriginMain(clone);
    const squash = squashOnGitHub(clone, () => edit(clone));
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: squash },
    });
    const before = mainSha();

    await expect(land()).rejects.toThrow(refusal(squash));
    expectNothingChanged(before);
    expect(hasTrackingRef()).toBe(false);
  });

  // A merge-tree that fails other than by a conflict (status 1), as one without
  // `--write-tree` does, is git failing, not content the gate never measured.
  it.each([
    ['rev-list', Object.assign(new Error('fatal: bad object'), { status: 128 })],
    ['merge-tree', Object.assign(new Error('fatal: bad object'), { status: 128 })],
  ])(
    'refuses, landing nothing, when %s fails reading what the merge landed',
    async (failing, failure) => {
      seedPrMerge();
      const clone = cloneOrigin();
      moveOriginMain(clone);
      const squash = squashOnGitHub(clone);
      fakeGh({
        state: 'MERGED',
        baseRefName: 'main',
        headRefOid: pinned,
        mergeCommit: { oid: squash },
      });
      const real = vi.mocked(withScratchGitDir).getMockImplementation();
      vi.mocked(withScratchGitDir).mockImplementation((repoPath, prefix, fn) =>
        (real as typeof withScratchGitDir)(repoPath, prefix, (git) =>
          fn((args, opts) => {
            if (args.includes(failing)) throw failure;
            return git(args, opts);
          }),
        ),
      );
      const before = mainSha();

      try {
        await expect(land()).rejects.toThrow(
          new RegExp(
            `^Reading what ${squash} landed failed\\. Nothing was landed\\.\\n.*bad object`,
            's',
          ),
        );
      } finally {
        vi.mocked(withScratchGitDir).mockReset();
      }
      expectNothingChanged(before);
      expect(hasTrackingRef()).toBe(false);
    },
  );

  // Ancestry alone would take a merge commit carrying changes of its own.
  it('refuses a merge commit with a change the gate never measured, changing nothing', async () => {
    seedPrMerge();
    const clone = cloneOrigin();
    moveOriginMain(clone);
    sh(clone, 'git', 'merge', '--no-ff', '--no-commit', '-q', `origin/${BRANCH}`);
    const merge = commitIn(clone, 'src/extra.ts', 'x;\n');
    sh(clone, 'git', 'push', '-q', 'origin', 'HEAD:main');
    expect(sh(clone, 'git', 'rev-list', '--parents', '-n', '1', merge).split(' ')).toContain(
      pinned,
    );
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });
    const before = mainSha();

    await expect(land()).rejects.toThrow(refusal(merge));
    expectNothingChanged(before);
    expect(hasTrackingRef()).toBe(false);
  });

  // The tree check merges a file both sides changed, which runs a merge driver
  // the repo's attributes and config name; the scratch git dir reads neither.
  it('runs no merge driver armed in the repo while checking the tree', async () => {
    pinned = commitIn(worktree, 'src/app.ts', 'export const app = 2;\n');
    sh(repo, 'git', 'push', '-q', origin, BRANCH);
    seedPrMerge();
    const clone = cloneOrigin();
    const moved = commitIn(clone, 'src/app.ts', 'export const app = 3;\n');
    sh(clone, 'git', 'push', '-q', 'origin', 'HEAD:main');
    writeFileSync(join(clone, 'src/feature.ts'), 'export const feature = 1;\n');
    const squash = commitIn(clone, 'src/app.ts', 'export const app = 2;\n');
    sh(clone, 'git', 'push', '-q', 'origin', 'HEAD:main');
    const marker = join(tempDir('pup-land-driver-'), 'ran');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* merge=x\n');
    sh(repo, 'git', 'config', 'merge.x.driver', `touch ${marker}; false`);
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: squash },
    });
    const before = mainSha();

    await expect(land()).rejects.toThrow(refusal(squash));
    expect(existsSync(marker)).toBe(false);
    expectNothingChanged(before);
    // The same merge run by the repo's own git does run it.
    expect(() => sh(repo, 'git', 'merge-tree', '--write-tree', moved, pinned)).toThrow();
    expect(existsSync(marker)).toBe(true);
  });
});
