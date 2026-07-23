import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { openStore } from './db.client.js';
import {
  getWatcherBeat,
  listOverlaps,
  recordWatcherBeat,
  replaceOverlaps,
} from './overlap.repository.js';
import { intersectSessionFiles, scanOverlaps } from './overlap.service.js';
import { projectId } from './paths.utils.js';
import {
  ensureProject,
  insertSession,
  insertTask,
  transitionSession,
} from './session.repository.js';

// Test repos must not inherit the developer's global git config nor GIT_DIR & co.
// — when this suite runs inside a git hook (pre-commit), those would redirect
// every git call at the pupitre repo instead of the temp repo.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cwd: string, ...args: string[]): void {
  execFileSync(args[0] as string, args.slice(1), { cwd, encoding: 'utf8', env: GIT_ENV });
}

function commitIn(dir: string, file: string, content: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `edit ${file}`);
}

describe('intersectSessionFiles', () => {
  it('pairs sessions whose diffs share a file, files sorted', () => {
    const pairs = intersectSessionFiles({
      s1: ['src/a.ts', 'src/b.ts'],
      s2: ['src/b.ts', 'src/a.ts', 'src/c.ts'],
      s3: ['src/z.ts'],
    });

    expect(pairs).toEqual([{ sessionA: 's1', sessionB: 's2', files: ['src/a.ts', 'src/b.ts'] }]);
  });

  it('returns no pairs when nothing overlaps', () => {
    expect(intersectSessionFiles({ s1: ['a'], s2: ['b'] })).toEqual([]);
  });
});

describe('overlap repository', () => {
  let db: Database;
  beforeEach(() => {
    db = openStore(':memory:');
  });

  it('replaces the overlap set atomically', () => {
    replaceOverlaps(db, [{ sessionA: 's1', sessionB: 's2', files: ['src/a.ts'] }]);
    replaceOverlaps(db, [{ sessionA: 's1', sessionB: 's3', files: ['src/b.ts'] }]);

    expect(listOverlaps(db)).toEqual([{ sessionA: 's1', sessionB: 's3', files: ['src/b.ts'] }]);
  });

  it('round-trips the watcher heartbeat', () => {
    expect(getWatcherBeat(db, 'proj-1')).toBeUndefined();

    recordWatcherBeat(db, 'proj-1', new Date('2026-07-23T12:00:00Z'));
    expect(getWatcherBeat(db, 'proj-1')?.toISOString()).toBe('2026-07-23T12:00:00.000Z');

    recordWatcherBeat(db, 'proj-1', new Date('2026-07-23T12:00:15Z'));
    expect(getWatcherBeat(db, 'proj-1')?.toISOString()).toBe('2026-07-23T12:00:15.000Z');
  });
});

describe('scanOverlaps', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-radar-')));
    sh(repo, 'git', 'init', '-b', 'main');
    sh(repo, 'git', 'config', 'user.email', 't@t');
    sh(repo, 'git', 'config', 'user.name', 't');
    commitIn(repo, 'src/app.ts', 'export const app = 1;\n');
    ensureProject(db, 'proj-1', repo);
    insertTask(db, { id: 'task-1', projectId: 'proj-1', spec: '{}' });
  });

  function seedWorktreeSession(id: string, file: string): void {
    const worktree = join(repo, '.worktrees', id);
    sh(repo, 'git', 'worktree', 'add', '-b', `pup/${id}`, worktree, 'HEAD');
    commitIn(worktree, file, `export const ${id} = 1;\n`);
    insertSession(db, {
      id,
      taskId: 'task-1',
      worktreePath: worktree,
      branch: `pup/${id}`,
      profileHash: 'x',
    });
    transitionSession(db, id, 'running');
  }

  it('stores the overlap between live sessions editing the same file and beats', () => {
    seedWorktreeSession('s1', 'src/shared.ts');
    seedWorktreeSession('s2', 'src/shared.ts');
    seedWorktreeSession('s3', 'src/own.ts');

    const pairs = scanOverlaps(db, repo);

    expect(pairs).toEqual([{ sessionA: 's1', sessionB: 's2', files: ['src/shared.ts'] }]);
    expect(listOverlaps(db)).toEqual(pairs);
    expect(getWatcherBeat(db, projectId(repo))).toBeDefined();
  });

  it('clears stale overlaps once a session stops running', () => {
    seedWorktreeSession('s1', 'src/shared.ts');
    seedWorktreeSession('s2', 'src/shared.ts');
    scanOverlaps(db, repo);

    transitionSession(db, 's2', 'killed');
    const pairs = scanOverlaps(db, repo);

    expect(pairs).toEqual([]);
    expect(listOverlaps(db)).toEqual([]);
  });
});
