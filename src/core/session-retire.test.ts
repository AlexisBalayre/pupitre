import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No tmux here: the test asks only whether, and when, the window was stopped.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  killSession: vi.fn(),
}));

import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { killSession } from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { projectId } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  insertSession,
  insertTask,
  listEvents,
  saveProjectOriginUrl,
  transitionSession,
  transitionSessionAlong,
} from './session.repository.js';
import { retireSession } from './session-retire.service.js';
import { FIX_ROUND_EDGE } from './session-state.utils.js';
import {
  assertStillMerged,
  assertUnlockedWorktree,
  deleteBranchIfHeld,
  isRegisteredWorktree,
  pinnedPullRequest,
} from './session-teardown.service.js';

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
  writeFileSync(join(dir, file), content);
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', '-c', 'user.email=r@test', '-c', 'user.name=retire', 'commit', '-q', '-m', file);
  return sh(dir, 'git', 'rev-parse', 'HEAD');
}

const SESSION_ID = 's1';
const BRANCH = `pup/${SESSION_ID}`;
const ORIGIN_URL = 'git@github.com:owner/repo.git';
const PR_URL = 'https://github.com/owner/repo/pull/7';
const SUPERSEDING_URL = 'https://github.com/owner/repo/pull/9';
const PANE = '%42';

const closed = { state: 'CLOSED', baseRefName: 'main', headRefOid: 'a'.repeat(40) };
const merged = {
  state: 'MERGED',
  baseRefName: 'main',
  headRefOid: 'b'.repeat(40),
  mergeCommit: { oid: 'c'.repeat(40) },
};

describe('retireSession', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;
  let worktree: string;
  /** The commit the gate pinned and the closed PR carried: the branch tip. */
  let pinned: string;
  let ghLog: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = tempDir('pup-retire-repo-');
    sh(repo, 'git', 'init', '-q', '-b', 'main');
    commitIn(repo, 'app.ts', 'export const app = 1;\n');
    sh(repo, 'git', 'remote', 'add', 'origin', ORIGIN_URL);
    const pid = projectId(repo);
    ensureProject(db, pid, repo);
    saveProjectOriginUrl(db, pid, ORIGIN_URL);
    insertTask(db, { id: 'task-s1', projectId: pid, spec: '{}' });
    worktree = join(repo, '.worktrees', SESSION_ID);
    sh(repo, 'git', 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'HEAD');
    pinned = commitIn(worktree, 'feature.ts', 'export const feature = 1;\n');
    insertSession(db, {
      id: SESSION_ID,
      taskId: 'task-s1',
      worktreePath: worktree,
      branch: BRANCH,
      profileHash: 'hash',
      tmuxTarget: PANE,
    });
    transitionSession(db, SESSION_ID, 'running');
    transitionSession(db, SESSION_ID, 'awaiting-review');
    vi.mocked(killSession).mockReset();
    ghLog = join(tempDir('pup-retire-gh-log-'), 'gh-calls');
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  /** What the gate's `--pr` merge leaves: the session merged, its PR on the event. */
  function seedPrMerge(prUrl: string | null = PR_URL): void {
    transitionSession(db, SESSION_ID, 'merged');
    appendEvent(db, SESSION_ID, 'merge', {
      branch: BRANCH,
      sha: pinned,
      target: 'main',
      files: ['feature.ts'],
      ...(prUrl === null ? {} : { prUrl }),
    });
  }

  /** A gh on PATH that records its argv and answers `pr view` of #7 and of any other PR. */
  function fakeGh(own: unknown, other: unknown = merged): void {
    const dir = tempDir('pup-retire-gh-');
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${ghLog}\n` +
        `case "$*" in\n  */pull/7\\ *) echo '${JSON.stringify(own)}' ;;\n` +
        `  *) echo '${JSON.stringify(other)}' ;;\nesac\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${originalPath}`;
  }

  /** A gh that answers `--version` and fails every other call, as an outage or a lapsed login does. */
  function failingGh(): void {
    const dir = tempDir('pup-retire-gh-');
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${ghLog}\n` +
        `[ "$1" = --version ] && exit 0\necho 'gh: HTTP 502' >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${originalPath}`;
  }

  /** Retire, waiting on a merge lock this test holds, while `meanwhile` runs and the lock goes. */
  async function retireWhileLockHeld(meanwhile: () => void): Promise<unknown> {
    const lock = join(repo, '.git', 'pup-merge.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
    setTimeout(() => {
      meanwhile();
      rmSync(lock, { recursive: true });
    }, 200);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      return await retireSession(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        supersededBy: SUPERSEDING_URL,
      });
    } finally {
      errors.mockRestore();
    }
  }

  const retire = (supersededBy = SUPERSEDING_URL, sessionId = SESSION_ID) =>
    retireSession(db, { repoPath: repo, sessionId, supersededBy });
  const retiredEvents = () => listEvents(db, SESSION_ID).filter((row) => row.type === 'retired');
  const hasBranch = () => sh(repo, 'git', 'branch', '--list', BRANCH) !== '';

  /** Nothing a refusal may touch moved. */
  function expectNothingChanged(): void {
    expect(existsSync(worktree)).toBe(true);
    expect(hasBranch()).toBe(true);
    expect(retiredEvents()).toEqual([]);
    expect(killSession).not.toHaveBeenCalled();
  }

  it("stops the session's window by its name while its worktree still stands", async () => {
    seedPrMerge();
    fakeGh(closed);
    const worktreeAtKill: boolean[] = [];
    vi.mocked(killSession).mockImplementation(() => {
      worktreeAtKill.push(existsSync(worktree));
    });

    await retire();

    expect(killSession).toHaveBeenCalledWith(SESSION_ID);
    expect(worktreeAtKill).toEqual([true]);
    expect(existsSync(worktree)).toBe(false);
  });

  // The row's %42 is the pane the session launched in; after a tmux server
  // restart that id can be any other session's pane, the operator's included.
  it('never kills by the stored pane id, which a restarted tmux may have reissued', async () => {
    seedPrMerge();
    fakeGh(closed);

    await retire();

    expect(vi.mocked(killSession).mock.calls).toEqual([[SESSION_ID]]);
    expect(JSON.stringify(vi.mocked(killSession).mock.calls)).not.toContain(PANE);
  });

  it('removes the worktree and the branch and records the superseding PR', async () => {
    seedPrMerge();
    fakeGh(closed);

    const outcome = await retire();

    expect(outcome).toEqual({
      prUrl: PR_URL,
      supersededBy: SUPERSEDING_URL,
      removedWorktree: true,
    });
    expect(existsSync(worktree)).toBe(false);
    expect(hasBranch()).toBe(false);
    expect(retiredEvents().map((row) => JSON.parse(row.payload))).toEqual([
      { prUrl: PR_URL, supersededBy: SUPERSEDING_URL },
    ]);
    const calls = readFileSync(ghLog, 'utf8');
    expect(calls).toContain(`pr view ${PR_URL} --repo github.com/owner/repo`);
    expect(calls).toContain(`pr view ${SUPERSEDING_URL} --repo github.com/owner/repo`);
  });

  it("reads a bare or #-prefixed number as a PR of the session's own repo", async () => {
    seedPrMerge();
    fakeGh(closed);

    const outcome = await retire('#9');

    expect(outcome.supersededBy).toBe(SUPERSEDING_URL);
  });

  it('finishes what an earlier teardown left: no worktree, no branch', async () => {
    seedPrMerge();
    fakeGh(closed);
    sh(repo, 'git', 'worktree', 'remove', '--force', worktree);
    sh(repo, 'git', 'branch', '-D', BRANCH);

    const outcome = await retire('9');

    expect(outcome.removedWorktree).toBe(false);
    expect(outcome.keptBranch).toBeUndefined();
    expect(retiredEvents()).toHaveLength(1);
  });

  it('keeps a branch holding commits past the sha its PR carried', async () => {
    seedPrMerge();
    fakeGh(closed);
    commitIn(worktree, 'later.ts', 'export const later = 1;\n');

    const outcome = await retire();

    expect(outcome).toMatchObject({ removedWorktree: true, keptBranch: BRANCH });
    expect(existsSync(worktree)).toBe(false);
    expect(hasBranch()).toBe(true);
    expect(retiredEvents()).toHaveLength(1);
  });

  it('refuses an unknown session', async () => {
    await expect(retire(SUPERSEDING_URL, 'nope')).rejects.toThrow(
      'No session nope. Nothing was retired.',
    );
  });

  it('refuses a session that is not merged', async () => {
    await expect(retire()).rejects.toThrow(
      'Session s1 is awaiting-review, not merged; only a session whose PR was closed unmerged ' +
        'can be retired. Nothing was retired.',
    );
    expectNothingChanged();
  });

  it('refuses a session whose merge opened no PR', async () => {
    seedPrMerge(null);

    await expect(retire()).rejects.toThrow('opened no pull request');
    expectNothingChanged();
  });

  it.each([
    ['no pinned sha', { target: 'main' }],
    ['no target', { sha: 'PINNED' }],
  ])('refuses a merge event that names %s, asking GitHub nothing', async (_name, pin) => {
    transitionSession(db, SESSION_ID, 'merged');
    // Written raw: a target-less merge is an old or torn row no writer makes now.
    const payload = { branch: BRANCH, files: [], prUrl: PR_URL, ...pin };
    db.prepare("INSERT INTO events (session_id, type, payload) VALUES (?, 'merge', ?)").run(
      SESSION_ID,
      JSON.stringify(payload).replace('PINNED', pinned),
    );
    fakeGh(closed);

    await expect(retire()).rejects.toThrow(
      "Session s1's merge event names no pinned sha and target, so there is nothing to check " +
        'origin against. Nothing was retired.',
    );
    expectNothingChanged();
    expect(existsSync(ghLog)).toBe(false);
  });

  // `pup fix` takes a merged session back to running under the merge lock.
  it('refuses a session a fix round took out of merged while it waited for the lock', async () => {
    seedPrMerge();
    fakeGh(closed);

    await expect(
      retireWhileLockHeld(() =>
        transitionSessionAlong(db, SESSION_ID, FIX_ROUND_EDGE, { kind: 'fix-round' }),
      ),
    ).rejects.toThrow(
      'Session s1 became running while `pup retire` waited for the merge lock. ' +
        'Nothing was retired.',
    );
    expectNothingChanged();
  });

  // A fix round's re-gate opens a new PR and leaves the session merged again,
  // all while retire waits: the closed PR it checked is no longer the one.
  it('refuses when a re-gate recorded a new merge while it waited for the lock', async () => {
    seedPrMerge();
    fakeGh(closed);

    await expect(
      retireWhileLockHeld(() =>
        appendEvent(db, SESSION_ID, 'merge', {
          branch: BRANCH,
          sha: 'd'.repeat(40),
          target: 'main',
          files: ['feature.ts'],
          prUrl: 'https://github.com/owner/repo/pull/8',
        }),
      ),
    ).rejects.toThrow(
      'Session s1 recorded a merge event while `pup retire` waited for the merge lock, so the ' +
        'PR checked is no longer the one its merge stands for. Nothing was retired.',
    );
    expectNothingChanged();
  });

  it('refuses when a landed event appeared while it waited for the lock', async () => {
    seedPrMerge();
    fakeGh(closed);

    await expect(
      retireWhileLockHeld(() =>
        appendEvent(db, SESSION_ID, 'landed', { sha: pinned, target: 'main', prUrl: PR_URL }),
      ),
    ).rejects.toThrow(
      'Session s1 recorded a landed event while `pup retire` waited for the merge lock',
    );
    expectNothingChanged();
  });

  it('refuses a locked worktree before stopping the window, writing no event; a re-run finishes', async () => {
    seedPrMerge();
    fakeGh(closed);
    sh(repo, 'git', 'worktree', 'lock', worktree);

    await expect(retire()).rejects.toThrow(
      `git holds the worktree at ${worktree} locked; unlock it with \`git worktree unlock\` and ` +
        're-run `pup retire`. Nothing was retired.',
    );
    expectNothingChanged();

    sh(repo, 'git', 'worktree', 'unlock', worktree);
    await expect(retire()).resolves.toMatchObject({ removedWorktree: true });
    expect(existsSync(worktree)).toBe(false);
    expect(retiredEvents()).toHaveLength(1);
  });

  it('refuses a session that has landed', async () => {
    seedPrMerge();
    appendEvent(db, SESSION_ID, 'landed', { sha: 'c'.repeat(40), target: 'main', prUrl: PR_URL });

    await expect(retire()).rejects.toThrow('Session s1 has already landed.');
    expectNothingChanged();
  });

  it('refuses a session already retired', async () => {
    seedPrMerge();
    fakeGh(closed);
    await retire();

    await expect(retire()).rejects.toThrow('Session s1 has already been retired.');
    expect(retiredEvents()).toHaveLength(1);
  });

  it('refuses while its PR is still open on GitHub', async () => {
    seedPrMerge();
    fakeGh({ ...closed, state: 'OPEN' });

    await expect(retire()).rejects.toThrow(
      `${PR_URL} is OPEN on GitHub, not CLOSED; close it there first, or land it. ` +
        'Nothing was retired.',
    );
    expectNothingChanged();
  });

  it('refuses a PR GitHub merged, which `pup land` closes out', async () => {
    seedPrMerge();
    fakeGh(merged);

    await expect(retire()).rejects.toThrow(
      `${PR_URL} is MERGED on GitHub; land it with \`pup land s1\` rather than retire it.`,
    );
    expectNothingChanged();
  });

  it.each([
    ['open', { ...closed, state: 'OPEN' }, 'is OPEN on GitHub, not MERGED'],
    ['closed', closed, 'is CLOSED on GitHub, not MERGED'],
    ['merged into another branch', { ...merged, baseRefName: 'next' }, 'was merged into next'],
  ])('refuses a superseding PR that is %s', async (_shape, other, message) => {
    seedPrMerge();
    fakeGh(closed, other);

    await expect(retire()).rejects.toThrow(`${SUPERSEDING_URL} ${message}`);
    expectNothingChanged();
  });

  it("refuses a superseding PR outside the session's repo, asking GitHub nothing", async () => {
    seedPrMerge();
    fakeGh(closed);

    await expect(retire('https://github.com/else/repo/pull/9')).rejects.toThrow(
      'https://github.com/else/repo/pull/9 is not a pull request of github.com/owner/repo',
    );
    expectNothingChanged();
    expect(existsSync(ghLog)).toBe(false);
  });

  it('refuses a stored PR url of another repo, asking GitHub nothing', async () => {
    seedPrMerge('https://github.com/else/repo/pull/7');
    fakeGh(closed);

    await expect(retire()).rejects.toThrow(
      'https://github.com/else/repo/pull/7 is not a pull request of github.com/owner/repo, the ' +
        'repo origin was recorded as. Nothing was retired.',
    );
    expectNothingChanged();
    expect(existsSync(ghLog)).toBe(false);
  });

  it.each([
    ['branch', 'branch', 'pup/other'],
    ['worktree', 'worktree_path', '/elsewhere/.worktrees/s1'],
  ])(
    'refuses a row whose %s is not the one the launch minted, asking GitHub nothing',
    async (_name, column, value) => {
      seedPrMerge();
      fakeGh(closed);
      db.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`).run(value, SESSION_ID);

      await expect(retire()).rejects.toThrow(
        "Session s1's row names a worktree or branch that is not its own; inspect the store. " +
          'Nothing was retired.',
      );
      expectNothingChanged();
      expect(existsSync(ghLog)).toBe(false);
    },
  );

  it('fails closed when gh fails', async () => {
    seedPrMerge();
    failingGh();

    await expect(retire()).rejects.toThrow('gh: HTTP 502');
    expectNothingChanged();
  });

  it.each([
    ['its own PR', {}, merged, `${PR_URL} is in an unreadable state on GitHub, not CLOSED`],
    [
      'the superseding PR',
      closed,
      {},
      `${SUPERSEDING_URL} is in an unreadable state on GitHub, not MERGED`,
    ],
  ])(
    'fails closed when gh reports %s in an unreadable state',
    async (_which, own, other, message) => {
      seedPrMerge();
      fakeGh(own, other);

      await expect(retire()).rejects.toThrow(message);
      expectNothingChanged();
    },
  );
});

// The helpers `pup land` and `pup retire` share (decision 141), each on its own.
describe('session teardown helpers', { timeout: 20_000 }, () => {
  const SHA = 'a'.repeat(40);
  const NOTHING = 'Nothing was done.';
  const USE = { command: '`pup test`', untouched: NOTHING };
  let db: Database;

  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, 'p', '/repo');
    insertTask(db, { id: 'task-s1', projectId: 'p', spec: '{}' });
    insertSession(db, {
      id: SESSION_ID,
      taskId: 'task-s1',
      worktreePath: '/repo/.worktrees/s1',
      branch: BRANCH,
      profileHash: 'hash',
    });
    transitionSession(db, SESSION_ID, 'running');
    transitionSession(db, SESSION_ID, 'awaiting-review');
    transitionSession(db, SESSION_ID, 'merged');
  });

  function seedMerge(pin: { sha?: string; target: string; prUrl?: string }): void {
    appendEvent(db, SESSION_ID, 'merge', { branch: BRANCH, files: [], ...pin });
  }

  it('pinnedPullRequest returns the PR, the pinned sha and the target of the newest merge', () => {
    seedMerge({ sha: SHA, target: 'main', prUrl: PR_URL });
    expect(pinnedPullRequest(db, SESSION_ID, 's1', NOTHING)).toEqual({
      prUrl: PR_URL,
      sha: SHA,
      target: 'main',
    });
  });

  it('pinnedPullRequest refuses a session that has landed', () => {
    seedMerge({ sha: SHA, target: 'main', prUrl: PR_URL });
    appendEvent(db, SESSION_ID, 'landed', { sha: SHA, target: 'main', prUrl: PR_URL });
    expect(() => pinnedPullRequest(db, SESSION_ID, 's1', NOTHING)).toThrow(
      'Session s1 has already landed.',
    );
  });

  it('pinnedPullRequest refuses a merge that opened no PR, naming what was left untouched', () => {
    seedMerge({ sha: SHA, target: 'main' });
    expect(() => pinnedPullRequest(db, SESSION_ID, 's1', NOTHING)).toThrow(
      'Session s1 opened no pull request: its merge was a local fast-forward, already on the ' +
        'target. Nothing was done.',
    );
  });

  it.each([
    ['no sha', { target: 'main' }],
    ['a sha that is no commit sha', { sha: 'HEAD', target: 'main' }],
  ])('pinnedPullRequest refuses a merge event with %s', (_name, pin) => {
    seedMerge({ ...pin, prUrl: PR_URL });
    expect(() => pinnedPullRequest(db, SESSION_ID, 's1', NOTHING)).toThrow(
      "Session s1's merge event names no pinned sha and target, so there is nothing to check " +
        'origin against. Nothing was done.',
    );
  });

  it('assertStillMerged passes a session still merged', () => {
    expect(() => assertStillMerged(db, SESSION_ID, 's1', USE)).not.toThrow();
  });

  it('assertStillMerged refuses a session that left merged, naming its state and the command', () => {
    transitionSessionAlong(db, SESSION_ID, FIX_ROUND_EDGE, { kind: 'fix-round' });
    expect(() => assertStillMerged(db, SESSION_ID, 's1', USE)).toThrow(
      'Session s1 became running while `pup test` waited for the merge lock. Nothing was done.',
    );
  });

  it('assertStillMerged refuses a session gone from the store', () => {
    expect(() => assertStillMerged(db, 'gone', 'gone', USE)).toThrow(
      'Session gone was removed from the store while `pup test` waited for the merge lock. ' +
        'Nothing was done.',
    );
  });

  describe('on a git repo', () => {
    let repo: string;
    let base: string;

    beforeEach(() => {
      repo = tempDir('pup-teardown-repo-');
      sh(repo, 'git', 'init', '-q', '-b', 'main');
      base = commitIn(repo, 'app.ts', 'export const app = 1;\n');
    });

    const hasBranch = (branch: string): boolean =>
      sh(repo, 'git', 'branch', '--list', branch) !== '';

    it('isRegisteredWorktree asks git, and prunes a worktree whose directory is gone', () => {
      const worktree = join(repo, '.worktrees', 'w');
      sh(repo, 'git', 'worktree', 'add', '-q', '-b', 'pup/w', worktree, 'HEAD');
      expect(isRegisteredWorktree(repo, worktree)).toBe(true);
      expect(isRegisteredWorktree(repo, join(repo, 'elsewhere'))).toBe(false);
      rmSync(worktree, { recursive: true, force: true });
      expect(isRegisteredWorktree(repo, worktree)).toBe(false);
      expect(sh(repo, 'git', 'worktree', 'list', '--porcelain')).not.toContain(worktree);
    });

    it('assertUnlockedWorktree answers whether git registers it, and refuses a locked one', () => {
      const worktree = join(repo, '.worktrees', 'w');
      sh(repo, 'git', 'worktree', 'add', '-q', '-b', 'pup/w', worktree, 'HEAD');
      expect(assertUnlockedWorktree(repo, worktree, USE)).toBe(true);
      expect(assertUnlockedWorktree(repo, join(repo, 'elsewhere'), USE)).toBe(false);
      sh(repo, 'git', 'worktree', 'lock', '--reason', 'busy', worktree);
      expect(() => assertUnlockedWorktree(repo, worktree, USE)).toThrow(
        `git holds the worktree at ${worktree} locked; unlock it with \`git worktree unlock\` and ` +
          're-run `pup test`. Nothing was done.',
      );
      expect(isRegisteredWorktree(repo, worktree)).toBe(true);
    });

    it('deleteBranchIfHeld deletes a branch any one of the shas holds', () => {
      sh(repo, 'git', 'branch', 'pup/held', 'HEAD');
      const later = commitIn(repo, 'later.ts', 'export const later = 1;\n');
      expect(deleteBranchIfHeld(repo, 'pup/held', ['b'.repeat(40), later])).toBeUndefined();
      expect(hasBranch('pup/held')).toBe(false);
    });

    it('deleteBranchIfHeld keeps, and names, a branch holding a commit past every sha', () => {
      sh(repo, 'git', 'checkout', '-q', '-b', 'pup/ahead');
      commitIn(repo, 'ahead.ts', 'export const ahead = 1;\n');
      sh(repo, 'git', 'checkout', '-q', 'main');
      expect(deleteBranchIfHeld(repo, 'pup/ahead', [base])).toBe('pup/ahead');
      expect(hasBranch('pup/ahead')).toBe(true);
    });

    it('deleteBranchIfHeld takes a branch already gone as nothing to keep', () => {
      expect(deleteBranchIfHeld(repo, 'pup/never', [base])).toBeUndefined();
    });
  });
});
