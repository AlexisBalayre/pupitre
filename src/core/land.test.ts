import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endSandboxRun, GateInterruptedError } from './sandbox.utils.js';

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

import type { Adapter } from '../adapters/types/adapter.types.js';
import { SteerNotDeliveredError, steerPane } from '../claude/session-runtime.service.js';
import { tempDir } from '../test/temp-dir.mock.js';
import { auditProject } from './audit.service.js';
import { buildDashboardSnapshot, needsYou } from './dashboard.service.js';
import { openStore } from './db.client.js';
import { gitDiffPaths } from './git-diff.client.js';
import { initProject } from './init.service.js';
import { landSession } from './land.service.js';
import { runMergeGate, withScratchGitDir } from './merge-gate.service.js';
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
import { TerminalSessionError } from './session-lifecycle.errors.js';
import type { LandOutcome } from './types/land.types.js';

// Test repos must not inherit the developer's global git config nor GIT_DIR &
// co., which a pre-commit hook run would aim at the pupitre repo instead.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0] as string, args.slice(1), {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim();
}

function commitIn(dir: string, file: string, content: string): string {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', '-c', 'user.email=l@test', '-c', 'user.name=land', 'commit', '-q', '-m', file);
  return sh(dir, 'git', 'rev-parse', 'HEAD');
}

const SESSION_ID = 's1';
const BRANCH = `pup/${SESSION_ID}`;
const ORIGIN_URL = 'git@github.com:owner/repo.git';
const PR_URL = 'https://github.com/owner/repo/pull/7';

const passingAdapter: Adapter = {
  id: 'fake',
  detect: () => true,
  gateCommands: () => [
    { stage: 'build', command: 'true', args: [] },
    { stage: 'test', command: 'true', args: [] },
    { stage: 'lint', command: 'true', args: [] },
  ],
};

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

  describe('steering the live sessions it overlaps (decision 99)', () => {
    /**
     * A running session forked from main before the land, its branch changing
     * `file`. `branch` is what its row names, `inGit: false` leaves that branch
     * out of git, and `pane: false` records no window for it.
     */
    function seedPeer(
      id: string,
      file: string,
      { branch = `pup/${id}`, inGit = true, pane = true } = {},
    ): void {
      const peerTree = join(repo, '.worktrees', id);
      if (inGit) {
        sh(repo, 'git', 'worktree', 'add', '-q', '-b', branch, peerTree, 'main');
        commitIn(peerTree, file, `export const peer = '${id}';\n`);
      }
      insertTask(db, { id: `task-${id}`, projectId: pid, spec: '{}' });
      insertSession(db, {
        id,
        taskId: `task-${id}`,
        worktreePath: peerTree,
        branch,
        profileHash: 'hash',
        ...(pane ? { tmuxTarget: `%${id}` } : {}),
      });
      transitionSession(db, id, 'running');
    }

    async function landMerged(): Promise<LandOutcome> {
      seedPrMerge();
      const merge = mergeOnGitHub();
      fakeGh({
        state: 'MERGED',
        baseRefName: 'main',
        headRefOid: pinned,
        mergeCommit: { oid: merge },
      });
      return land();
    }

    const steersTo = (id: string) =>
      vi.mocked(steerPane).mock.calls.filter(([pane]) => pane.paneId === `%${id}`);
    const steerEvents = (id: string) =>
      listEvents(db, id)
        .filter((row) => row.type === 'steer')
        .map((row) => JSON.parse(row.payload));

    beforeEach(() => {
      vi.mocked(steerPane).mockReset();
      // Back to the real diff the mock wraps.
      vi.mocked(gitDiffPaths).mockReset();
    });

    it('steers no one, and still lands, when git cannot list the landed files', async () => {
      seedPeer('s2', 'src/feature.ts');
      const real = vi.mocked(gitDiffPaths).getMockImplementation();
      vi.mocked(gitDiffPaths).mockImplementation((repoPath, target, branch) => {
        // The landed files are the merge commit's; a peer's are its branch's.
        if (!branch.startsWith('refs/heads/')) throw new Error('fatal: bad revision');
        return real?.(repoPath, target, branch) ?? [];
      });

      await landMerged();

      expect(
        vi
          .mocked(gitDiffPaths)
          .mock.calls.some(([, , branch]) => !branch.startsWith('refs/heads/')),
      ).toBe(true);
      expect(landedEvents()).toHaveLength(1);
      expect(steersTo('s2')).toEqual([]);
      expect(steerEvents('s2')).toEqual([]);
    });

    it('skips a peer whose id or branch is not one a launch mints', async () => {
      seedPeer('bad.id', 'src/feature.ts');
      seedPeer('s4', 'src/feature.ts', { branch: 'pup/elsewhere' });
      seedPeer('s2', 'src/feature.ts');

      await landMerged();

      expect(steersTo('bad.id')).toEqual([]);
      expect(steersTo('s4')).toEqual([]);
      expect(steersTo('s2')).toHaveLength(1);
    });

    it('skips a peer whose branch git cannot read, and still steers the rest', async () => {
      seedPeer('s3', 'src/feature.ts', { inGit: false });
      seedPeer('s2', 'src/feature.ts');

      await landMerged();

      expect(steersTo('s3')).toEqual([]);
      expect(steerEvents('s3')).toEqual([]);
      expect(steerEvents('s2')).toEqual([{ kind: 'main-landed', by: SESSION_ID }]);
    });

    it('steers past a peer with no window and one that has just stopped', async () => {
      seedPeer('s3', 'src/feature.ts', { pane: false });
      seedPeer('s4', 'src/feature.ts');
      seedPeer('s2', 'src/feature.ts');
      vi.mocked(steerPane).mockImplementation((pane) => {
        if (pane.paneId === '%s4') throw new TerminalSessionError('s4', 'killed', 'steer');
      });

      await landMerged();

      expect(steerEvents('s3')).toEqual([]);
      expect(steerEvents('s4')).toEqual([]);
      expect(steerEvents('s2')).toEqual([{ kind: 'main-landed', by: SESSION_ID }]);
    });

    it('lands with its audit whatever else a steer throws, and still steers the rest', async () => {
      seedPeer('s3', 'src/feature.ts');
      seedPeer('s2', 'src/feature.ts');
      vi.mocked(steerPane).mockImplementation((pane) => {
        if (pane.paneId === '%s3') throw new Error('tmux: server exited unexpectedly');
      });

      const outcome = await landMerged();

      expect(landedEvents()).toHaveLength(1);
      expect(outcome.audit.heldOnRegression).toBe(false);
      expect(getProject(db, pid)?.baseline).not.toBeNull();
      expect(steerEvents('s3')).toEqual([]);
      expect(steerEvents('s2')).toEqual([{ kind: 'main-landed', by: SESSION_ID }]);
    });

    it('stops on an interrupt during a steer, with the land already recorded', async () => {
      seedPeer('s2', 'src/feature.ts');
      vi.mocked(steerPane).mockImplementation(() => {
        throw Object.assign(new Error('tmux interrupted'), { signal: 'SIGINT' });
      });

      await expect(landMerged()).rejects.toThrow('tmux interrupted');
      expect(landedEvents()).toHaveLength(1);
    });

    // Once the event is written a re-run refuses, so a steer left for after a
    // failed audit would never be sent (decision 88).
    it('steers before an audit that throws, which a re-run then refuses', async () => {
      seedPeer('s2', 'src/feature.ts');
      vi.mocked(auditProject).mockRejectedValueOnce(new GateInterruptedError('SIGINT'));

      await expect(landMerged()).rejects.toThrow(GateInterruptedError);

      expect(landedEvents()).toHaveLength(1);
      expect(steerEvents('s2')).toEqual([{ kind: 'main-landed', by: SESSION_ID }]);
      await expect(land()).rejects.toThrow('has already landed');
    });

    it('steers a live session sharing a landed file once, and one sharing none not at all', async () => {
      seedPeer('s2', 'src/feature.ts');
      seedPeer('s3', 'src/other.ts');

      await landMerged();

      expect(steersTo('s2')).toHaveLength(1);
      expect(steerEvents('s2')).toEqual([{ kind: 'main-landed', by: SESSION_ID }]);
      expect(steersTo('s3')).toEqual([]);
      expect(steerEvents('s3')).toEqual([]);
    });

    // Waking an idle window re-reads its whole cached context; the gate's
    // fresh-base stage takes the target in for the rest (decision 104).
    it('steers running sessions only, not one awaiting review, rejected or blocked', async () => {
      seedPeer('s2', 'src/feature.ts');
      seedPeer('s3', 'src/feature.ts');
      transitionSession(db, 's3', 'awaiting-review');
      seedPeer('s4', 'src/feature.ts');
      transitionSession(db, 's4', 'awaiting-review');
      transitionSession(db, 's4', 'rejected');
      seedPeer('s5', 'src/feature.ts');
      transitionSession(db, 's5', 'blocked');

      await landMerged();

      expect(steerEvents('s2')).toEqual([{ kind: 'main-landed', by: SESSION_ID }]);
      for (const id of ['s3', 's4', 's5']) {
        expect(steersTo(id)).toEqual([]);
        expect(steerEvents(id)).toEqual([]);
      }
    });

    // Two lines appended at the index's end always conflict, and the gate
    // counts a failed rebase as a rejection (decision 104).
    it('steers a running peer sharing only the decisions index, naming it', async () => {
      pinned = commitIn(worktree, 'docs/adr/README.md', '# Decisions\n');
      sh(repo, 'git', 'push', '-q', origin, BRANCH);
      seedPeer('s2', 'docs/adr/README.md');

      await landMerged();

      expect(steerEvents('s2')).toEqual([{ kind: 'main-landed', by: SESSION_ID }]);
      expect(String(steersTo('s2')[0]?.[1])).toContain('docs/adr/README.md');
    });

    it('tells a branch with no open PR to rebase onto main, never to force-push', async () => {
      seedPeer('s2', 'src/feature.ts');

      await landMerged();

      const message = String(steersTo('s2')[0]?.[1]);
      expect(message).toContain(`pup-${SESSION_ID} just landed on main`);
      expect(message).toContain('src/feature.ts');
      expect(message).toContain('`git rebase refs/heads/main`');
      expect(message).not.toContain('git merge');
      expect(message).not.toMatch(/force|push/i);
    });

    it('tells a branch with an open PR to merge main in, never to rebase or force-push', async () => {
      seedPeer('s2', 'src/feature.ts');
      appendEvent(db, 's2', 'merge', {
        branch: 'pup/s2',
        sha: sh(repo, 'git', 'rev-parse', 'pup/s2'),
        target: 'main',
        files: ['src/feature.ts'],
        prUrl: 'https://github.com/owner/repo/pull/8',
      });

      await landMerged();

      const message = String(steersTo('s2')[0]?.[1]);
      expect(message).toContain('`git merge refs/heads/main`');
      expect(message).toContain('merge commit');
      expect(message).not.toContain('git rebase');
      expect(message).not.toMatch(/force|push/i);
    });

    it('lands whatever a steer does: a refused paste records no steer', async () => {
      seedPeer('s2', 'src/feature.ts');
      vi.mocked(steerPane).mockImplementationOnce(() => {
        throw new SteerNotDeliveredError('s2', 10, 'box-absent');
      });

      await landMerged();

      expect(landedEvents()).toHaveLength(1);
      expect(steerEvents('s2')).toEqual([]);
    });
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

  it('refuses a session the store does not hold', async () => {
    const before = mainSha();

    await expect(
      landSession(db, { repoPath: repo, sessionId: 'nope', adapters: [passingAdapter] }),
    ).rejects.toThrow('No session nope. Nothing was landed.');
    expectNothingChanged(before);
  });

  it('refuses a merged session with no merge event, changing nothing', async () => {
    transitionSession(db, SESSION_ID, 'merged');
    const before = mainSha();

    await expect(land()).rejects.toThrow('opened no pull request');
    expectNothingChanged(before);
  });

  it('refuses a MERGED answer that names no merge commit, changing nothing', async () => {
    seedPrMerge();
    mergeOnGitHub();
    const before = mainSha();
    fakeGh({ state: 'MERGED', baseRefName: 'main', headRefOid: pinned, mergeCommit: null });

    await expect(land()).rejects.toThrow(`GitHub reports ${PR_URL} merged with no merge commit.`);
    expectNothingChanged(before);
    expect(hasTrackingRef()).toBe(false);
  });

  it('refuses when origin cannot be fetched, changing nothing', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    rmSync(origin, { recursive: true, force: true });
    const before = mainSha();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });

    await expect(land()).rejects.toThrow(
      `Fetching main from ${ORIGIN_URL} failed. Nothing was landed.`,
    );
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

  // A CI fix round moved the PR's head: the PR is re-gated before it is merged,
  // and the land then trusts the head the newest merge event pinned (decision 86).
  it('refuses an open PR whose head moved, naming the re-gate', async () => {
    seedPrMerge();
    const later = commitIn(worktree, 'src/fix.ts', 'export const fix = 1;\n');
    fakeGh({ state: 'OPEN', baseRefName: 'main', headRefOid: later });
    const mainBefore = mainSha();

    await expect(land()).rejects.toThrow(
      /is OPEN on GitHub with its head at .*`pup merge s1 --pr`/,
    );

    expectNothingChanged(mainBefore);
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

    expect(outcome.audit.heldOnRegression).toBe(true);
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

  // GitHub prints the repo in its canonical case whatever case origin was
  // recorded with; two names apart by case are one GitHub repo.
  it('accepts a pull request url whose case differs from the recorded origin', async () => {
    seedPrMerge('https://github.com/Owner/Repo/pull/7');
    const merge = mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });

    expect((await land()).mergeCommit).toBe(merge);
  });

  it("refuses a row whose worktree is not the session's own, asking gh nothing", async () => {
    seedPrMerge();
    db.prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?').run(
      join(repo, '.worktrees', 'other'),
      SESSION_ID,
    );
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: pinned },
    });
    const mainBefore = mainSha();

    await expect(land()).rejects.toThrow(/names a worktree or branch that is not its own/);

    expectNothingChanged(mainBefore);
    expect(existsSync(ghLog)).toBe(false);
  });

  it('lands past a worktree directory git no longer registers', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    sh(repo, 'git', 'worktree', 'remove', '--force', worktree);
    mkdirSync(worktree, { recursive: true });
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });

    const outcome = await land();

    expect(outcome.removedWorktree).toBe(false);
    expect(mainSha()).toBe(merge);
    expect(landedEvents()).toHaveLength(1);
  });

  it('keeps a worktree git cannot remove, and its branch, and says so', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    sh(repo, 'git', 'worktree', 'lock', worktree);
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });

    const outcome = await land();

    expect(outcome).toMatchObject({ removedWorktree: false, keptWorktree: worktree });
    expect(outcome.keptBranch).toBeUndefined();
    expect(existsSync(worktree)).toBe(true);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH)).not.toBe('');
    expect(mainSha()).toBe(merge);
    expect(landedEvents()).toHaveLength(1);
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

  // Decision 130: GitHub's squash merges the pinned content onto a main that
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

  it('refuses, landing nothing, when git fails reading what the merge landed', async () => {
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
          if (args.includes('rev-list')) throw new Error('fatal: bad object');
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
  });

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

  // GitHub resolved the conflict its own way: no merge of the pin gives that tree.
  it('refuses a squash of a pin that conflicts with the moved main, changing nothing', async () => {
    seedPrMerge();
    const clone = cloneOrigin();
    commitIn(clone, 'src/feature.ts', 'export const feature = 0;\n');
    sh(clone, 'git', 'push', '-q', 'origin', 'HEAD:main');
    const squash = commitIn(clone, 'src/feature.ts', 'export const feature = 1;\n');
    sh(clone, 'git', 'push', '-q', 'origin', 'HEAD:main');
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
