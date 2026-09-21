import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { failureSummary, sanitizeReason } from '../adapters/capability.utils.js';
import { isConductorRunning } from '../core/conductor.service.js';
import { openStore } from '../core/db.client.js';
import { GIT_SAFE_CONFIG, scrubbedGitEnv } from '../core/git-diff.client.js';
import { projectId, projectPaths } from '../core/paths.utils.js';

export interface ResolvedProject {
  repoPath: string;
  db: Database.Database;
}

/** A project `pup init` registered, read back from its own store under `~/.pupitre`. */
interface RegisteredProject {
  id: string;
  repoPath: string;
  dbFile: string;
  /** False when the repo was deleted or moved since it registered — reported, never used. */
  repoExists: boolean;
  /** When the operator put the project to sleep, or null while it is active (decision 62). */
  dormantAt: string | null;
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
 * `LC_ALL=C` keeps that message in English so `enclosingProject` can
 * recognise it under a translated git.
 */
function repoRoot(cwd: string): string {
  const commonDir = execFileSync(
    'git',
    [...GIT_SAFE_CONFIG, '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    {
      encoding: 'utf8',
      env: { ...scrubbedGitEnv(), LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
  return commonDir.replace(/\/\.git\/?$/, '');
}

interface ProjectRow {
  id: string;
  repo_path: string;
  dormant_at: string | null;
}

/**
 * The project rows a store holds, read without touching it: no schema, no
 * migrations, no `-wal` created — this runs against every store under the
 * base, including ones a session wrote or a stray file dropped there, and a
 * store that cannot be read is no project rather than every command's crash.
 * It is said once on stderr, not swallowed: a project that vanishes from the
 * listing because its store lost its permissions is otherwise a mystery. An
 * empty `projects` table is a store `pup status` created and is silent. A
 * store no pup has opened since `dormant_at` was added has no such column,
 * and reads as active until its next open migrates it (decision 62).
 */
function readProjectRows(dbFile: string): ProjectRow[] {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
    const columns = db.pragma('table_info(projects)') as { name: string }[];
    const dormantAt = columns.some((column) => column.name === 'dormant_at')
      ? 'dormant_at'
      : 'NULL AS dormant_at';
    return db
      .prepare(`SELECT id, repo_path, ${dormantAt} FROM projects ORDER BY id`)
      .all() as ProjectRow[];
  } catch (error) {
    console.error(`Skipping unreadable store ${sanitizeReason(dbFile)}: ${failureSummary(error)}`);
    return [];
  } finally {
    db?.close();
  }
}

/**
 * A row answers for the directory it sits in only when both its id and the
 * hash of its own `repo_path` are that directory's name: ids are derived, so
 * a row that fails to derive is a store planted or renamed to answer for a
 * repo it is not keyed to (decision 43).
 */
function keyedTo(dirName: string, row: ProjectRow): boolean {
  return [row.id, projectId(row.repo_path)].every((id) => id === dirName);
}

/**
 * Every project registered in the store, one directory per project id under
 * `~/.pupitre` (the base `projectPaths` defaults to), each holding its own
 * `state.db` with its own `projects` row. A directory with no store — one
 * `pup report` wrote into, or a leftover — is not a project.
 */
export function listRegisteredProjects(base = join(homedir(), '.pupitre')): RegisteredProject[] {
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((name) => ({ name, dbFile: join(base, name, 'state.db') }))
    .filter(({ dbFile }) => existsSync(dbFile))
    .flatMap(({ name, dbFile }) =>
      readProjectRows(dbFile)
        .filter((row) => keyedTo(name, row))
        .map((row) => ({
          id: row.id,
          repoPath: row.repo_path,
          dbFile,
          repoExists: existsSync(row.repo_path),
          dormantAt: row.dormant_at,
        })),
    );
}

/**
 * One registered project as `pup project list` prints it, and as decision
 * 43's refusal lists the choices: id, repo, dormant or active, and whether its
 * conductor runs, with a gone repo marked. Everything a store wrote goes
 * through decision 29's sanitizing — the store is foreign to whoever reads the
 * registry (decision 62).
 */
export function registryLine(project: RegisteredProject): string {
  const state =
    project.dormantAt === null ? 'active' : `dormant since ${sanitizeReason(project.dormantAt)}`;
  const conductor = isConductorRunning(project.repoPath)
    ? 'conductor running'
    : 'conductor stopped';
  const missing = project.repoExists ? '' : '  (missing)';
  return `${project.id}  ${sanitizeReason(project.repoPath)}  ${state}  ${conductor}${missing}`;
}

/**
 * A registered project's ids are hex by construction (they hash-match their
 * directory), but its `repo_path` is whatever the store says and the
 * `--project` argument is whatever argv says; both reach the operator's
 * terminal only through here (decision 29).
 */
export function openRegistered(project: RegisteredProject): ResolvedProject {
  if (!project.repoExists) {
    throw new ProjectResolutionError(
      `Project ${project.id} is registered at ${sanitizeReason(project.repoPath)}, which no longer exists; ${INIT_HINT}`,
    );
  }
  return { repoPath: project.repoPath, db: openStore(project.dbFile) };
}

function selectById(id: string, registered: RegisteredProject[]): ResolvedProject {
  const project = registered.find((candidate) => candidate.id === id);
  if (project) return openRegistered(project);
  const known = registered.map((candidate) => candidate.id).join(', ');
  const shown = sanitizeReason(id);
  throw new ProjectResolutionError(
    known
      ? `No project ${shown}; registered projects: ${known}.`
      : `No project ${shown}; no project registered, ${INIT_HINT}`,
  );
}

/**
 * Only projects whose repo still exists count toward "exactly one": a store
 * that has outlived a few temp repos still names one place to run, and a
 * project with no repo behind it could never have been the answer.
 */
function selectTheOnlyOne(registered: RegisteredProject[]): ResolvedProject {
  const live = registered.filter((project) => project.repoExists);
  if (live.length === 1) {
    const chosen = live[0] as RegisteredProject;
    // The choice was pup's, so it is said: the command's output otherwise
    // reads as if the operator had named the project.
    console.error(`Using project ${chosen.id} at ${sanitizeReason(chosen.repoPath)}`);
    return openRegistered(chosen);
  }
  if (live.length === 0) {
    const stale = registered.map((project) => project.id).join(', ');
    throw new ProjectResolutionError(
      registered.length === 0
        ? `Not inside a git repository and no project registered; ${INIT_HINT}`
        : `Not inside a git repository and every registered project is missing its repo (${stale}); ${INIT_HINT}`,
    );
  }
  throw new ProjectResolutionError(
    [
      ...registered.map(registryLine),
      'Not inside a git repository; pass --project <id> to pick one of these.',
    ].join('\n'),
  );
}

/**
 * Every registered project, for the fleet view: `pup status` outside a repo or
 * with `--all`, the one reader decision 60 lets cross stores. A project whose
 * repo is gone is still listed, for the reader to mark missing without opening
 * its store; an empty fleet refuses, since there is nothing to show and the
 * fix is the operator's.
 */
export function fleetProjects(): RegisteredProject[] {
  const registered = listRegisteredProjects();
  if (registered.length === 0)
    throw new ProjectResolutionError(`No project registered; ${INIT_HINT}`);
  return registered;
}

/**
 * The project of the repo around cwd, or undefined outside any — never the
 * store's guess. This is where a session's own guards live: its worktree and
 * its `PUP_SESSION_ID` are rows in this store and no other.
 */
export function enclosingProject(cwd = process.cwd()): ResolvedProject | undefined {
  let repoPath: string;
  try {
    repoPath = repoRoot(cwd);
  } catch (error) {
    // Outside any repo is the one git failure that is an answer, not an error.
    const stderr = (error as { stderr?: unknown }).stderr;
    if (String(stderr).includes('not a git repository')) return undefined;
    throw error;
  }
  return { repoPath, db: openStore(projectPaths(repoPath).dbFile) };
}

/**
 * The project a command runs against, the one seam every command goes
 * through. `--project <id>` wins from anywhere, even inside another repo;
 * otherwise the repo around cwd, unchanged from before; outside any repo the
 * store decides only when it cannot be wrong — exactly one project — and
 * refuses with the choices otherwise (decision 43).
 */
export function resolveProject(cwd = process.cwd(), selectedId?: string): ResolvedProject {
  if (selectedId !== undefined) return selectById(selectedId, listRegisteredProjects());
  return enclosingProject(cwd) ?? selectTheOnlyOne(listRegisteredProjects());
}
