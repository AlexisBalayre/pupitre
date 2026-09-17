import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sanitizeReason } from '../adapters/capability.utils.js';
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
 * A smudge filter or merge driver armed through the untracked `info/attributes`
 * has no `-c` disarm at all — its driver name is chosen by whoever wrote it —
 * so it is refused rather than disarmed; see `armedGitDrivers` (decision 50).
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
 * The `-U0` hunk headers of one file's branch diff (merge-base diff): where
 * each hunk's added lines start, and how many lines it adds and deletes. One
 * diff per file so hunk headers are the only thing parsed — file names never
 * need de-quoting.
 */
function diffHunks(
  repoPath: string,
  target: string,
  branch: string,
  path: string,
): { start: number; added: number; deleted: number }[] {
  const patch = git(
    repoPath,
    'diff',
    ...DIFF_SAFE_FLAGS,
    '-U0',
    `${target}...${branch}`,
    '--',
    path,
  );
  const hunks: { start: number; added: number; deleted: number }[] = [];
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    hunks.push({
      start: Number(hunk[2]),
      added: hunk[3] === undefined ? 1 : Number(hunk[3]),
      deleted: hunk[1] === undefined ? 1 : Number(hunk[1]),
    });
  }
  return hunks;
}

/**
 * 1-based added/modified line numbers per changed file on the branch
 * (merge-base diff). Pure deletions yield no entry: deleted lines are free by
 * construction (decision 13).
 */
export function gitDiffAddedLines(
  repoPath: string,
  target: string,
  branch: string,
): Record<string, number[]> {
  const added: Record<string, number[]> = {};
  for (const path of gitDiffPaths(repoPath, target, branch)) {
    const lines: number[] = [];
    for (const hunk of diffHunks(repoPath, target, branch, path)) {
      for (let at = hunk.start; at < hunk.start + hunk.added; at++) lines.push(at);
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

/**
 * Git's own content rule for a binary file: a NUL in the first 8000 bytes
 * (`buffer_is_binary`). Everything else git calls binary, it was told to.
 */
const BINARY_SNIFF_BYTES = 8000;

/** Whether `<rev>:<path>` exists and is binary by content, never by attribute. */
function blobIsBinary(repoPath: string, rev: string, path: string): boolean {
  const spec = `${rev}:${path}`;
  try {
    git(repoPath, 'cat-file', '-e', spec);
  } catch {
    return false;
  }
  const blob = execFileSync('git', [...GIT_SAFE_CONFIG, '-C', repoPath, 'cat-file', 'blob', spec], {
    env: scrubbedGitEnv(),
    maxBuffer: GIT_MAX_BUFFER,
  });
  return blob.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * The add/delete counts `--numstat` withheld from a file it reported as
 * `-\t-`, or null when the file really is binary. `--text` does not restore a
 * numstat the way it restores a patch, and what git calls binary is not only
 * content: a `-diff` or `binary` attribute from `info/attributes` or a
 * `core.attributesFile`, or a `core.bigFileThreshold` below the file's size,
 * all written where no diff shows them, make every text file `-\t-` — and a
 * skipped null would then let a 5 000-line diff count as zero (decision 53).
 *
 * Content is the question, asked of both sides of the merge-base diff, because
 * the patch cannot answer it: `--text` parses hunks out of a real binary too,
 * so "binary but has hunks" would call every committed image forged.
 */
export function gitDiffBinaryRecount(
  repoPath: string,
  target: string,
  branch: string,
  path: string,
): { added: number; deleted: number } | null {
  const base = git(repoPath, 'merge-base', target, branch);
  if (blobIsBinary(repoPath, base, path) || blobIsBinary(repoPath, branch, path)) return null;
  let added = 0;
  let deleted = 0;
  for (const hunk of diffHunks(repoPath, target, branch, path)) {
    added += hunk.added;
    deleted += hunk.deleted;
  }
  return { added, deleted };
}

/**
 * The `filter` and `merge` config keys whose value is a command git runs.
 * Deliberately not the whole of either namespace: `merge.conflictstyle`,
 * `merge.ff` and `filter.<name>.required` execute nothing, and refusing on
 * them would refuse a repo whose operator set an ordinary preference.
 */
const ARMED_DRIVER_KEY = /^(?:filter\..+\.(?:clean|smudge|process)|merge\..+\.driver)$/;

/**
 * The config scopes a session can reach. Both files sit inside the shared
 * `$GIT_COMMON_DIR` — `config` and `config.worktree` for the main checkout,
 * `worktrees/<slug>/config.worktree` for a linked one — so both are writable
 * from a worktree with a plain `git config` and invisible to the scope hooks
 * and the gate. `global` and `system` are the operator's own and are theirs to
 * set; `command` is pup's own `GIT_SAFE_CONFIG`.
 */
const SESSION_WRITABLE_SCOPES = ['local', 'worktree'];

/** Armed surfaces named in a refusal before the count takes over. */
const ARMED_NAMES_SHOWN = 4;

export class ArmedGitDriverError extends Error {
  constructor(gitPath: string, armed: string[]) {
    const shown = armed.slice(0, ARMED_NAMES_SHOWN).join(', ');
    const rest = armed.length - ARMED_NAMES_SHOWN;
    super(
      `Refusing to run git in ${gitPath}: a filter or merge driver is armed, and git would ` +
        `run it with your environment — ${shown}${rest > 0 ? ` +${rest} more` : ''}. ` +
        'These live in the untracked $GIT_COMMON_DIR, so no diff and no scope audit shows ' +
        'them. Clear them (`git config --unset <key>`, `rm .git/info/attributes`) and retry, ' +
        'and treat a session that wrote them as compromised.',
    );
    this.name = 'ArmedGitDriverError';
  }
}

/**
 * What is armed, at the path git is about to run in, named for a refusal —
 * empty when nothing is. The two surfaces `GIT_SAFE_CONFIG` cannot cover: a
 * `filter.<name>.smudge` or `merge.<name>.driver` in the shared config, which
 * has no `-c` disarm because the driver name is chosen by whoever wrote it,
 * and the untracked `info/attributes` that attaches one. `git worktree add`
 * runs the smudge filter on every file it checks out and the gate's `git
 * rebase` runs both it and the merge driver, in each case before the sandbox
 * that is supposed to confine the session (decision 50).
 *
 * Attributes are reported on their own, without a matching driver: the file is
 * inert until a driver is named, but nothing else writes it, and `-diff`
 * patterns there already forge the diff the coverage stage reads.
 *
 * Read at the path the command will run in rather than only at the trusted
 * checkout, which is the opposite of decision 30's rule and safe here because
 * this measurement only ever adds findings — the config and the attributes
 * file are shared, so a worktree reports everything the main checkout does
 * plus its own worktree scope, and a session cannot aim the read somewhere
 * quieter than the one git itself will consult.
 */
export function armedGitDrivers(gitPath: string): string[] {
  const armed: string[] = [];
  const commonDir = git(gitPath, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const [pattern] = attributePatterns(join(commonDir, 'info', 'attributes'));
  if (pattern) armed.push(`info/attributes (${sanitizeReason(pattern)})`);
  // `--list --show-scope` rather than `--local --get-regexp`: `--worktree`
  // silently falls back to the local file when `extensions.worktreeConfig` is
  // off, so it cannot be read on its own, and one listing covers both scopes.
  // Entries are `<scope>\0<key>\n<value>\0`, so they come out in pairs.
  const listed = git(gitPath, 'config', '--list', '--show-scope', '-z').split('\0');
  for (let i = 0; i + 1 < listed.length; i += 2) {
    const [key] = (listed[i + 1] as string).split('\n');
    if (!SESSION_WRITABLE_SCOPES.includes(listed[i] as string)) continue;
    if (key && ARMED_DRIVER_KEY.test(key)) armed.push(sanitizeReason(key));
  }
  return armed;
}

/** Pattern lines of an attributes file — blank lines and comments are inert. */
function attributePatterns(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Refuse to run git at `gitPath` while a filter or merge driver is armed.
 * Decision 6's loud-backstop shape: there is no disarm to fall back on, so the
 * only honest answer is to stop and name what is armed (decision 50).
 */
export function assertNoArmedGitDrivers(gitPath: string): void {
  const armed = armedGitDrivers(gitPath);
  if (armed.length > 0) throw new ArmedGitDriverError(gitPath, armed);
}
