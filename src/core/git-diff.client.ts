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
 * `core.hooksPath` is decision 28's. The rest are the keys decision 41's
 * review found git consulting on the commands pup runs, each verified against
 * Apple Git 2.39.5: `core.fsmonitor` runs on any index read (`ls-files`,
 * `status`) and `hooksPath` does not stop it — the `=` is load-bearing, since
 * `-c core.fsmonitor` alone means `true`; `gpg.program` runs once per commit
 * the gate's rebase recreates whenever `commit.gpgsign` is on, and clearing
 * the sign flag is the lever, because `gpg.program` has no safe empty value.
 * `diff.external` and `textconv` are disarmed per diff call instead — see
 * `git()` below — because an empty `diff.external` makes every diff die.
 *
 * Not covered, and stated as decision 41's ceiling: a smudge filter armed
 * through the untracked `info/attributes`, which runs on `worktree add` and
 * the rebase and has no `-c` disarm because its driver name is chosen by
 * whoever wrote it.
 */
export const GIT_SAFE_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
] as const;

/**
 * Diff-subcommand flags (they are not accepted at top level) that keep a
 * session-written config from blanking the `-U0` patch `gitDiffAddedLines`
 * parses — an empty patch reads as "no instrumentable changed lines", a pass.
 * Each was reproduced against the shipped function: `--no-ext-diff` covers
 * `diff.external` and `diff.<driver>.command`, `--no-textconv` the textconv
 * drivers, `--no-color` a `color.ui=always` that forces ANSI through the pipe
 * so no line starts with `@@`, and `--text` a `* -diff` attribute or
 * `diff.<driver>.binary` that turns every file into "Binary files differ".
 * `--text` is safe for a real binary because `patchCoverage` only counts
 * files the coverage report instruments.
 */
const DIFF_SAFE_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--text'] as const;

/**
 * Node's default is 1 MiB, which `--text` on a large committed binary would
 * exceed and turn into a throw mid-gate; 64 MiB covers any patch worth
 * parsing and still fails loudly rather than silently truncating.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_SAFE_CONFIG, '-C', cwd, ...args], {
    encoding: 'utf8',
    env: scrubbedGitEnv(),
    maxBuffer: GIT_MAX_BUFFER,
  }).trim();
}

/**
 * Repo-relative paths changed on the branch (merge-base diff). NUL-delimited
 * (`-z`) so git never C-quotes non-ASCII names — the scope audit must see the
 * exact byte paths, or a quoted `.claude/…` path would slip past the
 * protected-glob backstop.
 */
export function gitDiffPaths(repoPath: string, target: string, branch: string): string[] {
  return git(repoPath, 'diff', ...DIFF_SAFE_FLAGS, '-z', '--name-only', `${target}...${branch}`)
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
    const patch = git(
      repoPath,
      'diff',
      ...DIFF_SAFE_FLAGS,
      '-U0',
      `${target}...${branch}`,
      '--',
      path,
    );
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
  const fields = git(
    repoPath,
    'diff',
    ...DIFF_SAFE_FLAGS,
    '-z',
    '--numstat',
    `${target}...${branch}`,
  ).split('\0');
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
