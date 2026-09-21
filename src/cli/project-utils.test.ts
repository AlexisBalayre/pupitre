import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../core/db.client.js';
import { projectId, projectPaths } from '../core/paths.utils.js';
import { ensureProject } from '../core/session.repository.js';
import {
  enclosingProject,
  fleetProjects,
  listRegisteredProjects,
  ProjectResolutionError,
  resolveProject,
} from './project.utils.js';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function initRepo(): string {
  const repo = tempDir('pup-proj-repo-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
  return repo;
}

/** Registers `repoPath` in the store under `base`, the way `pup init` does. */
function register(base: string, repoPath: string): string {
  const id = projectId(repoPath);
  const db = openStore(projectPaths(repoPath, base).dbFile);
  ensureProject(db, id, repoPath);
  db.close();
  return id;
}

let errors: string[];
let originalConsoleError: typeof console.error;
/** The store under the stubbed HOME, for the cases that resolve through homedir(). */
let base: string;

beforeEach(() => {
  errors = [];
  originalConsoleError = console.error;
  console.error = (message: string) => errors.push(message);
  // The store lives under homedir(); a throwaway HOME for every test keeps
  // the developer's real ~/.pupitre out of reach — the merge gate's sandbox
  // forbids writing there, and a test that reaches it passes only locally.
  const home = tempDir('pup-proj-home-');
  vi.stubEnv('HOME', home);
  base = join(home, '.pupitre');
});

afterEach(() => {
  console.error = originalConsoleError;
  vi.unstubAllEnvs();
});

describe('listRegisteredProjects', () => {
  it('is empty when the store directory does not exist yet', () => {
    expect(listRegisteredProjects(join(tempDir('pup-proj-'), 'never'))).toEqual([]);
  });

  it('skips a directory with no store and reads every project row', () => {
    const base = tempDir('pup-proj-base-');
    mkdirSync(join(base, 'leftover'));
    const repo = initRepo();
    const id = register(base, repo);

    expect(listRegisteredProjects(base)).toEqual([
      {
        id,
        repoPath: repo,
        dbFile: projectPaths(repo, base).dbFile,
        repoExists: true,
        dormantAt: null,
      },
    ]);
  });

  // The scan never migrates, so a store no pup has opened since the column
  // was added is read as it is: active, not unreadable (decision 62).
  it('reads a store from before dormant_at as active, and a dormant row as dormant', () => {
    const base = tempDir('pup-proj-base-');
    const old = initRepo();
    const oldId = projectId(old);
    mkdirSync(join(base, oldId));
    const bare = new Database(join(base, oldId, 'state.db'));
    bare.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, repo_path TEXT NOT NULL)');
    bare.prepare('INSERT INTO projects VALUES (?, ?)').run(oldId, old);
    bare.close();
    const asleep = initRepo();
    const asleepId = register(base, asleep);
    const db = openStore(projectPaths(asleep, base).dbFile);
    db.prepare('UPDATE projects SET dormant_at = ? WHERE id = ?').run(
      '2026-09-21T10:00:00Z',
      asleepId,
    );
    db.close();

    const byId = new Map(listRegisteredProjects(base).map((project) => [project.id, project]));

    expect(byId.get(oldId)?.dormantAt).toBeNull();
    expect(byId.get(asleepId)?.dormantAt).toBe('2026-09-21T10:00:00Z');
    expect(errors).toEqual([]);
  });

  // Every store under the base is read, including one a session wrote or a
  // stray file dropped there; a store that cannot be read is no project, not
  // every command's crash.
  it('skips a store that is not a database, or has no projects table', () => {
    const base = tempDir('pup-proj-base-');
    mkdirSync(join(base, 'garbage'));
    writeFileSync(join(base, 'garbage', 'state.db'), 'not sqlite at all');
    mkdirSync(join(base, 'tableless'));
    new Database(join(base, 'tableless', 'state.db')).close();
    const repo = initRepo();
    const id = register(base, repo);

    expect(listRegisteredProjects(base).map((project) => project.id)).toEqual([id]);
  });

  it('says once on stderr which store it could not read, and reads the rest', () => {
    const base = tempDir('pup-proj-base-');
    const repo = initRepo();
    const id = register(base, repo);
    const locked = initRepo();
    register(base, locked);
    const lockedDb = projectPaths(locked, base).dbFile;
    chmodSync(lockedDb, 0o000);

    try {
      expect(listRegisteredProjects(base).map((project) => project.id)).toEqual([id]);
    } finally {
      chmodSync(lockedDb, 0o644);
    }
    expect(errors).toEqual([expect.stringMatching(`^Skipping unreadable store ${lockedDb}: `)]);
  });

  it('is silent about a store whose projects table is empty', () => {
    const base = tempDir('pup-proj-base-');
    openStore(join(base, 'fresh', 'state.db')).close();

    expect(listRegisteredProjects(base)).toEqual([]);
    expect(errors).toEqual([]);
  });

  // Ids derive from repo_path, so a row that does not derive is a store
  // planted or renamed to answer for a repo it is not keyed to.
  it('skips a row whose id is not the hash of its repo_path under that directory', () => {
    const base = tempDir('pup-proj-base-');
    const repo = initRepo();
    const renamed = openStore(join(base, 'deadbeef0000', 'state.db'));
    ensureProject(renamed, projectId(repo), repo);
    renamed.close();
    const forged = openStore(projectPaths(repo, base).dbFile);
    ensureProject(forged, 'deadbeef0000', repo);
    forged.close();

    expect(listRegisteredProjects(base)).toEqual([]);
  });

  it('flags a project whose repo is gone from disk', () => {
    const base = tempDir('pup-proj-base-');
    const repo = initRepo();
    register(base, repo);
    rmSync(repo, { recursive: true });

    expect(listRegisteredProjects(base)).toEqual([expect.objectContaining({ repoExists: false })]);
  });
});

describe('fleetProjects', () => {
  it('lists every registered project, a missing repo included', () => {
    const live = initRepo();
    const gone = initRepo();
    register(base, live);
    register(base, gone);
    rmSync(gone, { recursive: true });

    expect(
      fleetProjects()
        .map((project) => [project.repoPath, project.repoExists])
        .sort(),
    ).toEqual(
      [
        [gone, false],
        [live, true],
      ].sort(),
    );
  });

  it('refuses in one line when nothing is registered', () => {
    expect(() => fleetProjects()).toThrow(
      new ProjectResolutionError(
        'No project registered; run pup init from the repo you want to control.',
      ),
    );
  });
});

describe('resolveProject', () => {
  it('resolves the repo around cwd, even from a linked worktree', () => {
    const repo = initRepo();
    execFileSync('git', ['commit', '--allow-empty', '-m', 'root'], { cwd: repo, env: GIT_ENV });
    const worktree = join(repo, '.worktrees', 'wt');
    execFileSync('git', ['worktree', 'add', worktree], { cwd: repo, env: GIT_ENV });

    const resolved = resolveProject(worktree);
    resolved.db.close();

    expect(resolved.repoPath).toBe(repo);
  });

  it('ignores the store while inside a repo', () => {
    const other = initRepo();
    register(base, other);
    const repo = initRepo();

    const resolved = resolveProject(repo);
    resolved.db.close();

    expect(resolved.repoPath).toBe(repo);
  });

  describe('outside any repo', () => {
    it('uses the only registered project silently', () => {
      const repo = initRepo();
      register(base, repo);

      const resolved = resolveProject(tempDir('pup-proj-nowhere-'));
      resolved.db.close();

      expect(resolved.repoPath).toBe(repo);
    });

    // The choice was pup's, so it is said, and said clean: the path is the
    // store's to write (decision 29).
    it('says which project it chose, with control characters stripped', () => {
      const repo = join(tempDir('pup-proj-evil-'), 'x\u001b[31my');
      mkdirSync(repo);
      execFileSync('git', ['init', '-b', 'main'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
      const id = register(base, repo);

      resolveProject(tempDir('pup-proj-nowhere-')).db.close();

      expect(errors).toEqual([`Using project ${id} at ${repo.replace('\u001b', ' ')}`]);
      expect(errors[0]).not.toContain('\u001b');
    });

    it('refuses in one line when nothing is registered', () => {
      expect(() => resolveProject(tempDir('pup-proj-nowhere-'))).toThrow(
        new ProjectResolutionError(
          'Not inside a git repository and no project registered; run pup init from the repo you want to control.',
        ),
      );
    });

    it('lists the registered projects and asks for --project when there are several', () => {
      const repoA = initRepo();
      const repoB = initRepo();
      const stale = initRepo();
      const idA = register(base, repoA);
      const idB = register(base, repoB);
      const idStale = register(base, stale);
      rmSync(stale, { recursive: true });

      let message = '';
      try {
        resolveProject(tempDir('pup-proj-nowhere-'));
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectResolutionError);
        message = (error as Error).message;
      }

      const lines = message.split('\n');
      expect(lines).toHaveLength(4);
      // The lines `pup project list` prints, less its conductor column (decision 62).
      expect(lines).toContain(`${idA}  ${repoA}  active`);
      expect(lines).toContain(`${idB}  ${repoB}  active`);
      expect(lines).toContain(`${idStale}  ${stale}  active  (missing)`);
      expect(lines[3]).toBe(
        'Not inside a git repository; pass --project <id> to pick one of these.',
      );
    });

    // repo_path is whatever the store says, and the listing lands on the
    // operator's terminal (decision 29).
    it('strips control characters from a repo_path before listing it', () => {
      const repoA = initRepo();
      const repoB = initRepo();
      register(base, repoA);
      register(base, repoB);
      const evil = '/gone/\u001b[2J\u001b[31mrepo';
      const planted = openStore(projectPaths(evil, base).dbFile);
      ensureProject(planted, projectId(evil), evil);
      planted.close();

      let message = '';
      try {
        resolveProject(tempDir('pup-proj-nowhere-'));
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).not.toContain('\u001b');
      expect(message).toContain(`${projectId(evil)}  /gone/ [2J [31mrepo  active  (missing)`);
    });

    // The store outlives temp repos; the one project still on disk is still
    // the only place a command could run.
    it('uses the one project still on disk silently when the others are gone', () => {
      const live = initRepo();
      register(base, live);
      const staleA = initRepo();
      const staleB = initRepo();
      register(base, staleA);
      register(base, staleB);
      rmSync(staleA, { recursive: true });
      rmSync(staleB, { recursive: true });

      const resolved = resolveProject(tempDir('pup-proj-nowhere-'));
      resolved.db.close();

      expect(resolved.repoPath).toBe(live);
    });

    it('refuses in one line naming the stale ids when every registered repo is gone', () => {
      const repoA = initRepo();
      const repoB = initRepo();
      const ids = [register(base, repoA), register(base, repoB)].sort();
      rmSync(repoA, { recursive: true });
      rmSync(repoB, { recursive: true });

      expect(() => resolveProject(tempDir('pup-proj-nowhere-'))).toThrow(
        new ProjectResolutionError(
          `Not inside a git repository and every registered project is missing its repo (${ids.join(', ')}); run pup init from the repo you want to control.`,
        ),
      );
    });
  });

  describe('by id', () => {
    it('selects a registered project from inside another repo', () => {
      const repo = initRepo();
      const id = register(base, repo);

      const resolved = resolveProject(initRepo(), id);
      resolved.db.close();

      expect(resolved.repoPath).toBe(repo);
    });

    it('refuses an unknown id in one line, naming what is registered', () => {
      const id = register(base, initRepo());

      expect(() => resolveProject(tempDir('pup-proj-nowhere-'), 'ghost')).toThrow(
        new ProjectResolutionError(`No project ghost; registered projects: ${id}.`),
      );
    });

    it('strips control characters from the id it echoes back', () => {
      register(base, initRepo());

      expect(() => resolveProject(tempDir('pup-proj-nowhere-'), 'gh\u001b[2Jost')).toThrow(
        /^No project gh \[2Jost; registered projects: /,
      );
    });

    it('refuses an unknown id when nothing is registered', () => {
      expect(() => resolveProject(tempDir('pup-proj-nowhere-'), 'ghost')).toThrow(
        'No project ghost; no project registered, run pup init from the repo you want to control.',
      );
    });

    it('reports a selected project whose repo is gone instead of using it', () => {
      const repo = initRepo();
      const id = register(base, repo);
      rmSync(repo, { recursive: true });

      expect(() => resolveProject(tempDir('pup-proj-nowhere-'), id)).toThrow(
        `Project ${id} is registered at ${repo}, which no longer exists`,
      );
    });
  });
});

describe('enclosingProject', () => {
  it('is the repo around cwd, and nothing outside one', () => {
    const repo = initRepo();

    const inside = enclosingProject(repo);
    inside?.db.close();

    expect(inside?.repoPath).toBe(repo);
    expect(enclosingProject(tempDir('pup-proj-nowhere-'))).toBeUndefined();
  });
});
