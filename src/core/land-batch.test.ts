import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endSandboxRun, GateInterruptedError } from './sandbox.utils.js';

// The real audit, so a test can count it and make it throw.
vi.mock('./audit.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./audit.service.js')>();
  return { ...actual, auditProject: vi.fn(actual.auditProject) };
});

import { commitIn, ORIGIN_URL, sh } from '@test/helpers/land.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { auditProject } from './audit.service.js';
import { openStore } from './db.client.js';
import { landSessions } from './land-batch.service.js';
import { MERGE_LOCK_DIRNAME } from './merge-gate.constants.js';
import { MergeLockLostError } from './merge-gate.errors.js';
import { projectId } from './paths.utils.js';
import { NO_PROGRESS } from './progress.utils.js';
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
import type { LandBatchOutcome } from './types/land.types.js';

// Real git repos, a bare origin and a sandboxed audit, as land.test.ts has;
// the sandbox run the audit starts is ended here (decision 100).
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

const SESSIONS = ['s1', 's2', 's3'] as const;
const prUrl = (n: number) => `https://github.com/owner/repo/pull/${n}`;

describe('landSessions (decision 195)', { timeout: 30_000 }, () => {
  let db: Database;
  let repo: string;
  let origin: string;
  let host: string;
  let pid: string;
  let originalPath: string | undefined;
  /** Each session's pinned sha, its branch tip. */
  const pinned = new Map<string, string>();

  beforeEach(() => {
    vi.mocked(auditProject).mockClear();
    db = openStore(':memory:');
    repo = tempDir('pup-land-batch-repo-');
    sh(repo, 'git', 'init', '-q', '-b', 'main');
    commitIn(repo, 'src/app.ts', 'export const app = 1;\n');
    // GitHub-shaped origin, rewritten by the global config into a local bare repo.
    host = tempDir('pup-land-batch-origin-');
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
    SESSIONS.forEach((id, at) => {
      const worktree = join(repo, '.worktrees', id);
      sh(repo, 'git', 'worktree', 'add', '-q', '-b', `pup/${id}`, worktree, 'HEAD');
      const sha = commitIn(worktree, `src/${id}.ts`, `export const ${id} = 1;\n`);
      pinned.set(id, sha);
      sh(repo, 'git', 'push', '-q', origin, `pup/${id}`);
      insertTask(db, { id: `task-${id}`, projectId: pid, spec: '{}' });
      insertSession(db, {
        id,
        taskId: `task-${id}`,
        worktreePath: worktree,
        branch: `pup/${id}`,
        profileHash: 'hash',
      });
      transitionSession(db, id, 'running');
      transitionSession(db, id, 'awaiting-review');
      transitionSession(db, id, 'merged');
      appendEvent(db, id, 'merge', {
        branch: `pup/${id}`,
        sha,
        target: 'main',
        files: [`src/${id}.ts`],
        prUrl: prUrl(at + 1),
      });
    });
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.unstubAllEnvs();
  });

  /**
   * GitHub's merge button for `id`: on origin's main, a merge commit of its tip
   * and the pin, holding the tree git gives merging them (decision 131).
   */
  function mergeOnGitHub(id: string): string {
    const head = pinned.get(id) as string;
    const base = sh(origin, 'git', 'rev-parse', 'main');
    const tree = sh(origin, 'git', 'merge-tree', '--write-tree', base, head);
    const merge = sh(
      origin,
      'git',
      '-c',
      'user.email=gh@test',
      '-c',
      'user.name=github',
      'commit-tree',
      tree,
      '-p',
      base,
      '-p',
      head,
      '-m',
      `Merge ${id}`,
    );
    sh(origin, 'git', 'update-ref', 'refs/heads/main', merge);
    return merge;
  }

  /** A gh on PATH answering `pr view` for each PR number with its own JSON. */
  function fakeGh(answers: Map<number, unknown>): void {
    const dir = tempDir('pup-land-batch-gh-');
    const cases = [...answers]
      .map(([n, answer]) => `  *pull/${n}\\ *) echo '${JSON.stringify(answer)}' ;;`)
      .join('\n');
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\ncase "$* " in\n${cases}\nesac\n`, {
      mode: 0o755,
    });
    process.env.PATH = `${dir}:${originalPath}`;
  }

  const merged = (id: string, mergeCommit: string) => ({
    state: 'MERGED',
    baseRefName: 'main',
    headRefOid: pinned.get(id),
    mergeCommit: { oid: mergeCommit },
  });
  const landedEvents = (id: string) =>
    listEvents(db, id)
      .filter((row) => row.type === 'landed')
      .map((row) => JSON.parse(row.payload));
  const landAll = () =>
    landSessions(db, { repoPath: repo, sessionIds: [...SESSIONS], adapters: [passingAdapter] });

  it('lands every session in the order GitHub merged them, then audits once', async () => {
    // Merged on GitHub as s2, s3, then s1: not the order they are named in.
    const m2 = mergeOnGitHub('s2');
    const m3 = mergeOnGitHub('s3');
    const m1 = mergeOnGitHub('s1');
    fakeGh(
      new Map([
        [1, merged('s1', m1)],
        [2, merged('s2', m2)],
        [3, merged('s3', m3)],
      ]),
    );

    const batch = await landAll();

    expect(batch.refused).toEqual([]);
    expect(batch.landed.map(({ sessionId }) => sessionId)).toEqual(['s2', 's3', 's1']);
    expect(batch.landed.map(({ outcome }) => outcome.fastForwarded)).toEqual([true, false, false]);
    expect(batch.landed.every(({ outcome }) => outcome.audit === undefined)).toBe(true);
    expect(landedEvents('s1')).toEqual([{ sha: m1, target: 'main', prUrl: prUrl(1) }]);
    expect(landedEvents('s2')).toEqual([{ sha: m2, target: 'main', prUrl: prUrl(2) }]);
    expect(landedEvents('s3')).toEqual([{ sha: m3, target: 'main', prUrl: prUrl(3) }]);
    expect(sh(repo, 'git', 'rev-parse', 'main')).toBe(m1);
    for (const id of SESSIONS) expect(existsSync(join(repo, '.worktrees', id))).toBe(false);
    expect(auditProject).toHaveBeenCalledTimes(1);
    expect(batch.audit?.baseline).toBeDefined();
    expect(getProject(db, pid)?.baseline).not.toBeNull();
  });

  it('skips a session its own checks refuse, before or under the lock, and lands the rest', async () => {
    const m1 = mergeOnGitHub('s1');
    const m3 = mergeOnGitHub('s3');
    fakeGh(
      new Map<number, unknown>([
        [1, merged('s1', m1)],
        // Refused before the lock: GitHub has not merged it.
        [2, { state: 'OPEN', baseRefName: 'main', headRefOid: pinned.get('s2') }],
        // Refused under it: origin's main does not hold the merge commit named.
        [3, merged('s3', 'e'.repeat(40))],
      ]),
    );

    const batch = await landAll();

    expect(batch.landed.map(({ sessionId }) => sessionId)).toEqual(['s1']);
    expect(batch.refused).toEqual([
      { sessionId: 's2', reason: expect.stringContaining('is OPEN on GitHub, not MERGED') },
      { sessionId: 's3', reason: expect.stringContaining(`does not contain ${'e'.repeat(40)}`) },
    ]);
    // An earlier land may have moved main over a refused session's merge commit.
    for (const { reason } of batch.refused) {
      expect(reason).not.toContain('Nothing was landed');
      expect(reason).toContain('main may already hold its merge commit');
    }
    expect(landedEvents('s1')).toHaveLength(1);
    expect(landedEvents('s2')).toEqual([]);
    expect(landedEvents('s3')).toEqual([]);
    expect(existsSync(join(repo, '.worktrees', 's2'))).toBe(true);
    expect(existsSync(join(repo, '.worktrees', 's3'))).toBe(true);
    expect(sh(repo, 'git', 'rev-parse', 'main')).toBe(m3);
    expect(auditProject).toHaveBeenCalledTimes(1);
  });

  it('runs no audit and moves nothing when every session is refused', async () => {
    fakeGh(
      new Map([1, 2, 3].map((n) => [n, { state: 'OPEN', baseRefName: 'main', headRefOid: 'a' }])),
    );

    const batch = await landAll();

    expect(batch.landed).toEqual([]);
    expect(batch.refused.map(({ sessionId }) => sessionId)).toEqual([...SESSIONS]);
    expect(auditProject).not.toHaveBeenCalled();
    for (const id of SESSIONS) expect(existsSync(join(repo, '.worktrees', id))).toBe(true);
  });

  it('returns a failed audit with the lands, which stand', async () => {
    const m1 = mergeOnGitHub('s1');
    fakeGh(new Map([[1, merged('s1', m1)]]));
    vi.mocked(auditProject).mockRejectedValueOnce(new Error('build crashed'));

    const batch = await landSessions(db, {
      repoPath: repo,
      sessionIds: ['s1'],
      adapters: [passingAdapter],
    });

    expect(batch.landed.map(({ sessionId }) => sessionId)).toEqual(['s1']);
    expect(batch.auditFailure).toBe('build crashed');
    expect(landedEvents('s1')).toHaveLength(1);
  });

  it('stops at a lock lost after the first land: no further land, no audit, the outcome thrown', async () => {
    const m2 = mergeOnGitHub('s2');
    const m3 = mergeOnGitHub('s3');
    const m1 = mergeOnGitHub('s1');
    fakeGh(
      new Map([
        [1, merged('s1', m1)],
        [2, merged('s2', m2)],
        [3, merged('s3', m3)],
      ]),
    );
    // A session moves the lock away once the first land wrote its event.
    let moved = false;
    const progress = {
      ...NO_PROGRESS,
      stage: (name: string) => {
        if (name !== 'steer' || moved) return;
        moved = true;
        renameSync(join(repo, '.git', MERGE_LOCK_DIRNAME), join(repo, '.git', 'moved.lock'));
      },
    };

    const lost = await landSessions(
      db,
      { repoPath: repo, sessionIds: [...SESSIONS], adapters: [passingAdapter] },
      progress,
    ).catch((error: unknown) => error);

    expect(lost).toBeInstanceOf(MergeLockLostError);
    const batch = (lost as MergeLockLostError<LandBatchOutcome>).result;
    expect(batch.landed.map(({ sessionId }) => sessionId)).toEqual(['s2']);
    expect(batch.refused).toEqual([
      { sessionId: 's3', reason: expect.stringContaining('merge lock was lost') },
      { sessionId: 's1', reason: expect.stringContaining('merge lock was lost') },
    ]);
    expect(batch.audit).toBeUndefined();
    expect(auditProject).not.toHaveBeenCalled();
    expect(landedEvents('s2')).toHaveLength(1);
    expect(landedEvents('s3')).toEqual([]);
    expect(landedEvents('s1')).toEqual([]);
    expect(sh(repo, 'git', 'rev-parse', 'main')).toBe(m1);
    expect(existsSync(join(repo, '.worktrees', 's3'))).toBe(true);
    expect(existsSync(join(repo, '.worktrees', 's1'))).toBe(true);
  });

  it('runs no audit on a lock lost during the last land, and throws the outcome', async () => {
    const m1 = mergeOnGitHub('s1');
    fakeGh(new Map([[1, merged('s1', m1)]]));
    // The lock moves away during the only land's steer: after it, only the audit is left.
    const progress = {
      ...NO_PROGRESS,
      stage: (name: string) => {
        if (name === 'steer') {
          renameSync(join(repo, '.git', MERGE_LOCK_DIRNAME), join(repo, '.git', 'moved.lock'));
        }
      },
    };

    const lost = await landSessions(
      db,
      { repoPath: repo, sessionIds: ['s1'], adapters: [passingAdapter] },
      progress,
    ).catch((error: unknown) => error);

    expect(lost).toBeInstanceOf(MergeLockLostError);
    const batch = (lost as MergeLockLostError<LandBatchOutcome>).result;
    expect(batch.landed.map(({ sessionId }) => sessionId)).toEqual(['s1']);
    expect(batch.refused).toEqual([]);
    expect(batch.audit).toBeUndefined();
    expect(auditProject).not.toHaveBeenCalled();
    expect(landedEvents('s1')).toHaveLength(1);
  });

  // A terminal Ctrl-C under the lock kills only the child git (decision 88);
  // its failure is the only sign of it, so it ends the batch, never one land.
  it.each([
    { fetch: 1, what: 'the ordering fetch', landed: [] },
    { fetch: 3, what: "the second land's fetch", landed: ['s2'] },
  ])('stops the batch at a Ctrl-C killing $what: no further land, no audit', async (row) => {
    const m2 = mergeOnGitHub('s2');
    const m3 = mergeOnGitHub('s3');
    const m1 = mergeOnGitHub('s1');
    fakeGh(
      new Map([
        [1, merged('s1', m1)],
        [2, merged('s2', m2)],
        [3, merged('s3', m3)],
      ]),
    );
    const realGit = sh(repo, 'sh', '-c', 'command -v git');
    const dir = tempDir('pup-land-batch-git-');
    const count = join(dir, 'fetches');
    writeFileSync(
      join(dir, 'git'),
      '#!/bin/sh\ncase " $* " in\n  *" fetch "*)\n' +
        `    n=$(($(cat '${count}' 2>/dev/null || echo 0) + 1)); echo "$n" > '${count}'\n` +
        `    [ "$n" = ${row.fetch} ] && kill -INT $$ ;;\nesac\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${process.env.PATH}`;

    const failure = await landAll().catch((error: unknown) => error);

    expect(failure).toMatchObject({ signal: 'SIGINT' });
    for (const id of SESSIONS) {
      expect(landedEvents(id)).toHaveLength(row.landed.includes(id) ? 1 : 0);
    }
    expect(auditProject).not.toHaveBeenCalled();
  });

  // A Ctrl-C during pup's own work, such as a steer's waits, kills no child,
  // and the lock's listener discards it; the batch records it itself.
  it.each([
    { sessionIds: [...SESSIONS], what: 'the next land', landed: ['s2'] },
    { sessionIds: ['s1'], what: 'the audit', landed: ['s1'] },
  ])('stops before $what at an interrupt that killed no child', async (row) => {
    const m2 = mergeOnGitHub('s2');
    const m3 = mergeOnGitHub('s3');
    const m1 = mergeOnGitHub('s1');
    fakeGh(
      new Map([
        [1, merged('s1', m1)],
        [2, merged('s2', m2)],
        [3, merged('s3', m3)],
      ]),
    );
    const before = process.listeners('SIGINT');
    let sent = false;
    const progress = {
      ...NO_PROGRESS,
      stage: (name: string) => {
        if (name !== 'steer' || sent) return;
        sent = true;
        // Delivered once the event loop turns, as a real signal's listener is.
        setImmediate(() => process.emit('SIGINT', 'SIGINT'));
      },
    };

    const failure = await landSessions(
      db,
      { repoPath: repo, sessionIds: row.sessionIds, adapters: [passingAdapter] },
      progress,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GateInterruptedError);
    expect(failure).toMatchObject({ signal: 'SIGINT' });
    for (const id of SESSIONS) {
      expect(landedEvents(id)).toHaveLength(row.landed.includes(id) ? 1 : 0);
    }
    expect(auditProject).not.toHaveBeenCalled();
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('refuses the whole batch when no adapter could audit it, asking GitHub nothing', async () => {
    await expect(
      landSessions(db, { repoPath: repo, sessionIds: [...SESSIONS], adapters: [] }),
    ).rejects.toThrow(/No adapter for .*; the audit after the land would measure nothing/);
    for (const id of SESSIONS) expect(landedEvents(id)).toEqual([]);
  });
});
