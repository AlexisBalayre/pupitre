import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openStore } from '../core/db.client.js';
import { GIT_SAFE_CONFIG, scrubbedGitEnv } from '../core/git-diff.client.js';
import { projectPaths } from '../core/paths.utils.js';

export interface ResolvedProject {
  repoPath: string;
  db: Database;
}

/** A project `pup init` registered, read back from its own store under `~/.pupitre`. */
export interface RegisteredProject {
  id: string;
  repoPath: string;
  dbFile: string;
  /** False when the repo was deleted or moved since it registered — reported, never used. */
  repoExists: boolean;
}

/**
 * The CLI refuses with this message and exit 1, no stack: every case is the
 * operator's to resolve (cd into a repo, `pup init`, or `--project <id>`),
 * not a bug (decision 43).
 */
export class ProjectResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectResolutionError';
  }
}

const INIT_HINT = 'run pup init from the repo you want to control.';

/**
 * Resolve the main repo path from the current directory, even inside a
 * worktree. stderr is captured, not echoed: outside a repo git's own "fatal:
 * not a git repository" is the expected outcome, and pup speaks for it.
 */
function repoRoot(cwd: string): string {
  const commonDir = execFileSync(
    'git',
    [...GIT_SAFE_CONFIG, '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', env: scrubbedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  return commonDir.replace(/\/\.git\/?$/, '');
}

/** The repo around cwd, or undefined outside any — every other git failure still throws. */
function enclosingRepoRoot(cwd: string): string | undefined {
  try {
    return repoRoot(cwd);
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (String(stderr).includes('not a git repository')) return undefined;
    throw error;
  }
}

/**
 * Every project registered in the store, one directory per project id under
 * `~/.pupitre` (the base `projectPaths` defaults to), each holding its own
 * `state.db` with its own `projects` row. A directory with no store — one
 * `pup report` wrote into, or a leftover — is not a project.
 */
export function listRegisteredProjects(base = join(homedir(), '.pupitre')): RegisteredProject[] {
  if (!existsSync(base)) return [];
  const projects: RegisteredProject[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const dbFile = join(base, entry.name, 'state.db');
    if (!entry.isDirectory() || !existsSync(dbFile)) continue;
    const db = openStore(dbFile);
    try {
      const rows = db.prepare('SELECT id, repo_path FROM projects ORDER BY id').all() as {
        id: string;
        repo_path: string;
      }[];
      for (const row of rows) {
        projects.push({
          id: row.id,
          repoPath: row.repo_path,
          dbFile,
          repoExists: existsSync(row.repo_path),
        });
      }
    } finally {
      db.close();
    }
  }
  return projects;
}

function openRegistered(project: RegisteredProject): ResolvedProject {
  if (!project.repoExists) {
    throw new ProjectResolutionError(
      `Project ${project.id} is registered at ${project.repoPath}, which no longer exists; ${INIT_HINT}`,
    );
  }
  return { repoPath: project.repoPath, db: openStore(project.dbFile) };
}

function selectById(id: string, registered: RegisteredProject[]): ResolvedProject {
  const project = registered.find((candidate) => candidate.id === id);
  if (project) return openRegistered(project);
  const known = registered.map((candidate) => candidate.id).join(', ');
  throw new ProjectResolutionError(
    known
      ? `No project ${id}; registered projects: ${known}.`
      : `No project ${id}; no project registered, ${INIT_HINT}`,
  );
}

/**
 * Only projects whose repo still exists count toward "exactly one": a store
 * that has outlived a few temp repos still names one place to run, and a
 * project with no repo behind it could never have been the answer.
 */
function selectTheOnlyOne(registered: RegisteredProject[]): ResolvedProject {
  const live = registered.filter((project) => project.repoExists);
  if (live.length === 1) return openRegistered(live[0] as RegisteredProject);
  if (live.length === 0) {
    const stale = registered.map((project) => project.id).join(', ');
    throw new ProjectResolutionError(
      registered.length === 0
        ? `Not inside a git repository and no project registered; ${INIT_HINT}`
        : `Not inside a git repository and every registered project is missing its repo (${stale}); ${INIT_HINT}`,
    );
  }
  const listing = registered.map(
    (project) => `${project.id}  ${project.repoPath}${project.repoExists ? '' : '  (missing)'}`,
  );
  throw new ProjectResolutionError(
    [...listing, 'Not inside a git repository; pass --project <id> to pick one of these.'].join(
      '\n',
    ),
  );
}

/**
 * The project a command runs against, the one seam every command goes
 * through. `--project <id>` wins from anywhere, even inside another repo;
 * otherwise the repo around cwd, unchanged from before; outside any repo the
 * store decides only when it cannot be wrong — exactly one project — and
 * refuses with the choices otherwise (decision 43).
 */
export function resolveProject(cwd = process.cwd(), projectId?: string): ResolvedProject {
  if (projectId !== undefined) return selectById(projectId, listRegisteredProjects());
  const repoPath = enclosingRepoRoot(cwd);
  if (repoPath !== undefined) return { repoPath, db: openStore(projectPaths(repoPath).dbFile) };
  return selectTheOnlyOne(listRegisteredProjects());
}
