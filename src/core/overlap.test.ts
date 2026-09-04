import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { openStore, type SessionState } from './db.client.js';
import {
  getWatcherBeat,
  listOverlaps,
  recordWatcherBeat,
  replaceOverlaps,
} from './overlap.repository.js';
import { intersectSessionFiles, scanOverlaps, scopeConflicts } from './overlap.service.js';
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

describe('scopeConflicts', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-scope-')));
    sh(repo, 'git', 'init', '-b', 'main');
    sh(repo, 'git', 'config', 'user.email', 't@t');
    sh(repo, 'git', 'config', 'user.name', 't');
    commitIn(repo, 'src/core/gate.service.ts', 'export const gate = 1;\n');
    commitIn(repo, 'src/core/report.service.ts', 'export const report = 1;\n');
    commitIn(repo, 'src/cli/index.ts', 'export const cli = 1;\n');
    ensureProject(db, projectId(repo), repo);
  });

  /** Legal transition walks, since a session cannot be dropped into a state. */
  const STEPS_TO: Record<string, SessionState[]> = {
    queued: [],
    running: ['running'],
    'awaiting-review': ['running', 'awaiting-review'],
    blocked: ['running', 'blocked'],
    merged: ['running', 'awaiting-review', 'merged'],
    killed: ['running', 'killed'],
  };

  /** A live session holding `scopeIn`, in `state`, via its own task row. */
  function seedHolder(id: string, scopeIn: string[], state = 'running', scopeOut?: string[]): void {
    insertTask(db, {
      id: `task-${id}`,
      projectId: projectId(repo),
      spec: JSON.stringify({ id: `task-${id}`, goal: `hold ${id}`, scopeIn, scopeOut }),
    });
    insertSession(db, {
      id,
      taskId: `task-${id}`,
      worktreePath: join(repo, '.worktrees', id),
      branch: `pup/${id}`,
      profileHash: 'x',
    });
    for (const step of STEPS_TO[state] ?? []) transitionSession(db, id, step);
  }

  it('names the live session and the tracked files two scopes both claim', () => {
    seedHolder('s1', ['src/core/**']);

    expect(scopeConflicts(db, repo, ['src/core/gate.service.ts'])).toEqual([
      { sessionId: 's1', files: ['src/core/gate.service.ts'] },
    ]);
  });

  it('finds nothing when the scopes name different files', () => {
    seedHolder('s1', ['src/core/**']);

    expect(scopeConflicts(db, repo, ['src/cli/**'])).toEqual([]);
  });

  it('reports every conflicting session, not just the first', () => {
    seedHolder('s1', ['src/core/gate.service.ts']);
    seedHolder('s2', ['src/core/report.service.ts']);

    expect(scopeConflicts(db, repo, ['src/core/**']).map((c) => c.sessionId)).toEqual(['s1', 's2']);
  });

  // The file is in both scope-ins, so only scope-out's precedence keeps it out
  // of the answer — the same precedence the gate audits a diff with.
  it('does not conflict over a file the candidate excludes with scope-out', () => {
    seedHolder('s1', ['src/core/**']);

    expect(scopeConflicts(db, repo, ['src/core/**'], ['src/core/gate.service.ts'])).toEqual([
      { sessionId: 's1', files: ['src/core/report.service.ts'] },
    ]);
  });

  it('does not conflict over a file the holder excludes with scope-out', () => {
    seedHolder('s1', ['src/core/**'], 'running', ['src/core/gate.service.ts']);

    expect(scopeConflicts(db, repo, ['src/core/gate.service.ts'])).toEqual([]);
  });

  // A session in any of these can still transition back to `running`, so its
  // worktree is still the place that file is being edited.
  it.each(['queued', 'running', 'awaiting-review', 'blocked'] as const)(
    'counts a %s session as still holding its scope',
    (state) => {
      seedHolder('s1', ['src/core/**'], state);

      expect(scopeConflicts(db, repo, ['src/core/gate.service.ts'])).toHaveLength(1);
    },
  );

  // Merged work is in the target and killed work is abandoned: neither is
  // still writing, so holding the scope any longer would refuse launches
  // forever on a repo that has ever built anything.
  it.each(['merged', 'killed'] as const)('frees the scope once a session is %s', (state) => {
    seedHolder('s1', ['src/core/**'], state);

    expect(scopeConflicts(db, repo, ['src/core/gate.service.ts'])).toEqual([]);
  });

  // Scopes are resolved against `git ls-files`, so a glob naming only files
  // that do not exist yet resolves to nothing — the stated ceiling.
  it('cannot see a conflict over a file neither scope has created yet', () => {
    seedHolder('s1', ['src/core/new-thing.service.ts']);

    expect(scopeConflicts(db, repo, ['src/core/new-thing.service.ts'])).toEqual([]);
  });

  // Protected paths are refused for every session by the gate, so two scopes
  // naming one is not a collision anybody could act on.
  it('does not conflict over a protected path', () => {
    commitIn(repo, '.claude/settings.json', '{}\n');
    seedHolder('s1', ['**']);

    expect(scopeConflicts(db, repo, ['.claude/**'])).toEqual([]);
  });

  it('asks git nothing when no session is live', () => {
    expect(scopeConflicts(db, '/no/such/repo', ['src/**'])).toEqual([]);
  });
});
