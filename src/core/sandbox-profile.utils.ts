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
    '',
  ].join('\n');
}

/** SBPL string literals: only the quote and the escape itself need handling. */
function escapeSbpl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * `checkouts` are the paths whose git directory must survive the grant. Derived
 * here rather than passed per call site on purpose: a call site that forgets to
 * protect the checkout it just made writable reopens the whole hole, and every
 * writable path pup grants is either a checkout or a directory with no `.git`
 * in it, where the extra deny costs nothing.
 */
export function writeProfile(policyDir: string, writablePaths: string[]): string {
  const profilePath = join(policyDir, 'gate-child.sb');
  const writable = [...new Set(writablePaths.map(resolvePath))];
  writeFileSync(
    profilePath,
    sandboxProfile({
      writablePaths: writable,
      protectedPaths: writable.map((path) => join(path, GIT_DIRNAME)),
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
