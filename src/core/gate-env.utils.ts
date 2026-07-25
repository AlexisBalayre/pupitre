/**
 * Environment for gate stage commands and adapter debt capabilities — the only
 * children whose code a session can edit (`package.json` scripts, `pyproject`
 * tool config). Inheriting the operator's shell hands that code every secret in
 * it: API keys, `GH_TOKEN`, cloud credentials, `SSH_AUTH_SOCK`. An allowlist
 * inverts the default, and drops the GIT_DIR family on the way (the
 * scrubbedGitEnv invariant) since neither list carries it.
 *
 * Pupitre's own git and gh calls are NOT sandboxed this way: they run pup's
 * code, not the session's, and pushing needs the operator's credential helpers.
 */

/**
 * Locale and cache-dir vars are here because toolchains fail loudly without
 * them (byte-order marks, permission errors in a read-only default), not for
 * convenience. `NODE_OPTIONS` is deliberately absent: it can `--require` a
 * module into every node the stage runs.
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
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
];

/**
 * Operator escape hatch: `PUP_GATE_ENV=DATABASE_URL,FOO` adds those names to
 * the allowlist for a repo whose suite genuinely needs them. Set in the
 * operator's own shell, never in a session — a session cannot widen its own
 * sandbox, since pup reads this from the process it launched.
 */
const PASSTHROUGH_VAR = 'PUP_GATE_ENV';

export function gateChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const passthrough = (env[PASSTHROUGH_VAR] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const allowed = new Set([...ALLOWED_VARS, ...passthrough]);
  return Object.fromEntries(
    Object.entries(env).filter(([name, value]) => allowed.has(name) && value !== undefined),
  );
}
