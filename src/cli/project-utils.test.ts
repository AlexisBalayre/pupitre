import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../core/db.client.js';
import { projectId, projectPaths } from '../core/paths.utils.js';
import { ensureProject } from '../core/session.repository.js';
import {
  enclosingProject,
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
      { id, repoPath: repo, dbFile: projectPaths(repo, base).dbFile, repoExists: true },
    ]);
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

describe('resolveProject', () => {
  let base: string;

  beforeEach(() => {
    base = tempDir('pup-proj-home-');
    // The store lives under homedir(); a throwaway HOME keeps the developer's
    // real ~/.pupitre out of every case below.
    vi.stubEnv('HOME', base);
    base = join(base, '.pupitre');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
      expect(lines).toContain(`${idA}  ${repoA}`);
      expect(lines).toContain(`${idB}  ${repoB}`);
      expect(lines).toContain(`${idStale}  ${stale}  (missing)`);
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
      expect(message).toContain(`${projectId(evil)}  /gone/ [2J [31mrepo  (missing)`);
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
