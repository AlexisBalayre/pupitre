import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No tmux here: the test asks only whether, and when, the window was stopped.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  killSession: vi.fn(),
}));

import { killSession } from '../claude/session-runtime.service.js';
import { tempDir } from '../test/temp-dir.mock.js';
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
} from './session.repository.js';
import { retireSession } from './session-retire.service.js';

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

  it('refuses a session that has landed', async () => {
    seedPrMerge();
    appendEvent(db, SESSION_ID, 'landed', { sha: 'c'.repeat(40), target: 'main', prUrl: PR_URL });

    await expect(retire()).rejects.toThrow('Session s1 has landed; there is nothing to retire.');
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
});
