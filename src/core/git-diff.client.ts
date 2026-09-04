import { execFileSync } from 'node:child_process';

import type { DiffFileStat } from './types/git-diff.types.js';

export type { DiffFileStat };

/**
 * Environment without the GIT_DIR family: when pup itself runs inside a git
 * hook, those inherited vars would point every child git call (and any git
 * usage in gate commands) at the hook's repo instead of the target path.
 */
export function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const scrubbed = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !scrubbed.includes(key)));
}

/**
 * The config every pup git call overrides, the argv half of `scrubbedGitEnv`.
 * Linked worktrees share `$GIT_COMMON_DIR/config` and `.git/**` is untracked,
 * so a session can set either of these keys without the scope hooks or the
 * gate seeing it, and the operator's next git call would run what it names.
 *
 * `core.hooksPath` is decision 28's. `core.fsmonitor` is a second command git
 * runs on any index read and `hooksPath` does not cover it: verified against
 * Apple Git 2.39.5, where a plain `git ls-files` executes it, `-c
 * core.hooksPath=/dev/null` still executes it, and only clearing it does not.
 */
export const GIT_SAFE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor='] as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_SAFE_CONFIG, '-C', cwd, ...args], {
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

/**
 * 1-based added/modified line numbers per changed file on the branch
 * (merge-base diff). One `-U0` diff per file so hunk headers are the only
 * thing parsed — file names never need de-quoting. Pure deletions yield no
 * entry: deleted lines are free by construction (decision 13).
 */
export function gitDiffAddedLines(
  repoPath: string,
  target: string,
  branch: string,
): Record<string, number[]> {
  const added: Record<string, number[]> = {};
  for (const path of gitDiffPaths(repoPath, target, branch)) {
    const lines: number[] = [];
    const patch = git(repoPath, 'diff', '-U0', `${target}...${branch}`, '--', path);
    for (const line of patch.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk) continue;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let at = start; at < start + count; at++) lines.push(at);
    }
    if (lines.length > 0) added[path] = lines;
  }
  return added;
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
