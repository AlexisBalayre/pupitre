import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import { openStore } from '../core/db.client.js';
import { projectPaths } from '../core/paths.utils.js';

export interface ResolvedProject {
  repoPath: string;
  db: Database;
}

/** Resolve the main repo path from the current directory, even inside a worktree. */
export function repoRoot(cwd = process.cwd()): string {
  const commonDir = execFileSync(
    'git',
    ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8' },
  ).trim();
  return commonDir.replace(/\/\.git\/?$/, '');
}

export function resolveProject(cwd = process.cwd()): ResolvedProject {
  const repoPath = repoRoot(cwd);
  const db = openStore(projectPaths(repoPath).dbFile);
  return { repoPath, db };
}
