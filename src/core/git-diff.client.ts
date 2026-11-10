import { type ExecFileSyncOptions, execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { sanitizeReason } from '../adapters/capability.utils.js';
import {
  type BinaryFormat,
  formatsNamed,
  knownBinarySize,
  mayBeKnownBinary,
  spendKnownBinarySkip,
} from './known-binary.utils.js';
import { shellWord } from './shell-quote.utils.js';
import type { DiffFileStat } from './types/git-diff.types.js';

export type { DiffFileStat };

/**
 * Environment without the GIT_DIR family: when pup itself runs inside a git
 * hook, those inherited vars would point every child git call (and any git
 * usage in gate commands) at the hook's repo instead of the target path.
 * Without the config git takes from the environment too: a session window
 * sets `diff.ignoreSubmodules=all` that way (decision 101), and a pup run from
 * it, its tests included, would otherwise inherit it into the scope audit's
 * diff and stop seeing a gitlink change.
 */
function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const scrubbed = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !scrubbed.includes(key) && !ENV_CONFIG_KEY.test(key),
    ),
  );
}

/** The variables git reads command-scope config from. */
const ENV_CONFIG_KEY = /^GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/;

/** The three variables that pin git to a session worktree's trusted dirs (decision 101). */
export interface WorktreeGitEnv {
  GIT_DIR: string;
  GIT_COMMON_DIR: string;
  GIT_WORK_TREE: string;
}

/**
 * The admin and common dirs pup trusts for a session worktree, as git
 * variables (decision 101). A linked worktree finds its repo through two files
 * the session can write from inside the sandbox — its `.git` gitfile and the
 * admin dir's `commondir` — so git run there outside the sandbox would read
 * the config, attributes and index of a repo the session chose, and run the
 * `filter.<x>.clean` or `core.fsmonitor` it arms, which no `-c` can disarm.
 * With all three set git reads neither file. Neither is read here either: the
 * common dir is the main checkout's `.git`, resolved as `git worktree add`
 * records it, and the admin dir is named after the worktree, as `worktree add`
 * names it. A `.git` that does not exist yet (a compile runs before the
 * worktree is added) is used as given, which the pointer check then refuses.
 */
export function worktreeGitEnv(repoPath: string, worktreePath: string): WorktreeGitEnv {
  const dotGit = join(repoPath, '.git');
  const commonDir = existsSync(dotGit) ? realpathSync(dotGit) : dotGit;
  return {
    GIT_DIR: join(commonDir, 'worktrees', basename(worktreePath)),
    GIT_COMMON_DIR: commonDir,
    GIT_WORK_TREE: worktreePath,
  };
}

/** Larger than any pointer git writes; a bigger file is not one. */
export const POINTER_MAX_BYTES = 4096;

/**
 * A session-writable file's text when it is a regular file of at most
 * `maxBytes`; `missing` when nothing is there to read, as git finds it; and
 * `irregular` for anything else — a symlink, a fifo, a directory, a file too
 * big, or one that cannot be opened. Opened without following a symlink and
 * without blocking, so a fifo planted before or swapped in after a check
 * cannot hang node in `open()`, where no signal pup handles gets it out.
 */
function readRegularFile(
  path: string,
  maxBytes: number,
): { text: string } | 'missing' | 'irregular' {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'irregular';
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return 'irregular';
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return { text: buffer.subarray(0, read).toString('utf8') };
  } finally {
    closeSync(fd);
  }
}

/** A pointer file's text, without the newline git ends it with, or undefined when it is not a regular file. */
function readPointer(path: string): string | undefined {
  const read = readRegularFile(path, POINTER_MAX_BYTES);
  return typeof read === 'object' ? read.text.replace(/\n$/, '') : undefined;
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** What a refusal over rewritten pointers asks the operator to do, unless its caller knows better. */
const REPAIR_ADVICE =
  'Restore them (`git -c worktree.useRelativePaths=false worktree repair` from the main ' +
  'checkout) and retry';

/**
 * Kept in its parts, so a caller that has already undone what `advice` would
 * fix (a launch that removed its new worktree) re-raises the same refusal with
 * advice of its own, rather than one message asking for both.
 */
export class WorktreeRepointedError extends Error {
  constructor(
    readonly worktreePath: string,
    readonly problem: string,
    advice: string = REPAIR_ADVICE,
  ) {
    super(
      `Refusing to run git in ${sanitizeReason(worktreePath)}: ${problem}. ${advice}, and ` +
        'treat the session that did it as compromised.',
    );
    this.name = 'WorktreeRepointedError';
  }
}

/** What turned per-worktree config on: the file, the extension, or a value git cannot read. */
type WorktreeConfigCause = 'file' | 'on' | 'unreadable';

export class WorktreeConfigError extends Error {
  constructor(repoPath: string, cause: WorktreeConfigCause) {
    const dotGit = join(repoPath, '.git');
    const config = sanitizeReason(join(dotGit, 'config'));
    const problem =
      cause === 'file'
        ? `${sanitizeReason(join(dotGit, 'config.worktree'))} exists`
        : cause === 'on'
          ? `extensions.worktreeConfig is on in ${config}`
          : `extensions.worktreeConfig is on, or holds a value git cannot read, in ${config}`;
    // Pasted, the line must name the very file: sanitizeReason folds runs of
    // whitespace, blanks control chars and truncates, so a path it changes is
    // left for the operator to type rather than printed as another file.
    const raw = join(dotGit, 'config');
    const unset =
      config === raw
        ? `\`git -C / config --file ${shellWord(raw)} --unset-all extensions.worktreeConfig\``
        : '`git -C / config --file <repo>/.git/config --unset-all extensions.worktreeConfig` ' +
          "with <repo> typed by hand, as the repo's path holds characters this message cannot " +
          'show as they are';
    // `disable` turns the extension back on, so the unset comes after it, and
    // again after it when git needed the unset first to open the repo at all.
    const steps =
      cause === 'unreadable'
        ? `${unset} first (\`-C /\`: git opens the repo for nothing else while the value is ` +
          'unreadable), then `git sparse-checkout disable` if the checkout is sparse and, as ' +
          'that turns the extension back on, the unset again'
        : `\`git sparse-checkout disable\` if the checkout is sparse, then ${unset}`;
    super(
      `Refusing to launch a session in ${sanitizeReason(repoPath)}: ${problem}. Usually ` +
        '`git sparse-checkout` or `git clone --sparse` turned per-worktree config on, and with ' +
        "it on a session's git would read a config.worktree the session can write (decision " +
        '101). If no sparse checkout ran here, a session may have written it: inspect ' +
        '.git/config and .git/config.worktree before removing anything, and treat a session ' +
        `that wrote them as compromised. Otherwise run ${steps}, remove .git/config.worktree, ` +
        'and retry.',
    );
    this.name = 'WorktreeConfigError';
  }
}

/**
 * `worktreeGitEnv`, once the worktree's pointers are checked with filesystem
 * reads alone: `<worktree>/.git` is a regular file reading `gitdir: <admin
 * dir>`, the admin dir is its own realpath, and its `commondir` resolves to
 * the common dir. Pinned git would not follow a rewritten pointer anyway; the
 * check is what makes the rewrite loud, since everything that runs git there
 * unpinned — the session's own window, the operator's shell — would follow it.
 *
 * Pinned git still reads one file a session can write, `<admin dir>/config.worktree`,
 * whenever `extensions.worktreeConfig` is on, and it takes a filter or an
 * `include.path` like any config. So the check also refuses while the file
 * exists or the extension is on: off, git never reads the file. The extension
 * lives in the common dir's config, which this takes to be out of a session's
 * reach; where it is not (decision 41's exposure), no pin holds anyway.
 */
export function verifiedWorktreeGitEnv(repoPath: string, worktreePath: string): WorktreeGitEnv {
  const env = worktreeGitEnv(repoPath, worktreePath);
  const gitfile = readPointer(join(worktreePath, '.git'));
  const commondir = readPointer(join(env.GIT_DIR, 'commondir'));
  if (
    gitfile !== `gitdir: ${env.GIT_DIR}` ||
    realpathOrUndefined(env.GIT_DIR) !== env.GIT_DIR ||
    commondir === undefined ||
    realpathOrUndefined(resolve(env.GIT_DIR, commondir)) !== env.GIT_COMMON_DIR
  ) {
    throw new WorktreeRepointedError(
      worktreePath,
      `its .git no longer names ${sanitizeReason(env.GIT_DIR)}, or that admin dir's ` +
        `commondir no longer names ${sanitizeReason(env.GIT_COMMON_DIR)}. A session can ` +
        'rewrite both from inside its sandbox, and any git that followed them would run the ' +
        'filters of a repo it chose',
    );
  }
  if (
    lstatSync(join(env.GIT_DIR, 'config.worktree'), { throwIfNoEntry: false }) ||
    worktreeConfigState(worktreePath, env.GIT_COMMON_DIR, env) !== 'off'
  ) {
    throw new WorktreeRepointedError(
      worktreePath,
      `git would read ${sanitizeReason(join(env.GIT_DIR, 'config.worktree'))}, which a ` +
        'session can write from inside its sandbox: the file exists, or ' +
        `extensions.worktreeConfig is on in ${sanitizeReason(join(env.GIT_COMMON_DIR, 'config'))}`,
      'Remove the file and turn the extension off, then retry',
    );
  }
  return env;
}

/**
 * Check out `rev` into a worktree `worktree add --no-checkout` just cut, with
 * git pinned to the dirs pup trusts, checked first (decision 101). A plain add
 * writes the admin dir's `commondir`, then checks out in a child git that
 * reads it back before any check could run, and a session can write under
 * `<common>/worktrees/`. `--no-sparse-checkout`, because a planted
 * `core.sparseCheckout` would leave committed files out; `--reset`, because
 * the new index is empty.
 */
export function checkoutPinned(
  repoPath: string,
  worktreePath: string,
  rev: string,
): WorktreeGitEnv {
  const git = verifiedWorktreeGitEnv(repoPath, worktreePath);
  runGit(
    worktreePath,
    ['read-tree', '--no-recurse-submodules', '--no-sparse-checkout', '--reset', '-u', rev],
    { env: { ...git } },
  );
  return git;
}

/**
 * Refuse a launch while git would read per-worktree config in the repo: the
 * extension is on in its `.git/config`, or `.git/config.worktree` exists.
 * `verifiedWorktreeGitEnv` refuses such a repo too, but only once `startSession`
 * has added the worktree and written the session row, which then block a
 * retry, so a launch asks here before either (decision 101). The operator's
 * `git sparse-checkout` is the usual cause, not the only one: a session that
 * can write the shared config can turn the extension on and arm a driver in
 * `config.worktree`, which this refusal then meets before the driver check.
 * A repo whose `.git` is a gitfile is refused here too, before anything is
 * written: none of the paths pup trusts exists under it.
 */
export function assertNoWorktreeConfig(repoPath: string): void {
  const dotGit = join(repoPath, '.git');
  // Every path pup trusts is built as `<repo>/.git/...`, the pins included.
  // Under a gitfile those name nothing: this check would read no config, and
  // the pointer check would refuse only once the row and the worktree exist.
  if (!statSync(dotGit, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `Refusing to launch a session in ${sanitizeReason(repoPath)}: its .git is not a ` +
        'directory. pup pins a session to the repository at <repo>/.git (decision 101), so it ' +
        'launches from a main checkout only, never from a linked worktree, a submodule or a ' +
        '`--separate-git-dir` clone, whose .git is a gitfile. Run it from the main checkout.',
    );
  }
  // The extension first: `git sparse-checkout` writes the file too, and while
  // the value is unreadable only the hint that leads with the unset works.
  const extension = worktreeConfigState(repoPath, dotGit);
  if (extension !== 'off') throw new WorktreeConfigError(repoPath, extension);
  if (lstatSync(join(dotGit, 'config.worktree'), { throwIfNoEntry: false })) {
    throw new WorktreeConfigError(repoPath, 'file');
  }
}

/**
 * Whether the common dir's own config turns `extensions.worktreeConfig` on, as
 * git reads it for the repository format: that file alone, no includes. A
 * value git cannot read as a boolean is `unreadable`, which counts as on.
 */
function worktreeConfigState(
  gitPath: string,
  commonDir: string,
  env?: WorktreeGitEnv,
): 'off' | 'on' | 'unreadable' {
  try {
    const value = runGit(
      gitPath,
      [
        'config',
        '--file',
        join(commonDir, 'config'),
        '--type',
        'bool',
        '--get',
        'extensions.worktreeConfig',
      ],
      { env: env ? { ...env } : undefined, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return value.trim() === 'false' ? 'off' : 'on';
  } catch (error) {
    rethrowIfKilled(error);
    // Exit 1 is git's "no such key"; anything else is a config it could not read.
    return typeof error === 'object' && error !== null && 'status' in error && error.status === 1
      ? 'off'
      : 'unreadable';
  }
}

/**
 * The config every pup git call overrides, the argv half of `scrubbedGitEnv`.
 * `runGit` is the one place pup's own calls apply it (decision 73); the only
 * other reader is the profile compiler, which renders it into the generated
 * hooks' `safe_git` so the git a session's hooks run is pinned the same way.
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
 * Verifying runs it too, on any commit carrying a `gpgsig` header, forged or
 * not: `log.showSignature` on the gate's `git log` and the code map's, and
 * `merge.verifySignatures` on any porcelain `git merge`. A `%G?` in
 * `rebase.instructionFormat` verifies every commit the gate's rebase replays,
 * so it is pinned to `%s`, a literal format git never resolves through a
 * `pretty.*` alias. `pull.twohead` is the default strategy when argv names
 * none, so it is pinned to `ort` (decision 79). `branch.<name>.mergeOptions`
 * takes any merge option and no `-c` here can name the branch, so the gate
 * fast-forwards with plumbing that never reads it (decision 80).
 * `submodule.recurse` would have the rebase and that checkout recurse into a
 * `.git/modules/<name>` repo whose own config and attributes no driver check
 * reads, so it is pinned off (decision 80). `worktree.useRelativePaths` is
 * pinned off so pup's `worktree add` writes the absolute gitfile the pointer
 * checks match exactly, whatever the operator's global config says (Git 2.48+;
 * an older git ignores the key; decision 101).
 * `core.useReplaceRefs` is off because a session can write `refs/replace/`
 * in the shared ref store: a replacement for the target's tip would hand
 * every diff, and the scope audit reading it, a tree the session chose in
 * place of the one the sha names (decision 99).
 * `core.commitGraph` is off for the same reason: git takes a commit's parents
 * and root tree from `objects/info/commit-graph` when the file is there, and a
 * session can write one that names another tree for the target's tip — a
 * branch diff then reads as empty (decision 89). Grafts and replace refs have
 * an environment pin too, in `GIT_HISTORY_ENV`.
 * `core.bigFileThreshold` is pinned to git's default, far above
 * `GIT_MAX_BUFFER`: a session-written low value makes git call every file
 * binary, so `--numstat` reads `-\t-` for a text file, which then lands in the
 * gate's `forged` list when it should count plainly (decision 113).
 * The `lfs` filter is emptied and made optional, so no pup git call runs
 * git-lfs: with the operator's global `git lfs install`, a tracked
 * `.gitattributes` naming `filter=lfs` makes it the smudge driver of every
 * checkout, and its download runs programs named by general shared-config
 * keys (`core.sshCommand` for an ssh endpoint) that no key refusal can list.
 * Pup checks out LFS pointers, never their content (decision 82).
 * `diff.external` and `textconv` are disarmed per diff call instead — see
 * `DIFF_SAFE_FLAGS` below — because an empty `diff.external` makes every diff die.
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
  '-c',
  'log.showSignature=false',
  '-c',
  'merge.verifySignatures=false',
  '-c',
  'rebase.instructionFormat=%s',
  '-c',
  'pull.twohead=ort',
  '-c',
  'submodule.recurse=false',
  '-c',
  'core.useReplaceRefs=false',
  '-c',
  'core.commitGraph=false',
  '-c',
  'worktree.useRelativePaths=false',
  '-c',
  'core.bigFileThreshold=512m',
  '-c',
  'filter.lfs.required=false',
  '-c',
  'filter.lfs.process=',
  '-c',
  'filter.lfs.smudge=',
  '-c',
  'filter.lfs.clean=',
] as const;

/**
 * The history pins no config key covers, laid over every pup git child's
 * environment (decision 89). `info/grafts` in the shared `$GIT_COMMON_DIR`
 * rewrites a commit's parents for every reader, and neither
 * `core.useReplaceRefs` nor `GIT_NO_REPLACE_OBJECTS` turns it off (verified
 * on Git 2.54): only `GIT_GRAFT_FILE` does, so it names a path that cannot
 * exist, which git reads as no grafts and without a warning. `/dev/null`
 * itself would open, and print git's deprecation hint on every call.
 * `GIT_NO_REPLACE_OBJECTS` repeats `core.useReplaceRefs=false` for a child
 * that takes no argv of pup's, `gh`'s git, as `pinnedGitEnv` hands it on.
 */
const GIT_HISTORY_ENV = {
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_GRAFT_FILE: '/dev/null/no-grafts',
} as const;

/**
 * `runGit`'s whole pin as environment alone, for a program that runs git with
 * argv of its own: `scrubbedGitEnv`, `GIT_HISTORY_ENV`, and `GIT_SAFE_CONFIG`
 * as command-scope config, which outranks the repo's config the way a `-c`
 * does. `gh` runs git in the main checkout, whose config a session can write,
 * so a `core.fsmonitor` armed there would otherwise run on gh's first `git
 * status` (decision 89).
 */
export function pinnedGitEnv(): NodeJS.ProcessEnv {
  const entries = GIT_SAFE_CONFIG.filter((arg) => arg !== '-c');
  const env: NodeJS.ProcessEnv = {
    ...scrubbedGitEnv(),
    ...GIT_HISTORY_ENV,
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach((entry, index) => {
    const equals = entry.indexOf('=');
    env[`GIT_CONFIG_KEY_${index}`] = entry.slice(0, equals);
    env[`GIT_CONFIG_VALUE_${index}`] = entry.slice(equals + 1);
  });
  return env;
}

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
 * files the coverage report instruments. `--no-relative` undoes a
 * session-written `diff.relative`, which beside a `core.worktree` that puts
 * the repo under a prefix would list only the paths under it (decision 154).
 */
const DIFF_SAFE_FLAGS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--text',
  '--no-relative',
] as const;

/**
 * Node's default is 1 MiB, which `--text` on a large committed binary would
 * exceed and turn into a throw mid-gate; 64 MiB covers any patch worth
 * parsing and still fails loudly rather than silently truncating.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * What a call site may add to a git spawn. `env` is laid over the scrubbed
 * environment rather than replacing it, so a caller names only what it adds.
 */
interface RunGitOptions {
  env?: NodeJS.ProcessEnv;
  stdio?: ExecFileSyncOptions['stdio'];
  timeout?: number;
}

/**
 * The one way pup runs git: `GIT_SAFE_CONFIG` in argv and `scrubbedGitEnv` in
 * env, which every call site used to remember by hand (decision 73). Output is
 * returned untrimmed — a `-z` listing whose first path starts with a space
 * must reach its parser whole — so a caller reading one value trims it.
 */
export function runGit(cwd: string, args: string[], opts: RunGitOptions = {}): string {
  return execFileSync('git', safeArgv(cwd, args), { ...spawnOptions(opts), encoding: 'utf8' });
}

/**
 * Rethrow `error` when it is a git child an interrupt killed. A catch that
 * reads git's failure as an answer ("not an ancestor", "locked") must not read
 * a Ctrl-C as one: the interrupted command should stop, not carry on from an
 * answer git never gave. A git that crashed on its own (SIGSEGV, SIGABRT) is
 * left to the catch, whose fallback is the safe one for state that would crash
 * it on every re-run.
 */
export function rethrowIfKilled(error: unknown): void {
  const signal =
    typeof error === 'object' && error !== null && 'signal' in error ? error.signal : undefined;
  if (signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP') throw error;
}

function safeArgv(cwd: string, args: string[]): string[] {
  return [...GIT_SAFE_CONFIG, '-C', cwd, ...args];
}

function spawnOptions(opts: RunGitOptions): ExecFileSyncOptions {
  return {
    env: { ...scrubbedGitEnv(), ...opts.env, ...GIT_HISTORY_ENV },
    maxBuffer: GIT_MAX_BUFFER,
    stdio: opts.stdio,
    timeout: opts.timeout,
  };
}

/**
 * How long a git read of the gate's diff-size count may take before it throws
 * (decision 154): a batch of up to `GIT_MAX_BUFFER` or one tree entry, under
 * the merge lock, which a stalled read would hold.
 */
const GIT_READ_TIMEOUT_MS = 30_000;

/**
 * The content of each blob in `blobs`, in order, read through one
 * `git cat-file --batch` however many there are: a process per blob let a
 * tree of 20 000 tiny files hold the merge lock for minutes (decision 154).
 * Sizes are the ones git listed (`ls-tree -l`, `cat-file -s`), and together they may not pass
 * `GIT_MAX_BUFFER`, the cap each read had alone: past it, or past
 * `GIT_READ_TIMEOUT_MS`, this throws and the gate fails closed. A size that
 * is no byte count, which `ls-tree` lists for an object it cannot read, throws,
 * and so does an answer that is not the oid asked for, a blob of the size listed.
 */
export function readBlobs(repoPath: string, blobs: { oid: string; size: number }[]): Buffer[] {
  if (blobs.length === 0) return [];
  let total = 0;
  let maxBuffer = 0;
  for (const { oid, size } of blobs) {
    // `ls-tree -l` lists `BAD` for an object it cannot read.
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`git ls-tree listed no byte count for ${oid}: its object cannot be read`);
    }
    total += size;
    // Each object prints as `<oid> blob <size>\n<content>\n`.
    maxBuffer += size + oid.length + ` blob ${size}\n\n`.length;
  }
  if (total > GIT_MAX_BUFFER) {
    throw new Error(
      `git cat-file --batch would read ${total} bytes, past the ${GIT_MAX_BUFFER}-byte cap`,
    );
  }
  const out = execFileSync('git', safeArgv(repoPath, ['cat-file', '--batch']), {
    ...spawnOptions({ timeout: GIT_READ_TIMEOUT_MS }),
    encoding: 'buffer',
    // A Buffer: a string input is encoded with `encoding`, which `buffer` is not.
    input: Buffer.from(`${blobs.map(({ oid }) => oid).join('\n')}\n`),
    maxBuffer,
  });
  const contents: Buffer[] = [];
  let at = 0;
  for (const { oid, size } of blobs) {
    const eol = out.indexOf('\n', at);
    const header = out.subarray(at, eol === -1 ? out.length : eol).toString('utf8');
    const end = eol + 1 + size;
    if (eol === -1 || header !== `${oid} blob ${size}` || out[end] !== 0x0a) {
      throw new Error(
        `git cat-file --batch answered ${JSON.stringify(header)} for ${oid}, not a blob of ${size} bytes`,
      );
    }
    contents.push(out.subarray(eol + 1, end));
    at = end + 1;
  }
  if (at !== out.length) {
    throw new Error(`git cat-file --batch answered ${out.length - at} bytes past the last blob`);
  }
  return contents;
}

/** The branch checked out at `cwd`, empty on a detached HEAD. */
export function currentBranch(cwd: string): string {
  return runGit(cwd, ['branch', '--show-current']).trim();
}

/**
 * Repo-relative paths changed on the branch (merge-base diff). NUL-delimited
 * (`-z`) so git never C-quotes non-ASCII names — the scope audit must see the
 * exact byte paths, or a quoted `.claude/…` path would slip past the
 * protected-glob backstop.
 */
export function gitDiffPaths(repoPath: string, target: string, branch: string): string[] {
  return runGit(repoPath, [
    'diff',
    ...DIFF_SAFE_FLAGS,
    '-z',
    '--name-only',
    `${target}...${branch}`,
  ])
    .split('\0')
    .filter(Boolean);
}

/**
 * Git config that keeps a path argument the bytes it was given. On macOS
 * `core.precomposeUnicode`, which `git init` turns on and a session can set in
 * the shared config, rewrites an NFD path to NFC in a pathspec and in a
 * `<rev>:<path>` object name alike, so a tree holding both spellings would
 * answer for the other file (decision 114).
 */
const PATH_AS_GIVEN = ['-c', 'core.precomposeUnicode=false'];

/**
 * The `-U0` hunk headers of one file's diff: where each hunk's added lines
 * start, and how many lines it adds and deletes. `diffArgs` name the file: the
 * branch diff (merge-base diff) and a pathspec, or two blob oids. One diff per
 * file so hunk headers are the only thing parsed — file names never need
 * de-quoting. A pathspec must be literal, or a file named
 * `:(top)foo` would be read as magic and return no hunks, and taken from the
 * top of the tree, or a session-written `core.worktree` naming a directory
 * above the repo would put it under a prefix that matches nothing
 * (decision 154). The inter-hunk
 * context is pinned to 0 and the algorithm to myers, or a session-written
 * `diff.interHunkContext` would merge the hunks and a `diff.algorithm` of
 * patience or histogram could read an unchanged block as deleted and
 * re-added, both reporting unchanged lines as added (decision 113).
 * `core.precomposeUnicode` is pinned off, or on macOS git would rewrite an NFD
 * path to NFC before matching it and read the hunks of an NFC sibling the tree
 * also holds (decision 114).
 */
function diffHunks(
  repoPath: string,
  diffArgs: string[],
): { start: number; added: number; deleted: number }[] {
  const patch = runGit(repoPath, [
    ...PATH_AS_GIVEN,
    'diff',
    ...DIFF_SAFE_FLAGS,
    '-U0',
    '--inter-hunk-context=0',
    '--diff-algorithm=myers',
    ...diffArgs,
  ]).trim();
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
    for (const hunk of diffHunks(repoPath, [
      `${target}...${branch}`,
      '--',
      `:(top,literal)${path}`,
    ])) {
      for (let at = hunk.start; at < hunk.start + hunk.added; at++) lines.push(at);
    }
    if (lines.length > 0) added[path] = lines;
  }
  return added;
}

/** One side of a file's diff as `--raw` lists it: its tree mode and blob oid. */
type DiffSide = { mode: string; oid: string };

/**
 * A numstat entry. A renamed file carries the path it was `renamedFrom`, and a
 * file numstat could not count (`-\t-`) its `sides`, `[base, branch]`, each
 * undefined where the file does not exist, for `gitDiffBinaryRecount`.
 */
export type DiffNumstatEntry = DiffFileStat & {
  renamedFrom?: string;
  sides?: [DiffSide | undefined, DiffSide | undefined];
};

/** A `--raw` side's mode and oid, undefined for the all-zero mode of a side that does not exist. */
function rawSide(mode: string, oid: string): DiffSide | undefined {
  return /^0+$/.test(mode) ? undefined : { mode, oid };
}

/**
 * Per-file add/delete counts for the branch diff (merge-base diff),
 * rename-aware: a renamed file is listed under its new path, with the path it
 * was renamed from. The `--raw` records of the same run give each `-\t-`
 * entry its sides, which `gitDiffBinaryRecount` reads by oid: a path decoded
 * from git's output is no key to read a blob by, since a name that is not
 * UTF-8 decodes to U+FFFD and names another file or none (decision 154).
 */
export function gitDiffNumstat(
  repoPath: string,
  target: string,
  branch: string,
): DiffNumstatEntry[] {
  // With -z, every `--raw` record comes first, in the order of the numstat
  // records after it: ":<old mode> <new mode> <old oid> <new oid> <status>",
  // then one path, or the old and the new path for a rename. A numstat
  // renamed entry is "added\tdeleted\t" followed by the old and new paths as
  // two separate NUL fields. An inline path is never quoted, so a tab in it
  // is the path's own and everything after the second tab is the path.
  // Renames are pinned to plain detection: a session-written
  // `diff.renames=copies` would score a new file copied from a changed one as
  // that copy's edits alone, under the oversize flag (decision 113), and
  // `--no-abbrev` gives whole oids whatever `core.abbrev` says.
  const fields = runGit(repoPath, [
    '-c',
    'diff.renames=true',
    'diff',
    ...DIFF_SAFE_FLAGS,
    '-z',
    '--raw',
    '--no-abbrev',
    '--numstat',
    `${target}...${branch}`,
  ]).split('\0');
  const raw: [DiffSide | undefined, DiffSide | undefined][] = [];
  let i = 0;
  for (; fields[i]?.startsWith(':'); i++) {
    const [oldMode = '', newMode = '', oldOid = '', newOid = '', status = ''] = (fields[i] ?? '')
      .slice(1)
      .split(' ');
    raw.push([rawSide(oldMode, oldOid), rawSide(newMode, newOid)]);
    i += /^[RC]/.test(status) ? 2 : 1;
  }
  const stats: DiffNumstatEntry[] = [];
  for (; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const [added, deleted, ...rest] = field.split('\t');
    const inlinePath = rest.join('\t');
    const renamedFrom = inlinePath ? undefined : fields[i + 1];
    const path = inlinePath || fields[i + 2];
    if (!inlinePath) i += 2;
    if (!path) continue;
    const sides = raw[stats.length];
    stats.push({
      path,
      added: added === '-' ? null : Number(added),
      deleted: deleted === '-' ? null : Number(deleted),
      ...(renamedFrom ? { renamedFrom } : {}),
      ...(added === '-' && sides ? { sides } : {}),
    });
  }
  if (stats.length !== raw.length) {
    throw new Error(
      `git diff listed ${raw.length} raw records for ${stats.length} numstat records`,
    );
  }
  return stats;
}

/** The known-binary caps, which the merge gate's diff-size detail names. */
export { BINARY_FREE_MAX_BYTES, BINARY_FREE_TOTAL_MAX_BYTES } from './known-binary.utils.js';

/**
 * The size of a diff side when it is a binary to skip, false when it is not:
 * a regular file (mode 100644 or 100755, never a 120000 symlink) no larger
 * than `BINARY_FREE_MAX_BYTES`, binary by content, never by attribute,
 * opening with the magic of a format its extension names, and holding no zip
 * record, phar stub or tar header (`mayBeKnownBinary`, then
 * `knownBinarySize`). A side `--raw` lists as absent answers undefined. The
 * blob is read by the oid `--raw` gave, its size from `cat-file -s`, through
 * `readBlobs`, so its size is checked against that answer; a git that fails,
 * times out or is killed throws, and the gate fails closed.
 */
function blobIsKnownBinary(
  repoPath: string,
  side: DiffSide | undefined,
  formats: BinaryFormat[],
): number | false | undefined {
  if (side === undefined) return undefined;
  const size = blobSize(repoPath, side.oid);
  if (!mayBeKnownBinary(side.mode, size)) return false;
  const [blob = Buffer.alloc(0)] = readBlobs(repoPath, [{ oid: side.oid, size }]);
  return knownBinarySize(blob, formats);
}

/** The byte size of blob `oid`, from `cat-file -s`; a git that fails or times out throws. */
function blobSize(repoPath: string, oid: string): number {
  return Number(runGit(repoPath, ['cat-file', '-s', oid], { timeout: GIT_READ_TIMEOUT_MS }).trim());
}

/** The lines a whole-file add or delete of `blob` counts, a last line without a newline included. */
function lineCount(blob: Buffer): number {
  let lines = 0;
  for (let at = blob.indexOf(0x0a); at !== -1; at = blob.indexOf(0x0a, at + 1)) lines++;
  return blob.length > 0 && blob[blob.length - 1] !== 0x0a ? lines + 1 : lines;
}

/**
 * The add/delete counts `--numstat` withheld from a file it reported as
 * `-\t-`, or null when the file really is binary. `--text` does not restore a
 * numstat the way it restores a patch, and what git calls binary is not only
 * content: a `-diff` or `binary` attribute from `info/attributes` or a
 * `core.attributesFile`, both written where no diff shows them, make every
 * text file `-\t-` — and a skipped null would then let a 5 000-line diff
 * count as zero (decision 53).
 *
 * Content is the question, asked of both sides of the merge-base diff, because
 * the patch cannot answer it: `--text` parses hunks out of a real binary too,
 * so "binary but has hunks" would call every committed image forged. A NUL is
 * not the whole answer either: one in a source file's comment makes git call
 * it binary. So the file is skipped only when every side it exists on is a
 * known binary (`blobIsKnownBinary`, `src/core/known-binary.utils.ts`), and a
 * path no format names is recounted unread (decision 154). The sides are the
 * ones `gitDiffNumstat` paired with the entry from the same run's `--raw`
 * records, read by oid, never looked up again by path: a path that is not
 * UTF-8 decodes to U+FFFD, and an `ls-tree` of that string found nothing,
 * which read as absent and skipped, or found a decoy committed under it. The
 * recount reads the same oids: the hunks of `git diff <base> <branch>`, or
 * the lines of the one blob a file added or deleted holds, so a decoded path
 * never picks whose lines are counted. An entry without sides throws. A
 * renamed file's merge-base side is the blob it was `renamedFrom`, named by
 * that path's extension: a source file renamed into a `.png` would otherwise
 * have no base side, skip, and drop every line it deleted. A skip spends the
 * branch side's bytes from `budget` (`spendKnownBinarySkip`), which every call
 * for one diff must share (start it at `BINARY_FREE_TOTAL_MAX_BYTES`), and a
 * file the budget cannot cover is recounted. It has no default: a fresh budget
 * per call would cap nothing.
 */
export function gitDiffBinaryRecount(
  repoPath: string,
  entry: Pick<DiffNumstatEntry, 'path' | 'renamedFrom' | 'sides'>,
  budget: { bytes: number },
): { added: number; deleted: number } | null {
  const { path, renamedFrom } = entry;
  if (entry.sides === undefined) {
    throw new Error(`git diff listed no --raw sides to recount ${path} from`);
  }
  const [baseBlob, branchBlob] = entry.sides;
  const sideOf = (side: DiffSide | undefined, sidePath: string): number | false | undefined => {
    const formats = formatsNamed(sidePath);
    return formats.length === 0 ? false : blobIsKnownBinary(repoPath, side, formats);
  };
  const branchSide = sideOf(branchBlob, path);
  const sides =
    branchSide === false ? [branchSide] : [sideOf(baseBlob, renamedFrom ?? path), branchSide];
  if (spendKnownBinarySkip(sides, budget)) return null;
  if (baseBlob === undefined || branchBlob === undefined) {
    const { oid } = branchBlob ?? baseBlob ?? { oid: '' };
    const [blob = Buffer.alloc(0)] = readBlobs(repoPath, [{ oid, size: blobSize(repoPath, oid) }]);
    const lines = lineCount(blob);
    return branchBlob === undefined ? { added: 0, deleted: lines } : { added: lines, deleted: 0 };
  }
  let added = 0;
  let deleted = 0;
  for (const hunk of diffHunks(repoPath, [baseBlob.oid, branchBlob.oid])) {
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
 *
 * And the `lfs` keys git-lfs reads from the same shared config to pick a
 * program it runs: an operator's global `git lfs install` arms the lfs smudge
 * filter for every checkout, rebase and read-tree, and that filter runs
 * whatever `lfs.customtransfer.<name>.path` names, with `.args`, once
 * `lfs.standalonetransferagent` or the remote selects it, and the
 * `lfs.extension.<name>.clean` and `.smudge` commands on every lfs object;
 * an extension's `.priority` names no program (decision 82). Matched looser
 * than git lists them, because git-lfs is: git keeps a subsection's case and
 * git-lfs ignores it, the agent can be named per endpoint url, and the
 * `customtransfer` pattern differs by version (unescaped dots in 3.x,
 * unanchored on main), so the last alternative is the union of both, its
 * dots deliberately unescaped. `s` because git allows `\r` and the Unicode
 * line separators inside a subsection, which `.` skips without it. Every
 * subsection may be empty: `[filter ""]` is the key `filter..smudge`, a driver
 * an attribute with an empty name selects (decision 89).
 *
 * And an `include.path` or `includeIf.<condition>.path`, refused whatever the
 * file it names holds now: git reads that file on every call, so a session
 * can fill it after the check, aim it at a fifo, or arm it under a condition
 * (`onbranch:`, `gitdir:`) that is false where the check runs and true where
 * the rebase does. The listing reads no include (decision 89).
 */
const ARMED_DRIVER_KEY =
  /^(?:filter\..*\.(?:clean|smudge|process)|merge\..*\.driver|lfs\.(?:.*\.)?standalonetransferagent|lfs\.extension\..*\.(?:clean|smudge)|include(?:if\..*)?\.path)$|lfs.customtransfer.[^.]*.(?:path|args)/is;

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
      `Refusing to run git in ${gitPath}: a filter or merge driver is armed, or a config ` +
        `include could arm one, and git would run it with your environment —${shown}${rest > 0 ? ` +${rest} more` : ''}. ` +
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
 * quieter than the one git itself will consult. A session worktree is read
 * under `env`, its `verifiedWorktreeGitEnv`, which is how the call it guards
 * runs: unpinned, the read would follow pointers the session can swap between
 * the check and the call (decision 101).
 */
export function armedGitDrivers(gitPath: string, env?: WorktreeGitEnv): string[] {
  const armed: string[] = [];
  const opts = { env: env ? { ...env } : undefined };
  const commonDir = runGit(
    gitPath,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    opts,
  ).trim();
  const patterns = attributePatterns(join(commonDir, 'info', 'attributes'));
  if (patterns === undefined) {
    armed.push('info/attributes (not a regular file of 1 MiB or less)');
  } else if (patterns[0]) {
    armed.push(`info/attributes (${sanitizeReason(patterns[0])})`);
  }
  // `--list --show-scope` rather than `--local --get-regexp`: `--worktree`
  // silently falls back to the local file when `extensions.worktreeConfig` is
  // off, so it cannot be read on its own, and one listing covers both scopes.
  // Entries are `<scope>\0<key>\n<value>\0`, so they come out in pairs.
  // `--no-includes`, so a fifo an include names cannot block the listing: the
  // include key itself is what gets refused (decision 89).
  const listed = runGit(gitPath, ['config', '--list', '--show-scope', '--no-includes', '-z'], opts)
    .trim()
    .split('\0');
  for (let i = 0; i + 1 < listed.length; i += 2) {
    if (!SESSION_WRITABLE_SCOPES.includes(listed[i] as string)) continue;
    const entry = listed[i + 1] as string;
    const [key] = entry.split('\n');
    // Judged as git-lfs reads them too: it parses plain `git config -l`,
    // splitting on newlines and each line on its first `=`, so a line hidden
    // in a value, or an `=` in a subsection, is a key to it (decision 82).
    const asLfsReads = entry
      .replace('\n', '=')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => line.split('=')[0]);
    for (const read of new Set([key, ...asLfsReads])) {
      if (read && ARMED_DRIVER_KEY.test(read)) armed.push(sanitizeReason(read));
    }
  }
  return armed;
}

/** Far above any attributes file a person writes; a bigger one is refused, not read. */
const ATTRIBUTES_MAX_BYTES = 1024 * 1024;

/**
 * Pattern lines of an attributes file — blank lines and comments are inert —
 * or undefined when it is there but not a regular file, which counts as
 * armed. The open-PR merge re-runs this check after its branch compare-and-swap,
 * under the merge lock: a fifo read with a plain open would block node where
 * SIGINT and SIGTERM cannot reach it, and SIGKILL would strand the lock
 * (decision 50, amended by 89).
 */
function attributePatterns(file: string): string[] | undefined {
  const read = readRegularFile(file, ATTRIBUTES_MAX_BYTES);
  if (read === 'missing') return [];
  if (read === 'irregular') return undefined;
  return read.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Refuse to run git at `gitPath` while a filter or merge driver is armed.
 * Decision 6's loud-backstop shape: there is no disarm to fall back on, so the
 * only honest answer is to stop and name what is armed (decision 50).
 */
export function assertNoArmedGitDrivers(gitPath: string, env?: WorktreeGitEnv): void {
  const armed = armedGitDrivers(gitPath, env);
  if (armed.length > 0) throw new ArmedGitDriverError(gitPath, armed);
}
