import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { BRANCH, commitIn, ORIGIN_URL, PR_URL, SESSION_ID, sh } from '../test/helpers/land.mock.js';
import { tempDir } from '../test/temp-dir.mock.js';
import { auditProject } from './audit.service.js';
import { openStore } from './db.client.js';
import { gitDiffPaths } from './git-diff.client.js';
import { landSession } from './land.service.js';
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
      expect(outcome.audit?.heldOnRegression).toBe(false);
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
});
