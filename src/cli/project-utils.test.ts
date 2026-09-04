import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../core/db.client.js';
import { projectId, projectPaths } from '../core/paths.utils.js';
import { ensureProject } from '../core/session.repository.js';
import { listRegisteredProjects, ProjectResolutionError, resolveProject } from './project.utils.js';

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
      const idA = register(base, repoA);
      const idB = register(base, repoB);
      rmSync(repoB, { recursive: true });

      let message = '';
      try {
        resolveProject(tempDir('pup-proj-nowhere-'));
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectResolutionError);
        message = (error as Error).message;
      }

      const lines = message.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines).toContain(`${idA}  ${repoA}`);
      expect(lines).toContain(`${idB}  ${repoB}  (missing)`);
      expect(lines[2]).toBe(
        'Not inside a git repository; pass --project <id> to pick one of these.',
      );
    });

    it('reports the only project instead of using it when its repo is gone', () => {
      const repo = initRepo();
      const id = register(base, repo);
      rmSync(repo, { recursive: true });

      expect(() => resolveProject(tempDir('pup-proj-nowhere-'))).toThrow(
        `Project ${id} is registered at ${repo}, which no longer exists; run pup init from the repo you want to control.`,
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
