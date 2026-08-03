import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The SBPL policy pup generates for gate children — what may be read, what may
 * be written, and nothing about how the child is spawned. The execution half
 * (mode probe, `sandbox-exec` invocation, caches) lives in sandbox.utils.ts and
 * is this module's only caller besides its tests.
 */

/** Writes here are what a tty, `/dev/null` and friends need; nothing else is. */
const DEVICE_PATH = '/dev';

/**
 * Never writable, whatever a caller granted. A checkout's git directory carries
 * *execution*: `core.fsmonitor`, `core.sshCommand`, `core.pager` and aliases in
 * `.git/config` are run by pup's own later git calls, which are deliberately
 * NOT sandboxed and carry the operator's full environment (decision 28) —
 * verified against Apple Git-154, where `core.hooksPath=/dev/null` does not
 * close it. Denying the directory whole also covers `config.worktree`, the
 * `.git` *file* a worktree uses to point at its real git dir, `hooks/`,
 * `info/`, and refs. Measurement must not mutate the repository it measures,
 * the same rule the Python adapter's `uv --no-sync` already follows.
 */
const GIT_DIRNAME = '.git';

/**
 * The same deny, at every depth, scoped to one checkout grant. The per-path
 * denies in `protectedPaths` are derived one level deep — granting P protects
 * P/.git and nothing under it — which is how #49's sibling-worktree attack
 * reached every worktree's `.git` pointer file through a grant of the repo
 * root. Matching the path instead of enumerating it makes depth irrelevant:
 * any segment named `.git`, directory or worktree pointer file, anywhere
 * under the checkout. `.gitignore` and friends stay writable — the match
 * requires `/` or end-of-path after `.git`.
 *
 * Scoped by `require-all` rather than applied globally because pup's own
 * scratch and cache grants must stay exempt: a brand-new repo a child creates
 * in its own TMPDIR is not the repository being measured, which is what
 * decision 36 protects. An unscoped deny broke `git init` there — this repo's
 * own test suite does exactly that, and `pip install git+...`, npm/pnpm and
 * uv git dependencies all clone into TMPDIR or the cache — so the gate's own
 * test stage would have refused every future merge.
 *
 * Measured on APFS, the match is case-INSENSITIVE — a directory whose real
 * on-disk name is `.GIT` is also denied — so the rule is slightly broader
 * than "any segment named .git", which is safe. On a case-sensitive volume it
 * is exactly as written, also safe: git would not read `.GIT` there either.
 */
function gitDenyRule(checkoutPath: string): string {
  return String.raw`(deny file-write* (require-all (subpath "${escapeSbpl(checkoutPath)}") (regex #"/\.git(/|$)")))`;
}

/**
 * Read-denied outright, and deliberately a fixed constant with no extension
 * mechanism: a per-repo or per-operator list is a channel a session can write
 * (the lesson decision 31 paid for with `python_files`), and the value of a
 * deny list nobody can widen is that reading it tells you what is protected.
 *
 * Home-relative, `subpath`-matched, so a directory covers everything under it.
 *
 * **The ceiling: a secret not on this list is not protected.** Read stays
 * default-*allow* because it has to — the node binary a gate child runs lives
 * under `HOME` on any nvm/asdf/homebrew-in-home install, so a default-deny
 * read policy cannot execute the toolchain at all. So this list closes the
 * credential stores an attacker would go to first, not the general case, and a
 * secret in `~/Documents/keys.txt` is readable. Two narrower gaps for the same
 * reason: the sandbox matches resolved paths, so a `~/.npmrc` symlinked out to
 * a dotfiles repo is read through its target, and a tool that already loaded a
 * secret into pup's environment is decision 28's problem, not this list's.
 */
const DENIED_READ_HOME_PATHS = [
  '.ssh',
  '.aws',
  '.config/gh',
  '.netrc',
  '.npmrc',
  '.gnupg',
  '.kube',
  '.docker/config.json',
  'Library/Keychains',
  '.pupitre',
];

/** Pup's own store: the baselines a gate ratchets and the ledger it writes. */
const PUPITRE_HOME = '.pupitre';

/**
 * The profile pup generates, in SBPL. Later rules win, which is what makes the
 * policy expressible at all.
 *
 * Writes are default-DENY, allowed back only for the paths a gate actually
 * needs. Denying `HOME` alone was not enough and the difference is not
 * theoretical: `/opt/homebrew/bin` is group-writable on a standard install, so
 * a gate child could overwrite the `gh`, `git` or `tmux` binary that pup itself
 * runs afterwards — unsandboxed, with the operator's full environment. The
 * writable set is enumerated at every call site anyway, so inverting the
 * default costs nothing and closes every path nobody thought to name.
 *
 * The trailing denies are last on purpose: pup's own store, the profile file
 * itself, and each granted checkout's git directory stay unwritable even when
 * they sit inside a path the caller granted.
 */
export function sandboxProfile(policy: {
  /** Absolute, symlink-resolved paths the child may write under. */
  writablePaths: string[];
  /** Carved back out of the writable set, whatever it granted. */
  protectedPaths: string[];
  /** Checkout grants; `.git` is denied at any depth under each, and only these. */
  checkoutPaths: string[];
  /** The operator's home. Only the read denies key off it now. */
  home: string;
  /** Directory holding the generated profile; a writable one is a widened next run. */
  policyDir: string;
}): string {
  const subpaths = (paths: string[]): string =>
    paths.map((path) => `\n  (subpath "${escapeSbpl(path)}")`).join('');
  return [
    '(version 1)',
    // Network is open, and so is read of everything the deny list below misses:
    // the stated ceiling of decision 36, not an oversight.
    '(allow default)',
    '(deny file-write*)',
    `(deny file-read*${subpaths(DENIED_READ_HOME_PATHS.map((path) => join(policy.home, path)))})`,
    `(allow file-write*${subpaths([...policy.writablePaths, DEVICE_PATH])})`,
    `(deny file-write*${subpaths([
      join(policy.home, PUPITRE_HOME),
      policy.policyDir,
      ...policy.protectedPaths,
    ])})`,
    ...policy.checkoutPaths.map(gitDenyRule),
    '',
  ].join('\n');
}

/** SBPL string literals: only the quote and the escape itself need handling. */
function escapeSbpl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Every path in `writablePaths` is treated as a checkout: it gets the derived
 * one-level P/.git deny in `protectedPaths`, which documents the grant, and
 * the scoped any-depth rule, which does the real work. Derived here rather
 * than passed per call site on purpose: a call site that forgets to protect
 * the checkout it just made writable reopens the whole hole, so a
 * caller-supplied path can only default INTO the protected set. The lone
 * exemption is `scratchPaths` — the directories the sandbox seam itself
 * creates for the child (its TMPDIR, the toolchain cache), never taken from a
 * caller's grant. A repo a child makes in its own scratch is not the
 * repository being measured, and writing one is a legitimate toolchain move:
 * git dependencies clone into TMPDIR or the cache.
 */
export function writeProfile(
  policyDir: string,
  writablePaths: string[],
  scratchPaths: string[] = [],
): string {
  const profilePath = join(policyDir, 'gate-child.sb');
  const checkouts = [...new Set(writablePaths.map(resolvePath))];
  const scratch = [...new Set(scratchPaths.map(resolvePath))].filter(
    (path) => !checkouts.includes(path),
  );
  writeFileSync(
    profilePath,
    sandboxProfile({
      writablePaths: [...checkouts, ...scratch],
      protectedPaths: checkouts.map((path) => join(path, GIT_DIRNAME)),
      checkoutPaths: checkouts,
      home: resolvePath(homedir()),
      policyDir,
    }),
  );
  return profilePath;
}

/**
 * The sandbox matches the kernel's resolved paths, so a rule naming a symlink
 * matches nothing. A path that does not exist yet cannot be resolved and is
 * used as given — that direction denies writes rather than granting them.
 */
export function resolvePath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}
