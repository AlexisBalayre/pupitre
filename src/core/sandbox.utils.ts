import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_VAR_SUBDIRS, gateChildEnv } from './gate-env.utils.js';

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
  /** Further writable paths — the trusted checkout, a capability's output dir. */
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
    execFileSync(SANDBOX_EXEC, ['-f', writeProfile(policyDir, [scratchDir]), 'true'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mode = 'applied';
  } catch (error) {
    const failure = error as { stderr?: string };
    // Only the nesting refusal degrades to `inherited`. Anything else means the
    // sandbox is broken in a way pup does not understand, so it refuses.
    if (!/sandbox_apply/.test(failure.stderr ?? '')) throw error;
    mode = 'inherited';
  }
  return mode;
}

/**
 * Run one gate child. On darwin it is wrapped in `sandbox-exec`; a sandbox that
 * cannot be set up throws rather than degrading to an unconfined run, so the
 * stage fails and the merge refuses — the invariant is that no session-authored
 * code ever runs unconfined on a platform pup claims to confine. The one
 * degradation is `inherited`, and it does not break that invariant: the child
 * is still inside the sandbox pup is inside.
 *
 * Returns the child's stdout. A non-zero exit throws execFileSync's error, with
 * `stdout`/`stderr` attached, exactly as the direct calls this replaced did.
 */
export function runGateChild(command: string, args: string[], options: GateChildOptions): string {
  const applied = sandboxMode() === 'applied';
  const { scratchDir, cacheDir, policyDir } = sandboxRun();
  const env = gateChildEnv({ passthrough: options.gateEnv, scratchDir, cacheDir });
  const invocation = applied
    ? {
        command: SANDBOX_EXEC,
        args: [
          '-f',
          writeProfile(policyDir, [
            options.cwd,
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
 * policy expressible at all: the worktree a gate measures normally lives *under*
 * `HOME`, so the blanket write-deny lands first and the writable paths override
 * it. The two trailing denies are last on purpose — pup's own store and the
 * profile file itself stay unwritable even if a caller passes a path that
 * contains them.
 */
export function sandboxProfile(policy: {
  /** Absolute, symlink-resolved paths the child may write under. */
  writablePaths: string[];
  /** The operator's home. Write-denied whole, with no carve-outs. */
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
    `(deny file-write*${subpaths([policy.home])})`,
    `(deny file-read*${subpaths(DENIED_READ_HOME_PATHS.map((path) => join(policy.home, path)))})`,
    `(allow file-write*${subpaths(policy.writablePaths)})`,
    `(deny file-write*${subpaths([join(policy.home, PUPITRE_HOME), policy.policyDir])})`,
    '',
  ].join('\n');
}

/** SBPL string literals: only the quote and the escape itself need handling. */
function escapeSbpl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function writeProfile(policyDir: string, writablePaths: string[]): string {
  const profilePath = join(policyDir, 'gate-child.sb');
  writeFileSync(
    profilePath,
    sandboxProfile({
      writablePaths: [...new Set(writablePaths.map(resolvePath))],
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
  /** Where the redirected toolchain caches live. Outlives the run on purpose. */
  cacheDir: string;
  /** Holds the generated profile. Write-denied to every child. */
  policyDir: string;
}

let run: SandboxRun | undefined;

/**
 * Created on the first child. One pup process is one gate run, so process scope
 * is run scope for the scratch and the profile — both go when it exits.
 *
 * The toolchain cache does *not*: it is a stable directory reused by every run.
 * `HOME` is write-denied, so caches that used to land in `~/.npm` or
 * `~/Library/Caches` are redirected here, and redirecting them somewhere that
 * starts empty every time is worse than not redirecting at all — corepack
 * re-downloads the repo's package manager on each `pup merge`, which turns a
 * local gate into a network-dependent one. Reusing the directory keeps them
 * warm the way the `HOME` locations were. It is a *cache*, poisonable by a gate
 * child; so was `~/.npm`, and so is any path outside `HOME` under a
 * default-allow write policy, which is the ceiling decision 36 states.
 */
function sandboxRun(): SandboxRun {
  if (run) return run;
  const base = resolvePath(tmpdir());
  const cacheDir = join(base, TOOLCHAIN_CACHE_DIRNAME);
  const created: SandboxRun = {
    scratchDir: mkdtempSync(join(base, 'pup-gate-')),
    cacheDir,
    policyDir: mkdtempSync(join(base, 'pup-sandbox-')),
  };
  // Created up front: a tool handed a cache dir that does not exist mostly
  // creates it, and the ones that don't fail for a reason nobody would guess.
  for (const subdir of Object.values(CACHE_VAR_SUBDIRS)) {
    mkdirSync(join(cacheDir, subdir), { recursive: true });
  }
  process.on('exit', () => {
    rmSync(created.scratchDir, { recursive: true, force: true });
    rmSync(created.policyDir, { recursive: true, force: true });
  });
  run = created;
  return created;
}
