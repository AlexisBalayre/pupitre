import { join } from 'node:path';

/**
 * Environment for gate stage commands and adapter debt capabilities — the only
 * children whose code a session can edit (`package.json` scripts, `pyproject`
 * tool config). Inheriting the operator's shell hands that code every secret in
 * it: API keys, `GH_TOKEN`, cloud credentials, `SSH_AUTH_SOCK`. An allowlist
 * inverts the default, and drops the GIT_DIR family on the way (the
 * scrubbedGitEnv invariant) since no list here — allowed, settable, or the
 * cache redirects — carries it.
 *
 * Pupitre's own git and gh calls are NOT confined this way: they run pup's
 * code, not the session's, and pushing needs the operator's credential helpers.
 *
 * Callers reach this through `runGateChild` (sandbox.utils.ts), which pairs the
 * env with the filesystem policy — one seam, one answer to what a gate child
 * can touch.
 */

/**
 * Locale vars are here because toolchains fail loudly without them (byte-order
 * marks, mojibake), not for convenience. `NODE_OPTIONS` is deliberately absent:
 * it can `--require` a module into every node the stage runs.
 */
const ALLOWED_VARS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'TZ',
  'USER',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
];

/**
 * Cache locations redirected out of `HOME` — the sandbox denies every write
 * under `HOME`, so a toolchain that defaults its cache to `~/.npm` or
 * `~/Library/Caches` would otherwise die on a permission error rather than on
 * anything the operator did wrong (decision 36). Only vars the toolchains pup
 * actually invokes honour are here. The redirect wins over an operator
 * passthrough of the same name: a cache pointed back into `HOME` is a broken
 * child, not a wider one.
 */
export const CACHE_VAR_SUBDIRS: Record<string, string> = {
  XDG_CACHE_HOME: 'xdg-cache',
  npm_config_cache: 'npm',
  COREPACK_HOME: 'corepack',
  PIP_CACHE_DIR: 'pip',
  UV_CACHE_DIR: 'uv',
};

interface GateChildEnvOptions {
  /**
   * Per-run scratch, handed over as `TMPDIR`. Separate from the cache dir
   * because the two have different lifetimes: what a run leaves in `TMPDIR`
   * should go with the run, what a toolchain caches should survive it.
   */
  scratchDir: string;
  /** Stable cache root every redirected cache var is pointed at. */
  cacheDir: string;
  /**
   * Extra names the operator allowed with `--gate-env`, for a suite that
   * genuinely needs them. A flag and not an environment variable on purpose:
   * whoever controls pup's own environment — direnv's `.envrc`, a CI job, a
   * wrapper script — could otherwise widen this list without touching the
   * command the operator typed (decision 28, refined; decision 36).
   */
  passthrough?: string[];
  /**
   * Values pup itself computes for one child — `COVERAGE_FILE` aimed at a
   * capability's report directory. Not a second ambient channel: values are
   * built from pup's own run state, such as a temp directory it just created —
   * never copied from a name in pup's environment or read from a file a
   * session can write; anything of that kind stays behind the operator's
   * `--gate-env` flag. Names come from the closed `SETTABLE_VARS` list; an
   * unlisted one throws rather than being dropped, because the passthrough
   * names come from outside pup, where ignoring is the safe default, but a
   * pup-set name is written in pup's own source, so surfacing the bug at the
   * call site beats silently not setting it.
   */
  set?: Record<string, string>;
  /** Defaults to pup's own environment. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Names `--gate-env` cannot pass through, however the operator spells the flag.
 * Each one loads attacker-chosen code into every process the child starts —
 * `NODE_OPTIONS` via `--require`, the dynamic-linker families via injected
 * libraries — so allowing them would hand back exactly what decision 28
 * excluded `NODE_OPTIONS` for in the first place. Dropped silently, like every
 * other name outside the allowlist; the flag is an escape hatch for a suite's
 * own config, not a way to re-arm the loader.
 */
const NEVER_PASSED_THROUGH = [/^NODE_OPTIONS$/, /^DYLD_/, /^LD_/];

/**
 * The only names a call site may `set` — a closed list, not a denylist over
 * the guards above. The env-var namespace is open and full of loader-shaped
 * names no denylist can enumerate: `PYTHONPATH` is Python's `NODE_OPTIONS`
 * (a `sitecustomize.py` on it imports into every interpreter a stage starts),
 * `BASH_ENV` names a file `sh -c` runs first, and `COVERAGE_FORCE_CONFIG`
 * would defeat the very redirect `COVERAGE_FILE` is on this list for. These
 * names are written in pup's own source, so a closed list costs one line per
 * legitimate use — and it keeps the cache redirects, `TMPDIR`, the allowlisted
 * values and the scrubbedGitEnv invariant un-overridable for free.
 */
const SETTABLE_VARS = ['COVERAGE_FILE'];

export function gateChildEnv(options: GateChildEnvOptions): NodeJS.ProcessEnv {
  const passthrough = (options.passthrough ?? []).filter(
    (name) => !NEVER_PASSED_THROUGH.some((pattern) => pattern.test(name)),
  );
  const allowed = new Set([...ALLOWED_VARS, ...passthrough]);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter(
      ([name, value]) => allowed.has(name) && value !== undefined,
    ),
  );
  for (const [name, subdir] of Object.entries(CACHE_VAR_SUBDIRS)) {
    env[name] = join(options.cacheDir, subdir);
  }
  env.TMPDIR = options.scratchDir;
  for (const [name, value] of Object.entries(options.set ?? {})) {
    if (!SETTABLE_VARS.includes(name)) {
      throw new Error(
        `pup tried to set ${name} for a gate child; only ${SETTABLE_VARS.join(', ')} may be computed.`,
      );
    }
    env[name] = value;
  }
  return env;
}

/** `--gate-env DATABASE_URL,CI` -> the names, ignoring spacing and empties. */
export function parseGateEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}
