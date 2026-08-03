import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_VAR_SUBDIRS, gateChildEnv } from './gate-env.utils.js';
import { projectId } from './paths.utils.js';

/**
 * Containment for the children whose code a session wrote — gate stages,
 * adapter debt capabilities, the custom adapter's `sh -c`, and `pup
 * init`/`pup audit`'s baseline stages. Decision 28 removed the operator's
 * secrets from the child's *environment* and said in as many words that this
 * was not containment: `HOME` stays, so the child could still read
 * `~/.aws/credentials` and write `~/.zshenv`. This is the sandbox that entry
 * deferred (decision 36).
 *
 * One seam, so there is one answer to "what can a gate child touch": every
 * call site that used to build a `gateChildEnv()` runs through `runGateChild`.
 * On darwin that means `sandbox-exec` with a pup-generated profile; on every
 * other platform the child runs unsandboxed and the gate report says so.
 */

/** macOS ships this. Its absence on darwin fails the run, it is not a fallback. */
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * What the mode probe runs, by absolute path to a SIP-protected binary that
 * writes nothing. Both halves are load-bearing. A PATH-resolved `true` is
 * chosen by whoever controls `PATH`, and its stderr shares the buffer the
 * nesting check reads — so a planted `true` printing the refusal line forged
 * `inherited` and dropped every child out of its sandbox while the report still
 * claimed containment.
 */
const PROBE_COMMAND = '/usr/bin/true';

/**
 * `sandbox-exec`'s own refusal, anchored to the start of a line and to its
 * prefix. Defence in depth behind the probe command: the only thing that should
 * be able to write this is `sandbox-exec` itself.
 */
const NESTING_REFUSAL = /^sandbox-exec: sandbox_apply:/m;

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

interface GateChildOptions {
  /** Working directory, and always writable: the checkout being measured. */
  cwd: string;
  /**
   * The trusted checkout (decision 29's `configPath`). Writable, because a
   * worktree shares its git object store, and the key the toolchain cache is
   * scoped by — one repo's gate must not hand the next repo its package
   * manager. Required rather than optional: every call site knows it, and a
   * cache shared by default is a cross-repo execution channel.
   */
  repoPath: string;
  /** Further writable paths — a capability's report directory. */
  writablePaths?: string[];
  /**
   * Extra env names the operator allowed with `--gate-env`. Never read from
   * pup's own environment: an ambient channel (direnv, a CI job, a wrapper
   * script) is the door that flag exists to close (decision 28, refined).
   */
  gateEnv?: string[];
  timeout?: number;
  maxBuffer?: number;
  /** Fed to the child's stdin; absent means stdin is closed. */
  input?: string;
}

/**
 * `applied` — pup wrapped the child in its own profile. `inherited` — pup is
 * itself sandboxed, so the child runs under *that* profile (see `sandboxMode`).
 * `unsupported` — no mechanism on this platform, and the reports say so.
 */
type SandboxMode = 'applied' | 'inherited' | 'unsupported';

/** True where pup can confine a child at all. Everywhere else it says so. */
export function isSandboxSupported(): boolean {
  return process.platform === 'darwin';
}

const MODE_LABELS: Record<SandboxMode, string> = {
  applied: 'sandbox-exec (macOS)',
  inherited: 'inherited (pup is itself sandboxed)',
  unsupported: 'none (unsupported platform)',
};

/**
 * One line for the gate report, `pup init` and `pup audit`. Measured rather
 * than assumed — it names what pup actually did, because a run that could not
 * confine anything must not read like one that did (decision 29's honesty
 * rule).
 */
export function sandboxLabel(): string {
  return MODE_LABELS[sandboxMode()];
}

let mode: SandboxMode | undefined;

/**
 * Probed once per process, because the answer is a property of the process:
 * macOS refuses a nested `sandbox_apply` unless the inner profile is identical
 * to the outer one, so pup running *inside* a sandbox cannot layer its own
 * policy on top. That is not a hole — a child cannot escape the sandbox its
 * parent runs under, so it stays confined by whatever confines pup — but it is
 * a different guarantee, and it gets a different word in the report.
 *
 * Pupitre's own gate is exactly this case: `pnpm test` runs as a sandboxed
 * stage, and the suite spawns gate children of its own.
 */
function sandboxMode(): SandboxMode {
  if (mode) return mode;
  if (!isSandboxSupported()) {
    mode = 'unsupported';
    return mode;
  }
  if (!existsSync(SANDBOX_EXEC)) {
    // Fail closed, and say which half broke: the alternative — running the
    // session's own build command with the operator's home wide open because a
    // system binary went missing — is the outcome this seam exists to prevent.
    throw new Error(`${SANDBOX_EXEC} is missing; refusing to run gate children unsandboxed.`);
  }
  const { scratchDir, policyDir } = sandboxRun();
  try {
    // Nothing the child controls reaches this: an absolute SIP-protected
    // binary that writes no output, run with an empty environment, so the only
    // writer of the stderr the check below reads is `sandbox-exec` itself.
    execFileSync(SANDBOX_EXEC, ['-f', writeProfile(policyDir, [scratchDir]), PROBE_COMMAND], {
      encoding: 'utf8',
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mode = 'applied';
  } catch (error) {
    const failure = error as { stderr?: string };
    // Only the nesting refusal degrades to `inherited`. Anything else means the
    // sandbox is broken in a way pup does not understand, so it refuses.
    if (!NESTING_REFUSAL.test(failure.stderr ?? '')) throw error;
    mode = 'inherited';
  }
  return mode;
}

/**
 * Run one gate child. On darwin it is wrapped in `sandbox-exec`; a sandbox that
 * cannot be set up throws rather than degrading to an unconfined run, so the
 * stage fails and the merge refuses. The invariant is about gate *children*, and
 * only them: no child pup spawns to measure a session's code runs unconfined on
 * a platform pup claims to confine. The session process itself is not covered —
 * it runs with permissions bypassed by design (decision 5). The one degradation
 * is `inherited`, which does not break the invariant: the child is still inside
 * the sandbox pup is inside.
 *
 * Returns the child's stdout. A non-zero exit throws execFileSync's error, with
 * `stdout`/`stderr` attached, exactly as the direct calls this replaced did.
 */
export function runGateChild(command: string, args: string[], options: GateChildOptions): string {
  const applied = sandboxMode() === 'applied';
  const { scratchDir, policyDir } = sandboxRun();
  const cacheDir = toolchainCacheDir(options.repoPath);
  const env = gateChildEnv({ passthrough: options.gateEnv, scratchDir, cacheDir });
  const invocation = applied
    ? {
        command: SANDBOX_EXEC,
        args: [
          '-f',
          writeProfile(policyDir, [
            options.cwd,
            options.repoPath,
            ...(options.writablePaths ?? []),
            scratchDir,
            cacheDir,
          ]),
          command,
          ...args,
        ],
      }
    : { command, args };
  return execFileSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
}

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
function writeProfile(policyDir: string, writablePaths: string[]): string {
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
function resolvePath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

/** Cache reused across runs; a run's scratch and profile go with the process. */
const TOOLCHAIN_CACHE_DIRNAME = 'pup-toolchain-cache';

interface SandboxRun {
  /** The child's TMPDIR, and everything a run leaves behind. Per run. */
  scratchDir: string;
  /** Holds the generated profile. Write-denied to every child. */
  policyDir: string;
}

let run: SandboxRun | undefined;

/**
 * Created on the first child. One pup process is one gate run, so process scope
 * is run scope for the scratch and the profile — both go when it exits.
 */
function sandboxRun(): SandboxRun {
  if (run) return run;
  const base = resolvePath(tmpdir());
  const created: SandboxRun = {
    scratchDir: mkdtempSync(join(base, 'pup-gate-')),
    policyDir: mkdtempSync(join(base, 'pup-sandbox-')),
  };
  process.on('exit', () => {
    rmSync(created.scratchDir, { recursive: true, force: true });
    rmSync(created.policyDir, { recursive: true, force: true });
  });
  run = created;
  return created;
}

const cacheDirs = new Map<string, string>();

/**
 * Where the redirected toolchain caches live. Two properties, each paid for.
 *
 * It **outlives the run**: `HOME` is not writable, so caches that used to land
 * in `~/.npm` or `~/Library/Caches` come here, and a directory that starts
 * empty every time is worse than no redirect at all — corepack re-downloads the
 * repo's package manager on every `pup merge`, turning a local gate into a
 * network-dependent one.
 *
 * It is **scoped per repo**: these caches carry executable code (corepack runs
 * the package-manager tarballs in its home, uv hardlinks cached wheels into the
 * venv), so one shared directory means a gate child in repo A supplies the
 * `pnpm` that measures repo B. Keying by `projectId` keeps each repo's cache
 * warm and cuts the cross-repo channel; what remains is same-repo, where the
 * child already runs that repo's own code (a ceiling decision 36 states).
 */
function toolchainCacheDir(repoPath: string): string {
  const key = projectId(resolvePath(repoPath));
  const cached = cacheDirs.get(key);
  if (cached) return cached;
  const root = join(resolvePath(tmpdir()), TOOLCHAIN_CACHE_DIRNAME);
  const dir = join(root, key);
  ensurePrivateDir(root);
  ensurePrivateDir(dir);
  // Created up front: a tool handed a cache dir that does not exist mostly
  // creates it, and the ones that don't fail for a reason nobody would guess.
  for (const subdir of Object.values(CACHE_VAR_SUBDIRS)) {
    ensurePrivateDir(join(dir, subdir));
  }
  cacheDirs.set(key, dir);
  return dir;
}

/**
 * The scratch and profile directories get unpredictable `mkdtemp` names; this
 * one has a name anybody can guess, and `TMPDIR` is a var a session can set, so
 * it is checked rather than trusted before a run reuses it. `lstat` and not
 * `stat`: the ownership test passes for a same-user attacker, so the rule that
 * does the work is that the path is a real directory nobody else can write —
 * not a symlink aimed somewhere else.
 */
function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  // Group/other *write* is the property that matters — a `TMPDIR` pointed at a
  // shared, sticky `/tmp` is the case this refuses. Read bits are left alone so
  // a directory an earlier pup created with the default mode still passes.
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
    throw new Error(
      `${path} is not a private directory owned by this user; refusing to reuse it for gate children.`,
    );
  }
}
