import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  endSandboxRun,
  GateInterruptedError,
  runGateChild,
  TOOLCHAIN_CACHE_DIRNAME,
} from './sandbox.utils.js';

vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  killSession: vi.fn(),
  steerPane: vi.fn(),
}));
// A gate that merges drafts a decision record, which would spawn `claude -p`.
vi.mock('../claude/utility.service.js', () => ({
  runUtility: vi.fn(() => ({ ok: false, output: 'mocked out in tests' })),
}));
// The real loadavg, wrapped so a gate asked to wait never waits on this
// machine's load (decision 88).
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, loadavg: vi.fn(actual.loadavg) };
});
// The real diff, so a test can fail one call of it and no other.
vi.mock('./git-diff.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-diff.client.js')>();
  return { ...actual, gitDiffPaths: vi.fn(actual.gitDiffPaths) };
});
// The real scratch git dir, so a test can fail one git call made in it, and
// the real stages, so a test can stand in for one remeasure's.
vi.mock('./merge-gate.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./merge-gate.service.js')>();
  return {
    ...actual,
    withScratchGitDir: vi.fn(actual.withScratchGitDir),
    measureBranch: vi.fn(actual.measureBranch),
  };
});
// The real audit, so a test can make the one after a land throw.
vi.mock('./audit.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./audit.service.js')>();
  return { ...actual, auditProject: vi.fn(actual.auditProject) };
});

import { BRANCH, commitIn, ORIGIN_URL, PR_URL, SESSION_ID, sh } from '@test/helpers/land.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { SteerNotDeliveredError, steerPane } from '../claude/session-runtime.service.js';
import { auditProject } from './audit.service.js';
import { openStore } from './db.client.js';
import { gitDiffPaths } from './git-diff.client.js';
import { initProject } from './init.service.js';
import { landSession } from './land.service.js';
import { insertLedgerEntry } from './ledger.repository.js';
import { PROTECTED_PATH_GLOBS } from './merge-gate.constants.js';
import { MergeLockLostError } from './merge-gate.errors.js';
import { measureBranch, runMergeGate, withScratchGitDir } from './merge-gate.service.js';
import { projectId, projectPaths } from './paths.utils.js';
import { LAND_STAGES, stageProgress } from './progress.utils.js';
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
import { HELD_SLOT_ENV } from './test-slot.service.js';
import type { ProjectBaseline } from './types/init.types.js';
import type { LandOutcome } from './types/land.types.js';
import type { GateReport, GateStageResult } from './types/merge-gate.types.js';

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
  function seedPrMerge(prUrl: string | null = PR_URL, report?: GateReport): void {
    // The gate files its report on the way to merged, before the merge event.
    transitionSession(db, SESSION_ID, 'merged', report === undefined ? undefined : { report });
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

      const outcome = await landMerged();

      expect(steersTo('s3')).toEqual([]);
      expect(steerEvents('s3')).toEqual([]);
      expect(steerEvents('s2')).toEqual([{ kind: 'main-landed', by: SESSION_ID }]);
      expect(outcome.unsteered).toEqual([
        { sessionId: 's3', reason: expect.stringMatching(/^git could not read its branch: /) },
      ]);
    });

    it('steers past a peer with no window and one that has just stopped', async () => {
      seedPeer('s3', 'src/feature.ts', { pane: false });
      seedPeer('s4', 'src/feature.ts');
      seedPeer('s2', 'src/feature.ts');
      vi.mocked(steerPane).mockImplementation((pane) => {
        if (pane.paneId === '%s4') throw new TerminalSessionError('s4', 'killed', 'steer');
      });

      const outcome = await landMerged();

      expect(steerEvents('s3')).toEqual([]);
      expect(steerEvents('s4')).toEqual([]);
      expect(steerEvents('s2')).toEqual([{ kind: 'main-landed', by: SESSION_ID }]);
      expect(outcome.unsteered?.map((entry) => entry.sessionId)).toEqual(['s3', 's4']);
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
      // Reported, never recorded: a steer event would answer s3's open question.
      expect(outcome.unsteered).toEqual([
        { sessionId: 's3', reason: 'tmux: server exited unexpectedly' },
      ]);
      expect(steerEvents('s3')).toEqual([]);
      expect(steerEvents('s2')).toEqual([{ kind: 'main-landed', by: SESSION_ID }]);
    });

    // A failed steer is not recorded, and a kill during the audit would lose the
    // outcome: the line is printed, scrubbed, before the audit starts (decision 99).
    it('prints each peer it could not steer on one scrubbed line before its audit, and lands', async () => {
      seedPeer('s2', 'src/feature.ts');
      vi.mocked(steerPane).mockImplementationOnce(() => {
        throw new Error('tmux: server\n\u001b[2J exited');
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const actual =
        await vi.importActual<typeof import('./audit.service.js')>('./audit.service.js');
      let printedBeforeAudit: unknown[] = [];
      vi.mocked(auditProject).mockImplementationOnce((...args) => {
        printedBeforeAudit = errors.mock.calls.flat();
        return actual.auditProject(...args);
      });

      try {
        const outcome = await landMerged();

        expect(printedBeforeAudit).toEqual([
          'Could not tell s2 that main moved: tmux: server [2J exited. Steer it to take main in.',
        ]);
        expect(outcome.unsteered).toEqual([{ sessionId: 's2', reason: 'tmux: server [2J exited' }]);
        expect(outcome.audit?.heldOnRegression).toBe(false);
      } finally {
        errors.mockRestore();
      }
      expect(steerEvents('s2')).toEqual([]);
    });

    it('reports no unsteered session when every overlapping one was steered', async () => {
      seedPeer('s2', 'src/feature.ts');

      const outcome = await landMerged();

      expect(outcome.unsteered).toBeUndefined();
    });

    // A session can rename the lock away under a land: the release then finds
    // it gone after the event, so the land happened but unprotected. A re-run
    // refuses, so the steer and the outcome must survive it (decision 88).
    it('steers once and carries the land on the error a lock moved away under it raises', async () => {
      seedPeer('s2', 'src/feature.ts');
      const lock = join(repo, '.git', 'pup-merge.lock');
      const actual =
        await vi.importActual<typeof import('./audit.service.js')>('./audit.service.js');
      vi.mocked(auditProject).mockImplementationOnce((...args) => {
        renameSync(lock, `${lock}.moved`);
        return actual.auditProject(...args);
      });

      const error = await landMerged().then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(MergeLockLostError);
      expect((error as MergeLockLostError<LandOutcome>).result).toMatchObject({
        prUrl: PR_URL,
        target: 'main',
        fastForwarded: true,
        removedWorktree: true,
        audit: { heldOnRegression: false },
      });
      expect(landedEvents()).toHaveLength(1);
      expect(steersTo('s2')).toHaveLength(1);
      await expect(land()).rejects.toThrow('has already landed');
      expect(steerEvents('s2')).toEqual([{ kind: 'main-landed', by: SESSION_ID }]);
    });

    // The steer wakes the sessions gated next. A gate reading the baseline
    // before the audit stores it would judge against the target before the
    // land, and its ratchet would write over the refresh (decision 88).
    it('holds a gate started during its audit until the refresh is stored', {
      timeout: 60_000,
    }, async () => {
      // As inside a slot already held, so the gate never queues behind the
      // machine's real test runs (decision 96).
      vi.stubEnv(HELD_SLOT_ENV, 'land.test');
      vi.mocked(loadavg).mockReturnValue([0, 0, 0]);
      onTestFinished(() => {
        vi.mocked(loadavg).mockReset();
      });
      const measuring = (lines: number): Adapter => ({
        ...passingAdapter,
        duplication: () => ({ duplicatedLines: lines, blocks: [] }),
      });
      await initProject(db, repo, [measuring(40)]);
      seedPeer('s2', 'src/other.ts');
      db.prepare('UPDATE tasks SET spec = ? WHERE id = ?').run(
        JSON.stringify({ id: 'task-s2', goal: 'g', scopeIn: ['src/**'], acceptance: ['a'] }),
        'task-s2',
      );
      transitionSession(db, 's2', 'awaiting-review');
      seedPrMerge();
      const merge = mergeOnGitHub();
      fakeGh({
        state: 'MERGED',
        baseRefName: 'main',
        headRefOid: pinned,
        mergeCommit: { oid: merge },
      });
      const actual =
        await vi.importActual<typeof import('./audit.service.js')>('./audit.service.js');
      let gate: ReturnType<typeof runMergeGate> | undefined;
      vi.mocked(auditProject).mockImplementationOnce((...args) => {
        gate = runMergeGate(db, {
          repoPath: repo,
          sessionId: 's2',
          adapters: [measuring(10)],
          wait: true,
        });
        return actual.auditProject(...args);
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        const outcome = await landSession(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [measuring(10)],
        });
        const gated = await gate;

        expect(outcome.audit?.baseline.debt?.duplicatedLines).toBe(10);
        expect(gated?.status).toBe('merged');
        expect(gated?.report.stages.find((s) => s.stage === 'duplication')?.detail).toContain(
          '(baseline 10)',
        );
        const stored = JSON.parse(getProject(db, pid)?.baseline ?? 'null') as ProjectBaseline;
        expect(stored.capturedAt).toBe(outcome.audit?.baseline.capturedAt);
        expect(stored.debt?.duplicatedLines).toBe(10);
      } finally {
        errors.mockRestore();
      }
    });

    it('stops on an interrupt during a steer, with the land already recorded', async () => {
      seedPeer('s2', 'src/feature.ts');
      vi.mocked(steerPane).mockImplementation(() => {
        throw Object.assign(new Error('tmux interrupted'), { signal: 'SIGINT' });
      });

      await expect(landMerged()).rejects.toThrow('tmux interrupted');
      expect(landedEvents()).toHaveLength(1);
    });

    // No outcome reaches the CLI and a re-run refuses: the line is said now or
    // never, and still no steer is recorded for it (decision 99).
    it('names a peer it could not steer when the audit after it throws', async () => {
      seedPeer('s2', 'src/feature.ts');
      vi.mocked(steerPane).mockImplementationOnce(() => {
        throw new SteerNotDeliveredError('s2', 10, 'box-absent');
      });
      vi.mocked(auditProject).mockRejectedValueOnce(new Error('sandbox refused'));
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        await expect(landMerged()).rejects.toThrow('sandbox refused');

        expect(errors.mock.calls.flat()).toContainEqual(
          expect.stringMatching(
            /^Could not tell s2 that main moved: Steer to session s2 did not land: .*\. Steer it to take main in\.$/,
          ),
        );
      } finally {
        errors.mockRestore();
      }
      expect(landedEvents()).toHaveLength(1);
      expect(steerEvents('s2')).toEqual([]);
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

      const outcome = await landMerged();

      expect(landedEvents()).toHaveLength(1);
      expect(steerEvents('s2')).toEqual([]);
      expect(outcome.unsteered).toEqual([
        { sessionId: 's2', reason: expect.stringContaining('its input box is not on screen') },
      ]);
    });

    // Decision 132's batch: the steer still runs under the lock, and the
    // baseline is left for `pup audit`.
    it('steers an overlapping peer when it lands without the audit', async () => {
      seedPeer('s2', 'src/feature.ts');
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
        adapters: [passingAdapter],
        audit: false,
      });

      expect(outcome.audit).toBeUndefined();
      expect(auditProject).not.toHaveBeenCalled();
      expect(getProject(db, pid)?.baseline).toBeNull();
      expect(steerEvents('s2')).toEqual([{ kind: 'main-landed', by: SESSION_ID }]);
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

  // A session can rename the lock away while the land fetches, letting another
  // run take a fresh one: the land refuses before it moves a ref, not at the
  // release (decision 88).
  describe('a lock moved away before its moves (decision 88)', () => {
    let errors: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const lock = join(repo, '.git', 'pup-merge.lock');
      const real = vi.mocked(withScratchGitDir).getMockImplementation() as typeof withScratchGitDir;
      // The fetch's scratch dir, the first under the lock.
      vi.mocked(withScratchGitDir).mockImplementation(((repoPath, prefix, fn) => {
        if (existsSync(lock)) renameSync(lock, `${lock}.moved`);
        return real(repoPath, prefix, fn);
      }) as typeof withScratchGitDir);
    });
    afterEach(() => {
      errors.mockRestore();
      // Back to the real scratch dir the mock wraps.
      vi.mocked(withScratchGitDir).mockReset();
    });

    const mergedOnGitHub = (): void => {
      seedPrMerge();
      const merge = mergeOnGitHub();
      fakeGh({
        state: 'MERGED',
        baseRefName: 'main',
        headRefOid: pinned,
        mergeCommit: { oid: merge },
      });
    };

    it('refuses the fast-forward of main, changing nothing', async () => {
      mergedOnGitHub();
      const before = mainSha();

      await expect(land()).rejects.toThrow('the fast-forward of main was refused');
      expectNothingChanged(before);
      expect(hasTrackingRef()).toBe(false);
      expect(sh(repo, 'git', 'status', '--porcelain', '--untracked-files=no')).toBe('');
    });

    it("refuses the move of origin's main tracking ref when main needs no fast-forward", async () => {
      mergedOnGitHub();
      sh(repo, 'git', 'pull', '-q', '--ff-only', origin, 'main');
      const before = mainSha();

      await expect(land()).rejects.toThrow("the update of origin's main tracking ref was refused");
      expectNothingChanged(before);
      expect(hasTrackingRef()).toBe(false);
    });
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

  // Decision 164's 2026-11-11 amendment: the event names the commits only the operator's word vouched for.
  // Decision 184: one plain line per stage off a terminal, the lock's included.
  it('shows each stage it runs, in order, on its status line', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });
    const lines: string[] = [];

    await landSession(
      db,
      { repoPath: repo, sessionId: SESSION_ID, adapters: [passingAdapter] },
      stageProgress(LAND_STAGES, { write: (chunk) => lines.push(String(chunk)) }),
    );

    expect(lines.map((line) => line.replace(/, \d+s\n$/, ''))).toEqual([
      'stage 1/7, read PR',
      'stage 2/7, merge lock',
      'stage 3/7, fetch',
      'stage 4/7, fast-forward',
      'stage 5/7, tear down',
      'stage 6/7, steer',
      'stage 7/7, audit',
    ]);
  });

  // Its tail was a fixture's git noise (#325): the land prints where the whole
  // of the failed instrumented run is kept instead.
  it('says where it kept the whole output of an instrumented run that failed', async () => {
    vi.stubEnv('HOME', tempDir('pup-land-home-'));
    const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => printed.mockRestore());
    const store = projectPaths(repo).root;
    mkdirSync(store, { recursive: true });
    let script = 'exit 0';
    const covering: Adapter = {
      ...passingAdapter,
      coverage: () => ({ files: {} }),
      coveredTest: () => ({
        command: 'sh',
        args: ['-c', script],
        writablePaths: [],
        report: () => ({ files: { 'src/app.ts': { covered: [1], instrumented: [1, 2] } } }),
        dispose: () => undefined,
      }),
    };
    await initProject(db, repo, [covering]);
    script =
      "echo ' FAIL  src/a.test.ts > adds'; " +
      'i=0; while [ $i -lt 100 ]; do echo "fatal: no merge base found" >&2; i=$((i+1)); done; exit 1';
    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });

    const outcome = await landSession(db, {
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: [covering],
    });

    const kept = join(store, 'test-output.log');
    // The reason reaches a sweep task's goal, which a PR body publishes: the
    // path is a line of its own on the operator's terminal instead.
    expect(outcome.audit?.unmeasured).toEqual([
      'fake: coverage not measured — the instrumented test run failed, so its coverage is not read',
    ]);
    expect(printed).toHaveBeenCalledWith(`The baseline test run failed; full output: ${kept}.`);
    const output = readFileSync(kept, 'utf8');
    expect(output.startsWith('FAIL  src/a.test.ts > adds\n')).toBe(true);
    expect(output.match(/fatal: no merge base found/g)).toHaveLength(100);
  });

  it('records no accepted head nor pin on a gated land', async () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });

    await landSession(db, { repoPath: repo, sessionId: SESSION_ID, adapters: [passingAdapter] });

    expect(landedEvents().map((row) => JSON.parse(row.payload))).toEqual([
      { sha: merge, target: 'main', prUrl: PR_URL },
    ]);
  });

  it('records the accepted head and the pin on the landed event', async () => {
    seedPrMerge();
    const later = commitIn(worktree, 'src/fix.ts', 'export const fix = 1;\n');
    sh(repo, 'git', 'push', '-q', origin, BRANCH);
    sh(origin, 'git', 'update-ref', 'refs/pull/7/head', later);
    const merge = mergeOnGitHub(later);
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: later,
      mergeCommit: { oid: merge },
    });

    await landSession(db, {
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: [passingAdapter],
      acceptHead: later,
    });

    expect(landedEvents().map((row) => JSON.parse(row.payload))).toEqual([
      { sha: merge, target: 'main', prUrl: PR_URL, acceptedHead: later, pinned },
    ]);
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

  // The land fetches, moves main and diffs what landed in the main checkout,
  // where `sub`'s repo is `.git/modules/sub`, under the `.gitmodules` the
  // branch carries and the shared config. Plain git there runs the module's
  // drivers; the land runs none and still sees the bump land (decision 203).
  it('lands a gitlink bump under submodule config the session planted, running nothing it names', async () => {
    const marker = join(tempDir('pup-land-fired-'), 'fired');
    const fire = `sh -c 'echo fired >> ${marker}; cat'`;
    const sub = tempDir('pup-land-sub-');
    sh(sub, 'git', 'init', '-q');
    const before = commitIn(sub, 'app.ts', 'one\n');
    const after = commitIn(sub, 'app.ts', 'two\n');
    // The project's own submodule, named in its `.gitmodules`.
    writeFileSync(join(repo, '.gitmodules'), '[submodule "sub"]\n\tpath = src/sub\n');
    sh(repo, 'git', 'add', '.gitmodules');
    sh(repo, 'git', 'update-index', '--add', '--cacheinfo', `160000,${before},src/sub`);
    const commit = (dir: string, message: string) =>
      sh(dir, 'git', '-c', 'user.email=l@test', '-c', 'user.name=land', 'commit', '-qm', message);
    commit(repo, 'gitlink');
    sh(repo, 'git', 'push', '-q', origin, 'main');
    sh(worktree, 'git', 'reset', '-q', '--hard', 'main');
    sh(worktree, 'git', 'update-index', '--cacheinfo', `160000,${after},src/sub`);
    writeFileSync(
      join(worktree, '.gitmodules'),
      `[submodule "sub"]\n\tpath = src/sub\n\tignore = all\n\tfetchRecurseSubmodules = true\n` +
        `\turl = ext::sh -c touch% ${marker}\n`,
    );
    sh(worktree, 'git', 'add', '.gitmodules');
    commit(worktree, 'bump');
    pinned = sh(worktree, 'git', 'rev-parse', 'HEAD');
    sh(repo, 'git', 'push', '-q', '-f', origin, BRANCH);

    const modules = join(repo, '.git', 'modules');
    mkdirSync(modules);
    renameSync(join(sub, '.git'), join(modules, 'sub'));
    const own = (key: string, value: string) =>
      sh(repo, 'git', 'config', '--file', join(modules, 'sub', 'config'), key, value);
    own('diff.external', fire);
    own('diff.pwn.textconv', fire);
    own('filter.pwn.clean', fire);
    own('core.fsmonitor', fire);
    writeFileSync(join(modules, 'sub', 'info', 'attributes'), '* diff=pwn filter=pwn\n');
    for (const [key, value] of [
      ['submodule.recurse', 'true'],
      ['fetch.recurseSubmodules', 'yes'],
      ['push.recurseSubmodules', 'on-demand'],
      ['diff.submodule', 'diff'],
      ['diff.ignoreSubmodules', 'all'],
      ['status.submoduleSummary', 'true'],
      ['submodule.sub.url', `ext::sh -c touch% ${marker}`],
      ['submodule.sub.update', `!touch ${marker}`],
    ] as const)
      sh(repo, 'git', 'config', key, value);
    sh(repo, 'git', 'diff', '--ignore-submodules=none', `main...${pinned}`, '--', 'src/sub');
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: pinned,
      mergeCommit: { oid: merge },
    });
    const landedOn = mainSha();
    vi.mocked(gitDiffPaths).mockClear();

    await land();

    expect(mainSha()).toBe(merge);
    expect(landedEvents()).toHaveLength(1);
    const landed = vi
      .mocked(gitDiffPaths)
      .mock.calls.findIndex(
        ([path, from, to]) => path === repo && from === landedOn && to === merge,
      );
    expect(vi.mocked(gitDiffPaths).mock.results[landed]?.value).toEqual(['.gitmodules', 'src/sub']);
    expect(existsSync(marker)).toBe(false);
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

  // Decision 185: a PR merged at a head past the pin lands on the gate's word,
  // its stages run again on the merge commit under the lock.
  describe('--remeasure', () => {
    beforeEach(() => {
      // As inside a slot already held, so the stages never queue behind the
      // machine's real test runs (decision 96).
      vi.stubEnv(HELD_SLOT_ENV, 'land.test');
      db.prepare('UPDATE tasks SET spec = ? WHERE id = ?').run(
        JSON.stringify({ id: 'task-s1', goal: 'g', scopeIn: ['src/**'], acceptance: ['a'] }),
        'task-s1',
      );
    });

    /** The stages the pin's gate ran, every one passing. */
    const pinnedStages: GateStageResult[] = ['build', 'test', 'lint', 'scope-audit'].map(
      (stage) => ({ stage, status: 'pass' }),
    );

    /** A passing gate report of `stages`. */
    const passingReport = (stages: GateStageResult[] = pinnedStages): GateReport => ({
      sessionId: SESSION_ID,
      passed: true,
      sandbox: 'none',
      stages,
    });

    /**
     * A commit past the pin, pushed as the PR's head and merged on GitHub at
     * it, the pin's gate having run `stages`.
     */
    function mergeMovedHead(
      path = 'src/fix.ts',
      content = 'export const fix = 1;\n',
      stages = pinnedStages,
    ) {
      seedPrMerge(PR_URL, passingReport(stages));
      return mergeAt(commitIn(worktree, path, content));
    }

    /** `later`, past the pin, pushed as the PR's head and merged on GitHub at it. */
    function mergeAt(later: string) {
      sh(repo, 'git', 'push', '-q', origin, BRANCH);
      sh(origin, 'git', 'update-ref', 'refs/pull/7/head', later);
      const merge = mergeOnGitHub(later);
      fakeGh({
        state: 'MERGED',
        baseRefName: 'main',
        headRefOid: later,
        mergeCommit: { oid: merge },
      });
      return { later, merge };
    }

    const remeasure = (extra: { adapter?: Adapter; approvedBy?: string } = {}) =>
      landSession(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [extra.adapter ?? passingAdapter],
        remeasure: true,
        ...(extra.approvedBy === undefined ? {} : { approvedBy: extra.approvedBy }),
      });

    it('lands a moved head whose remeasure passes, recording the report on the event', async () => {
      const { later, merge } = mergeMovedHead();

      const outcome = await remeasure();

      expect(mainSha()).toBe(merge);
      expect(outcome.remeasure).toMatchObject({ sessionId: SESSION_ID, passed: true });
      expect(outcome.remeasure?.stages.map(({ stage, status }) => [stage, status])).toEqual(
        expect.arrayContaining([
          ['build', 'pass'],
          ['test', 'pass'],
          ['lint', 'pass'],
          ['scope-audit', 'pass'],
        ]),
      );
      const [event] = landedEvents().map((row) => JSON.parse(row.payload));
      expect(event).toEqual({
        sha: merge,
        target: 'main',
        prUrl: PR_URL,
        remeasuredHead: later,
        pinned,
        remeasure: outcome.remeasure,
      });
      expect(existsSync(worktree)).toBe(false);
    });

    it('still refuses the same moved head without it, changing nothing', async () => {
      const { later } = mergeMovedHead();
      const before = mainSha();

      await expect(land()).rejects.toThrow(
        `${PR_URL} merged with its head at ${later}, not ${pinned}, the commit the gate pinned`,
      );
      expectNothingChanged(before);
    });

    it('refuses a remeasure whose stage fails, naming it and changing nothing', async () => {
      mergeMovedHead();
      const before = mainSha();
      const failing: Adapter = {
        ...passingAdapter,
        gateCommands: () => [{ stage: 'build', command: 'false', args: [] }],
      };

      await expect(remeasure({ adapter: failing })).rejects.toThrow(
        /The remeasure of [0-9a-f]{40} against main at [0-9a-f]{40} did not pass:\n {2}build: /,
      );
      expectNothingChanged(before);
      expect(hasTrackingRef()).toBe(false);
    });

    /** Every row of every table in the store. */
    const storeRows = () =>
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);

    /** A 651-line source diff past the pin, over the oversize flag. */
    function mergeOversizeHead(): void {
      const big = Array.from({ length: 650 }, (_, i) => `export const v${i} = ${i};\n`).join('');
      mergeMovedHead('src/big.ts', big);
    }

    /** The session's own gate filing an oversize diff of `lines` as accepted debt. */
    function acceptOversize(lines: number): void {
      insertLedgerEntry(db, {
        projectId: pid,
        description: `Oversize diff (${lines} lines) merged from session ${SESSION_ID}`,
        files: ['src/feature.ts'],
        reason: 'r',
        acceptedBy: 'human',
        reviewBy: 'c',
      });
    }

    it('refuses a flag the session never accepted, leaving the store as it was', async () => {
      mergeOversizeHead();
      const before = mainSha();
      const store = storeRows();

      await expect(remeasure()).rejects.toThrow(
        `flagged, never accepted: Oversize diff (651 lines) merged from session ${SESSION_ID}`,
      );
      expectNothingChanged(before);
      expect(storeRows()).toEqual(store);
    });

    it('refuses a flag worse than the one accepted, and lands one no worse', async () => {
      mergeOversizeHead();
      const before = mainSha();
      acceptOversize(612);

      await expect(remeasure()).rejects.toThrow(
        `flagged past the accepted Oversize diff (612 lines) merged from session ${SESSION_ID}: ` +
          `Oversize diff (651 lines) merged from session ${SESSION_ID}`,
      );
      expectNothingChanged(before);

      // One accepted entry no worse is enough, and an equal figure is no worse.
      acceptOversize(651);
      expect((await remeasure()).remeasure?.passed).toBe(true);
    });

    it('lands a flag better than the one accepted', async () => {
      mergeOversizeHead();
      acceptOversize(700);

      expect((await remeasure()).remeasure?.passed).toBe(true);
    });

    /**
     * One remeasure's stages stood in for: a measurement reporting `stages`,
     * flagging `flags`, over the open ledger entries `held`; a bare description
     * names no file.
     */
    function measuredAs(
      stages: GateStageResult[] = pinnedStages,
      flags: (string | Debt)[] = [],
      held: (string | Debt)[] = [],
    ) {
      const debt = (entry: string | Debt) =>
        typeof entry === 'string' ? { description: entry, files: [] } : entry;
      vi.mocked(measureBranch).mockImplementationOnce(async (_db, _req, _session, reported) => {
        reported.push(...stages);
        return {
          flaggedDebt: flags.map(debt),
          openEntries: held.map(debt).map(({ description, files }) => ({
            description,
            files: typeof files === 'string' ? files : JSON.stringify(files),
          })),
        } as unknown as Awaited<ReturnType<typeof measureBranch>>;
      });
    }

    /** A debt flag or entry; a held entry's `files` as a string is its raw column. */
    type Debt = { description: string; files: string[] | string };

    const filed = (wording: string) => `${wording} session ${SESSION_ID}`;
    const huge = '9'.repeat(400);

    // The land reads the stages itself, not only that a measurement came back,
    // and lands on the statuses it knows only.
    it.each([
      ['fail', /did not pass:\n {2}build: boom\n/],
      ['timeout', /did not pass:\n {2}build: boom\n/],
    ])('refuses a measurement that came back with a %s stage', async (status, refusal) => {
      mergeMovedHead();
      const before = mainSha();
      measuredAs([
        { stage: 'build', status: status as GateStageResult['status'], detail: 'boom' },
        ...pinnedStages.slice(1),
      ]);

      await expect(remeasure()).rejects.toThrow(refusal);
      expectNothingChanged(before);
    });

    it.each([
      [
        'an accepted figure that is no finite number',
        filed('Oversize diff (651 lines) merged from'),
        filed(`Oversize diff (${huge} lines) merged from`),
        'flagged past the accepted',
      ],
      [
        'a flagged figure that is no finite number',
        filed(`Oversize diff (${huge} lines) merged from`),
        filed('Oversize diff (612 lines) merged from'),
        'flagged, its figures unreadable',
      ],
      [
        'a figure only a name supplies, in no wording the gate files',
        filed('Nested thing src/x(10) merged from'),
        filed('Nested thing src/x(9999) merged from'),
        'flagged, its figures unreadable',
      ],
      [
        'a figure worse, the rise it makes with another equal',
        filed('Duplicated lines rose from 120 to 170 in'),
        filed('Duplicated lines rose from 100 to 150 in'),
        'flagged past the accepted',
      ],
      // The gate's own wordings with no figure: every other word is the kind.
      [
        'another nested package missing the script accepted',
        filed('Nested package packages/b changed with no test script, merged from'),
        filed('Nested package packages/a changed with no test script, merged from'),
        'flagged, never accepted',
      ],
      [
        'the nested package accepted missing another script',
        filed('Nested package packages/a changed with no typecheck script, merged from'),
        filed('Nested package packages/a changed with no test script, merged from'),
        'flagged, never accepted',
      ],
      // No stage measured its files, so they are what the operator accepted.
      [
        'the nested package and script accepted, on a file the entry did not name',
        {
          description: filed('Nested package packages/a changed with no test script, merged from'),
          files: ['packages/a/index.ts', 'packages/a/run.ts'],
        },
        {
          description: filed('Nested package packages/a changed with no test script, merged from'),
          files: ['packages/a/index.ts'],
        },
        'or on files it did not name',
      ],
      [
        'a coverage gap wider than the one accepted',
        filed('Coverage gap (unreported files and patch coverage) merged from'),
        filed('Coverage gap (unreported files) merged from'),
        'flagged, never accepted',
      ],
    ])('refuses %s', async (_case, flag, held, refusal) => {
      mergeMovedHead();
      const before = mainSha();
      measuredAs(pinnedStages, [flag], [held]);

      await expect(remeasure()).rejects.toThrow(`${refusal}`);
      expectNothingChanged(before);
    });

    it('refuses a flagged stage that filed no debt, whatever else was flagged', async () => {
      mergeMovedHead();
      const before = mainSha();
      measuredAs(
        [...pinnedStages, { stage: 'complexity', status: 'flagged' }],
        [filed('Oversize diff (651 lines) merged from')],
        [filed('Oversize diff (700 lines) merged from')],
      );

      await expect(remeasure()).rejects.toThrow(
        /did not pass:\n {2}complexity: flagged, with no debt filed for it\n/,
      );
      expectNothingChanged(before);
    });

    it('refuses a stage the pin ran that the remeasure did not', async () => {
      mergeMovedHead();
      const before = mainSha();
      measuredAs(pinnedStages.filter(({ stage }) => stage !== 'lint'));

      await expect(remeasure()).rejects.toThrow(
        /did not pass:\n {2}lint: ran at the pin, absent now\n/,
      );
      expectNothingChanged(before);
    });

    // As when a commit past the pin took the test script away: the stage the
    // pin's gate ran skips on the merge, and nothing measured it.
    it('refuses when the test stage the pin ran skips on the merge', async () => {
      mergeMovedHead();
      const before = mainSha();
      const untested: Adapter = {
        ...passingAdapter,
        gateCommands: (path) =>
          passingAdapter.gateCommands(path).filter(({ stage }) => stage !== 'test'),
      };

      await expect(remeasure({ adapter: untested })).rejects.toThrow(
        /did not pass:\n {2}test: ran at the pin, skipped now\n/,
      );
      expectNothingChanged(before);
    });

    it('refuses a stage flagged at the pin that the remeasure did not run', async () => {
      mergeMovedHead(undefined, undefined, [
        ...pinnedStages,
        { stage: 'diff-size', status: 'flagged' },
      ]);
      const before = mainSha();
      measuredAs(pinnedStages);

      await expect(remeasure()).rejects.toThrow(
        /did not pass:\n {2}diff-size: ran at the pin, absent now\n/,
      );
      expectNothingChanged(before);
    });

    const noPinReport = `No passing gate report into merged is recorded right before the merge of`;

    it('refuses with no passing gate report recorded for the pin', async () => {
      seedPrMerge();
      mergeAt(commitIn(worktree, 'src/fix.ts', 'export const fix = 1;\n'));
      const before = mainSha();

      await expect(remeasure()).rejects.toThrow(
        `${noPinReport} ${pinned}, the commit the gate pinned`,
      );
      expectNothingChanged(before);
    });

    // The report is the last `gate_result` before the merge event naming the
    // pin: what came after it measured something else, or nothing.
    it('holds the merge to the report before the pin, not a failing one after it', async () => {
      const { merge } = mergeMovedHead();
      appendEvent(db, SESSION_ID, 'gate_result', {
        from: 'merged',
        to: 'merged',
        report: { ...passingReport([]), passed: false },
      });
      measuredAs();

      await remeasure();
      expect(mainSha()).toBe(merge);
    });

    /** A `merge` event naming `sha`, as `recordMerge` writes it. */
    const recordPin = (sha: string) =>
      appendEvent(db, SESSION_ID, 'merge', {
        branch: BRANCH,
        sha,
        target: 'main',
        files: ['src/feature.ts'],
        prUrl: PR_URL,
      });

    it("refuses a pin's merge with no report of its own, never borrowing an older pin's", async () => {
      // The older pin's report and merge, then the newer pin's merge alone.
      transitionSession(db, SESSION_ID, 'merged', { report: passingReport() });
      recordPin('a'.repeat(40));
      recordPin(pinned);
      mergeAt(commitIn(worktree, 'src/fix.ts', 'export const fix = 1;\n'));
      const before = mainSha();

      await expect(remeasure()).rejects.toThrow(`${noPinReport} ${pinned}`);
      expectNothingChanged(before);
    });

    // The gate kills the pane and removes the worktree between its report and
    // its merge event; an event another hand writes then carries no report.
    it('reads the report past an event of another type before the merge', async () => {
      transitionSession(db, SESSION_ID, 'merged', { report: passingReport() });
      appendEvent(db, SESSION_ID, 'steer', { kind: 'peer' });
      recordPin(pinned);
      const { merge } = mergeAt(commitIn(worktree, 'src/fix.ts', 'export const fix = 1;\n'));
      measuredAs();

      await remeasure();
      expect(mainSha()).toBe(merge);
    });

    it('holds the merge to the report of the newest merge naming the pin', async () => {
      mergeMovedHead(undefined, undefined, pinnedStages.slice(0, 3));
      // A re-gate re-pinning the same sha, its report listing scope-audit.
      appendEvent(db, SESSION_ID, 'gate_result', {
        from: 'merged',
        to: 'merged',
        report: passingReport(),
      });
      recordPin(pinned);
      const before = mainSha();
      measuredAs(pinnedStages.slice(0, 3));

      await expect(remeasure()).rejects.toThrow(
        /did not pass:\n {2}scope-audit: ran at the pin, absent now\n/,
      );
      expectNothingChanged(before);
    });

    it('holds the merge to the report before the pin, not a passing one after it', async () => {
      mergeMovedHead();
      appendEvent(db, SESSION_ID, 'gate_result', {
        from: 'merged',
        to: 'merged',
        report: passingReport(pinnedStages.filter(({ stage }) => stage !== 'scope-audit')),
      });
      const before = mainSha();
      measuredAs(pinnedStages.filter(({ stage }) => stage !== 'scope-audit'));

      await expect(remeasure()).rejects.toThrow(
        /did not pass:\n {2}scope-audit: ran at the pin, absent now\n/,
      );
      expectNothingChanged(before);
    });

    it('refuses when the report before the pin went into a state other than merged', async () => {
      transitionSession(db, SESSION_ID, 'merged', { report: passingReport() });
      appendEvent(db, SESSION_ID, 'gate_result', {
        from: 'merged',
        to: 'blocked',
        report: passingReport(),
      });
      appendEvent(db, SESSION_ID, 'merge', {
        branch: BRANCH,
        sha: pinned,
        target: 'main',
        files: ['src/feature.ts'],
        prUrl: PR_URL,
      });
      mergeAt(commitIn(worktree, 'src/fix.ts', 'export const fix = 1;\n'));
      const before = mainSha();

      await expect(remeasure()).rejects.toThrow(`${noPinReport} ${pinned}`);
      expectNothingChanged(before);
    });

    it.each([
      ['an empty', [], 'build, test, lint'],
      ['a partial', pinnedStages.filter(({ stage }) => stage !== 'test'), 'test'],
    ])('refuses %s pin report', async (_case, stages, unlisted) => {
      mergeMovedHead(undefined, undefined, stages);
      const before = mainSha();

      await expect(remeasure()).rejects.toThrow(
        `The gate report recorded for ${pinned}, the commit the gate pinned, lists no ` +
          `${unlisted} stage`,
      );
      expectNothingChanged(before);
    });

    it('lands a flag whose every figure is no worse than an accepted one', async () => {
      const { merge } = mergeMovedHead();
      measuredAs(
        [...pinnedStages, { stage: 'coverage', status: 'flagged' }],
        [filed('Coverage gap (patch coverage 61.5% below baseline 70%) merged from')],
        [filed('Coverage gap (patch coverage 60.5% below baseline 70%) merged from')],
      );

      await remeasure();
      expect(mainSha()).toBe(merge);
    });

    // `debtKind` keeps a percentage's dot: `80%` and `79.6%` are one kind here.
    it('lands a coverage gap whose percentages moved between whole and decimal', async () => {
      const { merge } = mergeMovedHead();
      measuredAs(
        [...pinnedStages, { stage: 'coverage', status: 'flagged' }],
        [filed('Coverage gap (patch coverage 80% below baseline 85%) merged from')],
        [filed('Coverage gap (patch coverage 79.6% below baseline 85.3%) merged from')],
      );

      await remeasure();
      expect(mainSha()).toBe(merge);
    });

    // The files of a forged binary are what the operator accepted, not its count.
    it('refuses a forged binary on a file the accepted entry did not name', async () => {
      mergeMovedHead();
      const before = mainSha();
      const wording = filed('Text files git reports as binary (1) merged from');
      measuredAs(
        [...pinnedStages, { stage: 'diff-size', status: 'flagged' }],
        [{ description: wording, files: ['src/cli/foo.ts'] }],
        [{ description: wording, files: ['vendor/bundle.min.js'] }],
      );

      await expect(remeasure()).rejects.toThrow(
        `flagged past the accepted ${wording} or on files it did not name: ${wording}`,
      );
      expectNothingChanged(before);
    });

    // Its wording records no patch coverage, which could have fallen to any figure.
    it('refuses a coverage gap of unreported files and patch coverage on the files accepted', async () => {
      mergeMovedHead();
      const before = mainSha();
      const wording = filed('Coverage gap (unreported files and patch coverage) merged from');
      const files = ['src/a.ts', 'src/b.ts'];
      measuredAs(
        [...pinnedStages, { stage: 'coverage', status: 'flagged' }],
        [{ description: wording, files }],
        [{ description: wording, files }],
      );

      // Its only line: the coverage stage did file debt.
      await expect(remeasure()).rejects.toThrow(
        `did not pass:\n  flagged, its figures unreadable or unrecorded: ${wording}\n` +
          'The session stays merged.',
      );
      expectNothingChanged(before);
    });

    // A JSON string would match a file by substring; it accepts nothing.
    it.each([
      ['a JSON string', '"vendor/a.js"'],
      ['a list holding a number', '["vendor/a", 1]'],
      ['no JSON at all', 'vendor/a'],
    ])('refuses against an entry whose files are %s', async (_case, files) => {
      mergeMovedHead();
      const before = mainSha();
      const wording = filed('Text files git reports as binary (1) merged from');
      measuredAs(
        [...pinnedStages, { stage: 'diff-size', status: 'flagged' }],
        [{ description: wording, files: ['vendor/a'] }],
        [{ description: wording, files }],
      );

      await expect(remeasure()).rejects.toThrow(`flagged, never accepted: ${wording}`);
      expectNothingChanged(before);
    });

    it('lands a forged binary on a file the accepted entry named', async () => {
      const { merge } = mergeMovedHead();
      const wording = filed('Text files git reports as binary (1) merged from');
      measuredAs(
        [...pinnedStages, { stage: 'diff-size', status: 'flagged' }],
        [{ description: wording, files: ['vendor/a.js'] }],
        [{ description: wording, files: ['vendor/a.js', 'vendor/b.js'] }],
      );

      await remeasure();
      expect(mainSha()).toBe(merge);
    });

    // The gate runs these two on the session's worktree; a remeasure has none.
    it('lands when the pin passed worktree-clean and fresh-base, which it cannot rerun', async () => {
      const { merge } = mergeMovedHead('src/fix.ts', 'export const fix = 1;\n', [
        { stage: 'worktree-clean', status: 'pass' },
        { stage: 'fresh-base', status: 'pass' },
        ...pinnedStages,
      ]);

      await remeasure();
      expect(mainSha()).toBe(merge);
    });

    /** Stands in for the stages, running the real ones, then `meanwhile`. */
    function whileMeasuring(meanwhile: () => void): void {
      const real = vi.mocked(measureBranch).getMockImplementation();
      vi.mocked(measureBranch).mockImplementationOnce(async (...args) => {
        const measured = await real?.(...args);
        meanwhile();
        return measured;
      });
    }

    // The main checkout would hold another PR's change, or this merge's own, in
    // place of the merge's base, so "before" is read from a checkout of the
    // base (decision 198). Each case's file differs between the two.
    it.each([
      [
        'behind it, another PR merged on GitHub first',
        'src/other.ts',
        'export const other = 1;\n',
        () => {
          const clone = cloneOrigin();
          commitIn(clone, 'src/other.ts', 'export const other = 1;\n');
          sh(clone, 'git', 'push', '-q', 'origin', 'HEAD:main');
          // A fix round that took in its target, so GitHub's merge is of its tree.
          sh(worktree, 'git', 'fetch', '-q', origin, 'main');
          sh(
            worktree,
            'git',
            '-c',
            'user.email=t@t',
            '-c',
            'user.name=t',
            'merge',
            '-q',
            'FETCH_HEAD',
          );
          // Past the pin, a change to the file the other PR added.
          seedPrMerge(PR_URL, passingReport());
          return mergeAt(commitIn(worktree, 'src/other.ts', 'export const other = 2;\n'));
        },
      ],
      [
        'past it, holding the merge already',
        'src/app.ts',
        'export const app = 1;\n',
        () => {
          const moved = mergeMovedHead('src/app.ts', 'export const app = 2;\n');
          sh(repo, 'git', 'fetch', '-q', origin, 'main');
          sh(repo, 'git', 'merge', '-q', '--ff-only', moved.merge);
          return moved;
        },
      ],
    ])(
      'lands with local main %s, reading "before" at the base',
      async (_case, path, atBase, mergeOff) => {
        const { merge } = mergeOff();
        const base = sh(origin, 'git', 'rev-parse', `${merge}^1`);
        const beforeReads: { dir: string; content: string | undefined }[] = [];
        const measuring: Adapter = {
          ...passingAdapter,
          complexity: ({ measurePath, measureSha }, files) => {
            if (measureSha === base) {
              const at = join(measurePath, path);
              beforeReads.push({
                dir: measurePath,
                content: existsSync(at) ? readFileSync(at, 'utf8') : undefined,
              });
            }
            return files.map((file) => ({ file, complexity: 1 }));
          },
        };

        const outcome = await remeasure({ adapter: measuring });

        expect(mainSha()).toBe(merge);
        expect(outcome.remeasure?.passed).toBe(true);
        expect(beforeReads.map(({ content }) => content)).toEqual([atBase]);
        expect(beforeReads[0]?.dir).not.toBe(repo);
        // Removed after, and its registration pruned with it.
        expect(existsSync(beforeReads[0]?.dir ?? '')).toBe(false);
        expect(sh(repo, 'git', 'worktree', 'list', '--porcelain')).not.toContain(
          beforeReads[0]?.dir,
        );
      },
    );

    it('measures "before" before any stage runs the session\'s code', async () => {
      const { merge } = mergeMovedHead('src/app.ts', 'export const app = 2;\n');
      const base = sh(origin, 'git', 'rev-parse', `${merge}^1`);
      const reads: { before: boolean; built: boolean; content: string }[] = [];
      const rewriting: Adapter = {
        ...passingAdapter,
        gateCommands: () => [
          // Marks that it ran, then rewrites "before" beside it, where no sandbox stops it.
          {
            stage: 'build',
            command: 'sh',
            args: [
              '-c',
              'touch built; printf "export const app = 99;\\n" > "$PWD-target/src/app.ts"; true',
            ],
          },
          { stage: 'test', command: 'true', args: [] },
          { stage: 'lint', command: 'true', args: [] },
        ],
        complexity: ({ measurePath, measureSha }, files) => {
          const before = measureSha === base;
          reads.push({
            before,
            built: existsSync(
              join(before ? measurePath.replace(/-target$/, '') : measurePath, 'built'),
            ),
            content: readFileSync(join(measurePath, 'src/app.ts'), 'utf8'),
          });
          return files.map((file) => ({ file, complexity: 1 }));
        },
      };

      await remeasure({ adapter: rewriting });

      expect(reads).toEqual([
        { before: true, built: false, content: 'export const app = 1;\n' },
        { before: false, built: true, content: 'export const app = 2;\n' },
      ]);
    });

    it('flags a rise against the base, not against local main holding the merge', async () => {
      const moved = mergeMovedHead('src/app.ts', 'export const app = 40;\n');
      sh(repo, 'git', 'fetch', '-q', origin, 'main');
      sh(repo, 'git', 'merge', '-q', '--ff-only', moved.merge);
      const before = mainSha();
      // A file's figure is the number it exports: 1 at the base, 40 merged.
      const counting: Adapter = {
        ...passingAdapter,
        complexity: ({ measurePath }, files) =>
          files
            .filter((file) => existsSync(join(measurePath, file)))
            .map((file) => ({
              file,
              complexity: Number(
                /= (\d+)/.exec(readFileSync(join(measurePath, file), 'utf8'))?.[1],
              ),
            })),
      };

      await expect(remeasure({ adapter: counting })).rejects.toThrow(
        `flagged, never accepted: Complexity rise (+39 decision points) merged from session ${SESSION_ID}`,
      );
      expectNothingChanged(before);
    });

    /** Another PR merged on GitHub first, committing `path` as `content`, and a fix round took it in. */
    function baseHolds(path: string, content: string) {
      const clone = cloneOrigin();
      commitIn(clone, path, content);
      sh(clone, 'git', 'push', '-q', 'origin', 'HEAD:main');
      sh(worktree, 'git', 'fetch', '-q', origin, 'main');
      sh(worktree, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', 'FETCH_HEAD');
    }

    /**
     * The base holds `package-lock.json` as `content` (`baseHolds`); then local
     * main fast-forwarded onto the merge of a head past the pin that wrote
     * `path` as `later`, and an environment installed in the main checkout,
     * untracked.
     */
    function mergeOverLockfile(content: string, path: string, later: string) {
      baseHolds('package-lock.json', content);
      const moved = mergeMovedHead(path, later);
      sh(repo, 'git', 'fetch', '-q', origin, 'main');
      sh(repo, 'git', 'merge', '-q', '--ff-only', moved.merge);
      mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
      return moved;
    }

    const lockfileV1 = '{"lockfileVersion": 1}\n';
    const notFromBase = /was not installed from the lockfile [0-9a-f]{40} holds there, /;

    it.each([
      {
        name: 'a working-tree lockfile the base does not hold',
        path: 'src/app.ts',
        content: 'export const app = 2;\n',
        alter: () => writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion": 2}\n'),
        reason: notFromBase,
      },
      {
        name: 'a lockfile that links to the bytes the base holds',
        path: 'src/app.ts',
        content: 'export const app = 2;\n',
        alter: () => {
          writeFileSync(join(repo, 'lock-copy.json'), lockfileV1);
          rmSync(join(repo, 'package-lock.json'));
          symlinkSync('lock-copy.json', join(repo, 'package-lock.json'));
        },
        reason: notFromBase,
      },
      {
        name: 'committed node_modules files the base does not hold',
        path: 'node_modules/dep/index.js',
        content: 'module.exports = 1;\n',
        alter: () => {},
        reason: /holds other committed files than [0-9a-f]{40} does, /,
      },
    ])('refuses to measure with an environment beside $name', async (environment) => {
      mergeOverLockfile(lockfileV1, environment.path, environment.content);
      environment.alter();
      const before = mainSha();
      const measured: string[] = [];
      const recording: Adapter = {
        ...passingAdapter,
        gateCommands: (path) => {
          measured.push(path);
          return passingAdapter.gateCommands(path);
        },
      };

      const refusal = remeasure({ adapter: recording });
      await expect(refusal).rejects.toThrow(/^node_modules in the main checkout /);
      await expect(refusal).rejects.toThrow(environment.reason);
      await expect(refusal).rejects.toThrow(/Nothing was landed\.$/);
      expect(measured).toEqual([]);
      expectNothingChanged(before);
    });

    const adapterRefusal =
      'path(s) that decide which adapters measure the merge or what they run otherwise than';

    it.each([
      '.pupitre/adapter.yml',
      '.Pupitre/adapter.yml',
      'package.json',
      'Package.json',
      'package-lock.json',
      'uv.lock',
      // A file under each protected path but `.claude/**`, which no adapter reads.
      ...PROTECTED_PATH_GLOBS.filter((glob) => glob !== '.claude/**').map((glob) =>
        glob.replace(/\*+/g, 'x'),
      ),
    ])('refuses when local main holds a %s the base does not', async (path) => {
      const moved = mergeMovedHead(path, '{}\n');
      sh(repo, 'git', 'fetch', '-q', origin, 'main');
      sh(repo, 'git', 'merge', '-q', '--ff-only', moved.merge);
      const before = mainSha();
      const measured: string[] = [];
      const recording: Adapter = {
        ...passingAdapter,
        gateCommands: (at) => {
          measured.push(at);
          return passingAdapter.gateCommands(at);
        },
      };

      const refusal = remeasure({ adapter: recording });
      await expect(refusal).rejects.toThrow(`holds 1 ${adapterRefusal}`);
      await expect(refusal).rejects.toThrow(`or as a link (${path}).`);
      expect(measured).toEqual([]);
      expectNothingChanged(before);
    });

    /** What is staged in the worktree, committed; the new HEAD sha. */
    function commitStaged(): string {
      sh(
        worktree,
        'git',
        '-c',
        'user.email=l@test',
        '-c',
        'user.name=land',
        'commit',
        '-q',
        '-m',
        'link',
      );
      return sh(worktree, 'git', 'rev-parse', 'HEAD');
    }

    /** `file` committed in the worktree, then `path` as a link to `target`; the new HEAD sha. */
    function commitLink(path: string, target: string, file: string): string {
      commitIn(worktree, file, '{}\n');
      symlinkSync(target, join(worktree, path));
      sh(worktree, 'git', 'add', '--', path);
      return commitStaged();
    }

    it.each([
      {
        // The diff names neither `.pupitre/**` path, only `.pupitre` and `cfg/adapter.yml`.
        name: '`.pupitre` linked to a `cfg` holding `adapter.yml`',
        named: '.pupitre',
        commit: () => commitLink('.pupitre', 'cfg', 'cfg/adapter.yml'),
      },
      {
        name: '`.PUPITRE` linked to a `cfg` holding `adapter.yml`',
        named: '.PUPITRE',
        commit: () => commitLink('.PUPITRE', 'cfg', 'cfg/adapter.yml'),
      },
      {
        name: "the base's `package.json` turned into a link",
        named: 'package.json',
        commit: () => {
          baseHolds('package.json', '{}\n');
          rmSync(join(worktree, 'package.json'));
          return commitLink('package.json', 'cfg/package.json', 'cfg/package.json');
        },
      },
      {
        name: 'a submodule at `.pupitre`',
        named: '.pupitre',
        commit: () => {
          const gitlink = `160000,${sh(worktree, 'git', 'rev-parse', 'HEAD')},.pupitre`;
          sh(worktree, 'git', 'update-index', '--add', '--cacheinfo', gitlink);
          return commitStaged();
        },
      },
    ])('refuses when local main commits $name', async (link) => {
      seedPrMerge(PR_URL, passingReport(pinnedStages));
      const moved = mergeAt(link.commit());
      sh(repo, 'git', 'fetch', '-q', origin, 'main');
      sh(repo, 'git', 'merge', '-q', '--ff-only', moved.merge);
      const before = mainSha();
      const measured: string[] = [];
      const recording: Adapter = {
        ...passingAdapter,
        gateCommands: (at) => {
          measured.push(at);
          return passingAdapter.gateCommands(at);
        },
      };

      const refusal = remeasure({ adapter: recording });
      await expect(refusal).rejects.toThrow(`holds 1 ${adapterRefusal}`);
      await expect(refusal).rejects.toThrow(`or as a link (${link.named}).`);
      expect(measured).toEqual([]);
      expectNothingChanged(before);
    });

    // No adapter reads `.claude/`, so a link a repo commits there refuses nothing.
    it('lands when local main commits a link under `.claude`', async () => {
      const clone = cloneOrigin();
      commitIn(clone, '.agents/skills/a.md', 'skill\n');
      mkdirSync(join(clone, '.claude'));
      symlinkSync('../.agents/skills', join(clone, '.claude', 'skills'));
      sh(clone, 'git', 'add', '--', '.claude/skills');
      sh(clone, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'link');
      sh(clone, 'git', 'push', '-q', 'origin', 'HEAD:main');
      sh(worktree, 'git', 'fetch', '-q', origin, 'main');
      sh(worktree, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', 'FETCH_HEAD');
      const moved = mergeMovedHead();
      sh(repo, 'git', 'fetch', '-q', origin, 'main');
      sh(repo, 'git', 'merge', '-q', '--ff-only', moved.merge);

      await remeasure();

      expect(mainSha()).toBe(moved.merge);
    });

    it("removes the toolchain cache a capability's child keyed on the stand-in", async () => {
      const { merge } = mergeMovedHead();
      const cacheRoot = join(realpathSync(tmpdir()), TOOLCHAIN_CACHE_DIRNAME);
      const removing = () =>
        existsSync(cacheRoot)
          ? readdirSync(cacheRoot).filter((name) => name.startsWith('pup-removing-'))
          : [];
      const removingBefore = removing();
      const caches: string[] = [];
      const recording: Adapter = {
        ...passingAdapter,
        complexity: async ({ measurePath, configPath }, files) => {
          await runGateChild('true', [], { cwd: measurePath, repoPath: configPath });
          const cache = join(cacheRoot, projectId(configPath));
          if (configPath.endsWith('-target') && existsSync(cache)) caches.push(cache);
          return files.map((file) => ({ file, complexity: 1 }));
        },
      };

      await remeasure({ adapter: recording });

      expect(mainSha()).toBe(merge);
      expect(caches.length).toBeGreaterThan(0);
      expect(caches.filter((cache) => existsSync(cache))).toEqual([]);
      expect(removing().filter((name) => !removingBefore.includes(name))).toEqual([]);
    });

    it('reads the gate config from the base, not local main holding the merge', async () => {
      // The main checkout's environment, installed from the lockfile the base
      // holds, which the base's checkout lacks.
      const moved = mergeOverLockfile(
        '{"lockfileVersion": 1}\n',
        'src/app.ts',
        'export const app = 2;\n',
      );
      const configs: string[] = [];
      const linked: boolean[] = [];
      const configAt = (path: string) => readFileSync(join(path, 'src/app.ts'), 'utf8');
      const recording: Adapter = {
        ...passingAdapter,
        gateCommands: (path) => {
          configs.push(`commands: ${configAt(path)}`);
          return passingAdapter.gateCommands(path);
        },
        complexity: ({ configPath }, files) => {
          configs.push(`complexity: ${configAt(configPath)}`);
          return files.map((file) => ({ file, complexity: 1 }));
        },
        // The gate checkout's environment links the stand-in's, which holds the main checkout's.
        testInputsIntact: ({ measurePath, configPath }) => {
          const entry = join(measurePath, 'node_modules', 'dep');
          linked.push(
            readlinkSync(entry) === join(configPath, 'node_modules', 'dep') &&
              realpathSync(entry) === realpathSync(join(repo, 'node_modules', 'dep')),
          );
          return true;
        },
      };

      await remeasure({ adapter: recording });

      expect(mainSha()).toBe(moved.merge);
      expect(configs).toEqual([
        'complexity: export const app = 1;\n',
        'commands: export const app = 1;\n',
        'complexity: export const app = 1;\n',
        // The audit after the land reads the main checkout as it now is.
        'commands: export const app = 2;\n',
      ]);
      expect(linked.length).toBeGreaterThan(0);
      expect(linked).not.toContain(false);
    });

    it('refuses when the local target moved while the stages ran', async () => {
      mergeMovedHead();
      whileMeasuring(() => commitIn(repo, 'NOTES.md', 'moved under the remeasure\n'));

      await expect(remeasure()).rejects.toThrow(
        /While the remeasure ran, local main moved from [0-9a-f]{40}\. .*Nothing was landed/,
      );
      expect(landedEvents()).toEqual([]);
      expect(existsSync(worktree)).toBe(true);
    });

    // Origin moving on keeps the measured tip in its history: that tip lands.
    it('lands the tip it fetched when origin moved on while the stages ran', async () => {
      const { merge } = mergeMovedHead();
      whileMeasuring(() => {
        const next = sh(
          origin,
          'git',
          '-c',
          'user.email=gh@test',
          '-c',
          'user.name=github',
          'commit-tree',
          `${merge}^{tree}`,
          '-p',
          merge,
          '-m',
          'Another PR',
        );
        sh(origin, 'git', 'update-ref', 'refs/heads/main', next);
      });

      await remeasure();

      expect(mainSha()).toBe(merge);
      expect(sh(repo, 'git', 'rev-parse', 'refs/remotes/origin/main')).toBe(merge);
      expect(JSON.parse(landedEvents()[0]?.payload ?? '{}')).toMatchObject({ sha: merge });
    });

    it('refuses when origin was rewound while the stages ran', async () => {
      const { merge } = mergeMovedHead();
      const before = mainSha();
      whileMeasuring(() =>
        sh(
          origin,
          'git',
          'update-ref',
          'refs/heads/main',
          sh(origin, 'git', 'rev-parse', `${merge}^1`),
        ),
      );

      await expect(remeasure()).rejects.toThrow(
        `While the remeasure ran, origin's main no longer holds ${merge}.`,
      );
      expectNothingChanged(before);
    });

    // Listed with `--no-renames`, as the scope audit lists them: a file moved
    // out of a critical area changed that area.
    it('takes a file renamed out of a critical area as a change to that area', async () => {
      pinned = commitIn(worktree, 'src/core/land-old.ts', 'export const old = 1;\n');
      sh(repo, 'git', 'push', '-q', origin, BRANCH);
      seedPrMerge();
      sh(worktree, 'git', 'mv', 'src/core/land-old.ts', 'src/old.ts');
      sh(
        worktree,
        'git',
        '-c',
        'user.email=l@test',
        '-c',
        'user.name=land',
        'commit',
        '-qm',
        'out',
      );
      mergeAt(sh(worktree, 'git', 'rev-parse', 'HEAD'));
      const before = mainSha();

      await expect(remeasure()).rejects.toThrow(
        'change 1 file(s) in a critical area (src/core/land-old.ts)',
      );
      expectNothingChanged(before);
    });

    // From their merge-base the head would show no change: it kept one the pin
    // had already changed back.
    it('refuses a critical-area change a head off an older commit kept', async () => {
      const kept = commitIn(worktree, 'src/core/land-x.ts', 'export const x = 1;\n');
      pinned = commitIn(worktree, 'src/core/land-x.ts', 'export const x = 2;\n');
      sh(repo, 'git', 'push', '-q', origin, BRANCH);
      seedPrMerge();
      sh(worktree, 'git', 'reset', '-q', '--hard', kept);
      const later = commitIn(worktree, 'src/fix.ts', 'export const fix = 1;\n');
      sh(repo, 'git', 'push', '-q', '-f', origin, BRANCH);
      mergeAt(later);
      const before = mainSha();

      await expect(remeasure()).rejects.toThrow(
        'change 1 file(s) in a critical area (src/core/land-x.ts)',
      );
      expectNothingChanged(before);
    });

    // The pin and the head hold the same file there, so `<pin>..<head>` shows
    // none: only the merge, from the head's older base, brings it back.
    /** Commits on the target take no `.worktrees/` gitlink, which `commitIn`'s `add .` would. */
    const excludeWorktrees = () =>
      writeFileSync(join(repo, '.git', 'info', 'exclude'), '.worktrees/\n');

    it('refuses a head off an older base that brings back a critical file the target reverted', async () => {
      excludeWorktrees();
      const older = mainSha();
      commitIn(repo, 'src/core/land-x.ts', 'export const x = 1;\n');
      sh(repo, 'git', 'push', '-q', origin, 'main');
      sh(worktree, 'git', 'reset', '-q', '--hard', 'main');
      pinned = commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
      sh(repo, 'git', 'push', '-q', '-f', origin, BRANCH);
      seedPrMerge(PR_URL, passingReport(pinnedStages));
      sh(repo, 'git', 'rm', '-q', 'src/core/land-x.ts');
      sh(repo, 'git', '-c', 'user.email=l@test', '-c', 'user.name=land', 'commit', '-qm', 'revert');
      sh(repo, 'git', 'push', '-q', origin, 'main');
      sh(worktree, 'git', 'reset', '-q', '--hard', older);
      // Not the target's commit adding it again: in the same second that would
      // be the same commit, and the head would descend from it.
      commitIn(worktree, 'src/fix.ts', 'export const fix = 1;\n');
      const later = commitIn(worktree, 'src/core/land-x.ts', 'export const x = 1;\n');
      sh(repo, 'git', 'push', '-q', '-f', origin, BRANCH);
      expect(sh(repo, 'git', 'diff', '--name-only', pinned, later)).not.toContain('land-x');
      mergeAt(later);
      const before = mainSha();

      await expect(remeasure()).rejects.toThrow(
        'change 1 file(s) in a critical area (src/core/land-x.ts)',
      );
      expectNothingChanged(before);
    });

    it('asks for --approved-by when the pin no longer merges cleanly onto the target', async () => {
      excludeWorktrees();
      seedPrMerge(PR_URL, passingReport(pinnedStages));
      commitIn(repo, 'src/feature.ts', 'export const feature = 2;\n');
      sh(repo, 'git', 'push', '-q', origin, 'main');
      const landedOn = mainSha();
      sh(worktree, 'git', 'reset', '-q', '--hard', 'main');
      const later = commitIn(worktree, 'src/fix.ts', 'export const fix = 1;\n');
      sh(repo, 'git', 'push', '-q', '-f', origin, BRANCH);
      mergeAt(later);

      await expect(remeasure()).rejects.toThrow(
        `Merging ${pinned}, the commit the gate pinned, onto ${landedOn}, the commit the merge of ` +
          `${PR_URL} went onto, conflicted or failed`,
      );
      expectNothingChanged(landedOn);
    });

    it('refuses a critical-area change without --approved-by, before any stage runs', async () => {
      mergeMovedHead('src/core/land.service.ts');
      const before = mainSha();
      const failing: Adapter = {
        ...passingAdapter,
        gateCommands: () => [{ stage: 'build', command: 'false', args: [] }],
      };

      await expect(remeasure({ adapter: failing })).rejects.toThrow(
        /change 1 file\(s\) in a critical area \(src\/core\/land\.service\.ts\); .*`--remeasure --approved-by <who>`/,
      );
      expectNothingChanged(before);
    });

    it('lands a critical-area change on --approved-by, recording the approver', async () => {
      const { merge } = mergeMovedHead('src/core/land.service.ts');

      await remeasure({ approvedBy: 'tg:alexis' });

      expect(mainSha()).toBe(merge);
      expect(JSON.parse(landedEvents()[0]?.payload ?? '{}')).toMatchObject({
        approvedBy: 'tg:alexis',
      });
    });

    it('refuses a PR merged at the pin: there is nothing to remeasure', async () => {
      seedPrMerge();
      const merge = mergeOnGitHub();
      fakeGh({
        state: 'MERGED',
        baseRefName: 'main',
        headRefOid: pinned,
        mergeCommit: { oid: merge },
      });
      const before = mainSha();

      await expect(remeasure()).rejects.toThrow('there is nothing to remeasure');
      expectNothingChanged(before);
    });

    // Without the audit the empty adapter list reaches the remeasure's own check.
    it('refuses a remeasure with no adapter to measure with', async () => {
      mergeMovedHead();
      const before = mainSha();

      await expect(
        landSession(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [],
          audit: false,
          remeasure: true,
        }),
      ).rejects.toThrow(
        `No adapter for ${repo}; the remeasure would measure nothing. Nothing was landed.`,
      );
      expectNothingChanged(before);
    });

    it('refuses --remeasure together with --accept-head', async () => {
      const { later } = mergeMovedHead();
      const before = mainSha();

      await expect(
        landSession(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [passingAdapter],
          remeasure: true,
          acceptHead: later,
        }),
      ).rejects.toThrow('--remeasure and --accept-head each vouch for a moved head; pass one.');
      expectNothingChanged(before);
    });

    // Each gate wording read back, its stage the one that files it.
    it.each([
      ['Text files git reports as binary (3) merged from', 'diff-size'],
      ['New unused exports (2) merged from', 'dead-code'],
      ['Complexity rise (+20 decision points) merged from', 'complexity'],
      ['Coverage unmeasured over 2 changed source file(s) in', 'coverage'],
      ['Coverage gap (unreported files) merged from', 'coverage'],
      ['Nested package packages/a changed with no test script, merged from', 'test (packages/a)'],
    ])('lands "%s" flagged by %s against the same accepted', async (wording, stage) => {
      const { merge } = mergeMovedHead();
      measuredAs(
        [...pinnedStages, { stage, status: 'flagged' }],
        [filed(wording)],
        [filed(wording)],
      );

      await remeasure();
      expect(mainSha()).toBe(merge);
    });
  });
});
