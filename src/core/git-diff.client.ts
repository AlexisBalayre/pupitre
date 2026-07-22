import { execFileSync } from 'node:child_process';

export interface DiffFileStat {
  path: string;
  /** null for binary files (git reports `-`). */
  added: number | null;
  deleted: number | null;
}

/**
 * Environment without the GIT_DIR family: when pup itself runs inside a git
 * hook, those inherited vars would point every child git call (and any git
 * usage in gate commands) at the hook's repo instead of the target path.
 */
export function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const scrubbed = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !scrubbed.includes(key)));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: scrubbedGitEnv(),
  }).trim();
}

/**
 * Repo-relative paths changed on the branch (merge-base diff). NUL-delimited
 * (`-z`) so git never C-quotes non-ASCII names — the scope audit must see the
 * exact byte paths, or a quoted `.claude/…` path would slip past the
 * protected-glob backstop.
 */
export function gitDiffPaths(repoPath: string, target: string, branch: string): string[] {
  return git(repoPath, 'diff', '-z', '--name-only', `${target}...${branch}`)
    .split('\0')
    .filter(Boolean);
}

/** Per-file add/delete counts for the branch diff (merge-base diff), rename-aware. */
export function gitDiffNumstat(repoPath: string, target: string, branch: string): DiffFileStat[] {
  // With -z, a renamed entry is "added\tdeleted\t" followed by the old and new
  // paths as two separate NUL fields.
  const fields = git(repoPath, 'diff', '-z', '--numstat', `${target}...${branch}`).split('\0');
  const stats: DiffFileStat[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const [added, deleted, inlinePath] = field.split('\t');
    const path = inlinePath || fields[i + 2];
    if (!inlinePath) i += 2;
    if (!path) continue;
    stats.push({
      path,
      added: added === '-' ? null : Number(added),
      deleted: deleted === '-' ? null : Number(deleted),
    });
  }
  return stats;
}
