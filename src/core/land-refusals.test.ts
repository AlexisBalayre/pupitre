import { execFileSync } from 'node:child_process';
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

import {
  BRANCH,
  commitIn,
  ORIGIN_URL,
  PR_URL,
  passingAdapter,
  SESSION_ID,
  sh,
} from '../test/helpers/land.mock.js';
import { tempDir } from '../test/temp-dir.mock.js';
import { buildDashboardSnapshot, needsYou } from './dashboard.service.js';
import { openStore } from './db.client.js';
import { gitDiffPaths } from './git-diff.client.js';
import { initProject } from './init.service.js';
import { landSession } from './land.service.js';
import { runMergeGate } from './merge-gate.service.js';
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

  // The first's `landed` event is written under the lock the second then
  // takes: the second must not land, audit and steer again (decision 88).
  it('refuses a second land that waited on the first, under the lock', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });
    // Both wait on a third run's lock, so both pass the checks before it.
    const lock = join(repo, '.git', 'pup-merge.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
    setTimeout(() => rmSync(lock, { recursive: true }), 200);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const landWaiting = () =>
      landSession(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [passingAdapter],
        wait: true,
      });

    try {
      const [first, second] = await Promise.allSettled([landWaiting(), landWaiting()]);

      expect(first.status).toBe('fulfilled');
      expect(second).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: `Session ${SESSION_ID} has already landed.` }),
      });
      expect(landedEvents()).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it('fast-forwards main, removes the worktree and branch, audits and records the land', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });

    const outcome = await land();

    expect(outcome).toMatchObject({
      prUrl: PR_URL,
      mergeCommit: merge,
      target: 'main',
      targetSha: merge,
      fastForwarded: true,
      removedWorktree: true,
    });
    expect(outcome.keptBranch).toBeUndefined();
    expect(mainSha()).toBe(merge);
    // The checkout moved with the ref, not only the ref.
    expect(sh(repo, 'git', 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, 'src/feature.ts'), 'utf8')).toContain('feature');
    expect(sh(repo, 'git', 'rev-parse', 'refs/remotes/origin/main')).toBe(merge);
    expect(existsSync(worktree)).toBe(false);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH)).toBe('');
    expect(getProject(db, pid)?.baseline).not.toBeNull();
    expect(landedEvents().map((row) => JSON.parse(row.payload))).toEqual([
      { sha: merge, target: 'main', prUrl: PR_URL },
    ]);
    // Asked the way the gate asks gh: the PR by url, pinned to origin's repo.
    expect(readFileSync(ghLog, 'utf8').trim().split('\n').at(-1)).toBe(
      `pr view ${PR_URL} --repo github.com/owner/repo --json state,headRefOid,baseRefName,mergeCommit`,
    );
    // The inbox reads the event, so the PR no longer waits on the operator.
    expect(needsYou(buildDashboardSnapshot(db, repo, Date.now()))).toEqual([]);
  });

  it('refuses a session that is not merged, changing nothing', async () => {
    const before = mainSha();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: pinned },
    });

    await expect(land()).rejects.toThrow('is awaiting-review, not merged');
    expectNothingChanged(before);
    expect(existsSync(ghLog)).toBe(false);
  });

  // The store is session-writable: a merge row can lack what the land checks against.
  it.each<[string, (pin: string) => Record<string, string>]>([
    ['no pinned sha', () => ({ target: 'main' })],
    ['a sha outside the pinned shape', () => ({ sha: '--upload-pack=x', target: 'main' })],
    ['no target', (pin) => ({ sha: pin })],
  ])('refuses a merge event with %s, changing nothing', async (_label, fields) => {
    transitionSession(db, SESSION_ID, 'merged');
    db.prepare("INSERT INTO events (session_id, type, payload) VALUES (?, 'merge', ?)").run(
      SESSION_ID,
      JSON.stringify({ branch: BRANCH, files: [], prUrl: PR_URL, ...fields(pinned) }),
    );
    const before = mainSha();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: pinned },
    });

    await expect(land()).rejects.toThrow('merge event names no pinned sha and target');
    expectNothingChanged(before);
    expect(existsSync(ghLog)).toBe(false);
  });

  it('refuses a session the store does not hold', async () => {
    const before = mainSha();

    await expect(
      landSession(db, { repoPath: repo, sessionId: 'nope', adapters: [passingAdapter] }),
    ).rejects.toThrow('No session nope. Nothing was landed.');
    expectNothingChanged(before);
  });

  it('refuses a local main with commits origin lacks, leaving it where it is', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    sh(
      repo,
      'git',
      '-c',
      'user.email=l@test',
      '-c',
      'user.name=land',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'local',
    );
    const before = mainSha();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });

    await expect(land()).rejects.toThrow(
      `Local main at ${before} has commits origin's main at ${merge} lacks`,
    );
    expectNothingChanged(before);
  });

  it('lands a PR GitHub merged at the head a re-gate pinned', async () => {
    db.prepare('UPDATE tasks SET spec = ? WHERE id = ?').run(
      JSON.stringify({ id: 'task-s1', goal: 'g', scopeIn: ['src/**'], acceptance: ['a'] }),
      'task-s1',
    );
    seedPrMerge();
    const later = commitIn(worktree, 'src/fix.ts', 'export const fix = 1;\n');
    sh(repo, 'git', 'push', '-q', origin, BRANCH);
    // gh for the re-gate: the PR open at the fix round's head, listed for the
    // branch, its description edit taken.
    const dir = tempDir('pup-land-gh-');
    const listed = [{ url: PR_URL, baseRefName: 'main', isCrossRepository: false }];
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${ghLog}`,
        `if [ "$2" = "list" ]; then echo '${JSON.stringify(listed)}'; exit 0; fi`,
        'cat >/dev/null',
        `echo '${JSON.stringify({ state: 'OPEN', baseRefName: 'main', headRefOid: later })}'`,
      ].join('\n'),
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${originalPath}`;
    const regated = await runMergeGate(db, {
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: [passingAdapter],
      openPr: true,
    });
    expect(regated.status).toBe('merged');
    const merge = mergeOnGitHub(later);
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: later,
      mergeCommit: { oid: merge },
    });

    const outcome = await land();

    expect(outcome).toMatchObject({ prUrl: PR_URL, mergeCommit: merge, fastForwarded: true });
    expect(mainSha()).toBe(merge);
    expect(readFileSync(join(repo, 'src/fix.ts'), 'utf8')).toContain('fix');
    expect(landedEvents().map((row) => JSON.parse(row.payload))).toEqual([
      { sha: merge, target: 'main', prUrl: PR_URL },
    ]);
  });

  it('refuses a PR merged into another base, changing nothing', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'release',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });
    const mainBefore = mainSha();

    await expect(land()).rejects.toThrow(/was merged into release, not main/);

    expectNothingChanged(mainBefore);
  });

  it('keeps a regressed baseline for pup audit rather than re-stamping it', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });
    const measuring = (lines: number) => ({
      ...passingAdapter,
      duplication: () => ({ duplicatedLines: lines, blocks: [] }),
    });
    await initProject(db, repo, [measuring(10)]);
    const stored = getProject(db, pid)?.baseline;

    const outcome = await landSession(db, {
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: [measuring(40)],
    });

    expect(outcome.audit?.heldOnRegression).toBe(true);
    expect(getProject(db, pid)?.baseline).toBe(stored);
    expect(landedEvents()).toHaveLength(1);
  });

  it('refuses a merge commit origin does not hold, changing nothing', async () => {
    seedPrMerge();
    mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: 'b'.repeat(40) },
    });
    const mainBefore = mainSha();

    await expect(land()).rejects.toThrow(/does not contain b{40}, the commit GitHub says merged/);

    expectNothingChanged(mainBefore);
    expect(hasTrackingRef()).toBe(false);
  });

  // A Ctrl-C under the lock kills the child git, not node; a catch that read
  // the dead child as git's answer would carry on and record a land that a
  // re-run then refuses.
  it.each([
    ['the worktree removal', 'worktree remove'],
    ['an ancestry check', 'merge-base'],
    ['the symref probe', 'symbolic-ref -q'],
    ['the branch read', `rev-parse --verify --quiet refs/heads/${BRANCH}^{commit}`],
    ['the branch delete', 'update-ref --no-deref -d'],
  ])(
    'stops on a signal that kills %s, records nothing, and lands on the re-run',
    async (_, call) => {
      seedPrMerge();
      const merge = mergeOnGitHub();
      fakeGh({
        state: 'MERGED',
        baseRefName: 'main',
        headRefOid: pinned,
        mergeCommit: { oid: merge },
      });
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const dir = tempDir('pup-land-git-');
      writeFileSync(
        join(dir, 'git'),
        `#!/bin/sh\ncase " $* " in *" ${call} "*) kill -TERM $$ ;; esac\nexec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );
      const pathWithGh = process.env.PATH;
      process.env.PATH = `${dir}:${pathWithGh}`;

      await expect(land()).rejects.toThrow(expect.objectContaining({ signal: 'SIGTERM' }));
      expect(landedEvents()).toEqual([]);
      expect(existsSync(join(repo, '.git', 'pup-merge.lock'))).toBe(false);

      process.env.PATH = pathWithGh;
      expect((await land()).mergeCommit).toBe(merge);
      expect(existsSync(worktree)).toBe(false);
      expect(sh(repo, 'git', 'branch', '--list', BRANCH)).toBe('');
      expect(landedEvents()).toHaveLength(1);
    },
  );

  it('refuses when the main checkout is elsewhere although main already holds the merge', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    sh(repo, 'git', 'checkout', '-q', '-b', 'elsewhere');
    sh(repo, 'git', 'fetch', '-q', origin, 'main:main');
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });

    await expect(land()).rejects.toThrow('The main checkout is on elsewhere, not main');

    expect(landedEvents()).toEqual([]);
    expect(getProject(db, pid)?.baseline).toBeNull();
  });

  // The gate's teardown usually removed both already; the land then has nothing to do there.
  it('lands a session whose worktree and branch are already gone', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    sh(repo, 'git', 'worktree', 'remove', '--force', worktree);
    sh(repo, 'git', 'branch', '-q', '-D', BRANCH);
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });

    const outcome = await land();

    expect(outcome.removedWorktree).toBe(false);
    expect(outcome.keptBranch).toBeUndefined();
    expect(mainSha()).toBe(merge);
    expect(landedEvents()).toHaveLength(1);
  });

  // A rebase merge replays each pinned commit, so the last one's tree is
  // checked against the base the first went onto, as many commits down.
  it('lands a rebase merge of a two-commit pin onto a moved main', async () => {
    pinned = commitIn(worktree, 'src/second.ts', 'export const second = 1;\n');
    sh(repo, 'git', 'push', '-q', origin, BRANCH);
    seedPrMerge();
    const clone = cloneOrigin();
    const moved = moveOriginMain(clone);
    sh(clone, 'git', 'checkout', '-q', '-b', 'rebased', `origin/${BRANCH}`);
    sh(clone, 'git', '-c', 'user.email=gh@test', '-c', 'user.name=github', 'rebase', '-q', 'main');
    sh(clone, 'git', 'push', '-q', 'origin', 'rebased:main');
    const last = sh(clone, 'git', 'rev-parse', 'HEAD');
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: last },
    });

    const outcome = await land();

    expect(outcome).toMatchObject({ mergeCommit: last, targetSha: last, fastForwarded: true });
    expect(mainSha()).toBe(last);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH)).toBe('');
    expect(landedEvents()).toHaveLength(1);
    // The landed files are both replayed commits', not the last one's alone.
    expect(vi.mocked(gitDiffPaths)).toHaveBeenCalledWith(repo, moved, last);
  });

  // Squashed onto the moved main, but undoing it: the tree is the pinned one
  // exactly, which only a rebase onto main's older tip could give, and no
  // replayed commit there is the other PR's.
  it("refuses a squash of a two-commit pin that drops another PR's change, changing nothing", async () => {
    pinned = commitIn(worktree, 'src/second.ts', 'export const second = 1;\n');
    sh(repo, 'git', 'push', '-q', origin, BRANCH);
    seedPrMerge();
    const clone = cloneOrigin();
    moveOriginMain(clone);
    const squash = squashOnGitHub(clone, () => rmSync(join(clone, 'src/other.ts')));
    expect(sh(clone, 'git', 'rev-parse', `${squash}^{tree}`)).toBe(
      sh(clone, 'git', 'rev-parse', `${pinned}^{tree}`),
    );
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: squash },
    });
    const before = mainSha();

    await expect(land()).rejects.toThrow(refusal(squash));
    expectNothingChanged(before);
  });
});
