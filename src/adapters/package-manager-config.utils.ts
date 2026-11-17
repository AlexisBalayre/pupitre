import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { CapabilityContext } from './types/adapter.types.js';

/**
 * The npm, yarn, pnpm and bun configs among the run inputs, which the branch
 * may commit, and the env files: `.env.yarn`, which Yarn 4 injects into every
 * script's environment by default, and every `.env*`, which bun loads.
 */
export const PACKAGE_MANAGER_CONFIG =
  /^(?:\.npmrc|\.yarnrc(?:\.yml)?|\.env(?:\.[^/]*)?|pnpm-workspace\.yaml|bunfig\.toml)$/;

/**
 * A key, in any of their spellings, by which a package-manager config has the
 * test script run a file, which in the gate is the branch's even where the
 * config is the target's: yarn's own binary and plugins, a node option such
 * as `--import`, the shell scripts run in, pnpm's hooks file (`pnpmfile`,
 * `global-pnpmfile`), bun's preloads, and the env files yarn injects, which
 * may set any of these.
 */
const RUNS_A_FILE =
  /yarn[-_]?path|plugins|node[-_]?options|script[-_]?shell|pnpm[-_]?file|preload|inject[-_]?environment[-_]?files/i;

/**
 * A `$` in a key, the text of a line that is not a comment before its first
 * `=` or `:`, which npm substitutes from the environment, so `${KEY}=` may
 * spell any key.
 */
const KEY_SUBSTITUTION = /^(?![ \t]*[#;])[^=:\r\n\u2028\u2029]*\$/m;

/**
 * Keys, normalised by `configKey`, that have npm read another config, which
 * nothing here checks: `globalconfig`, `userconfig`, the `prefix` whose
 * `etc/npmrc` is the global config, npm reading the global one last, after
 * the project and user configs that can move it, and the `DESTDIR` variable
 * npm puts in front of the global prefix.
 */
const CONFIG_NAMING_KEYS = new Set(['globalconfig', 'userconfig', 'prefix', 'destdir']);

/**
 * A line's key, reduced at least as far as npm's ini parser and dotenv reduce
 * it, and further, so that a spelling either reads as one of
 * `CONFIG_NAMING_KEYS` reduces to it: the text before the first `=`, trimmed
 * as JavaScript's `trim` trims (a BOM, `\f`, `\v`, U+00A0, U+2000-200A,
 * U+3000), without an `export`, cut at the first `;` or `#` (an unquoted ini
 * key ends there), `:` (a YAML key) or whitespace (a `.yarnrc` key), without
 * quotes or a `[]` (an ini array key), in lower case, without an
 * `npm_config_` and without `-` and `_`. Reducing further only refuses more.
 */
function configKey(line: string): string {
  return (line.split('=')[0] as string)
    .trim()
    .replace(/^export\s+/i, '')
    .split(/[;#:\s]/)[0]
    ?.replace(/["'[\]]/g, '')
    .toLowerCase()
    .replace(/^npm[-_]config[-_]/, '')
    .replace(/[-_]/g, '') as string;
}

/**
 * The breaks between lines: ini's, and dotenv's, whose multiline `^` also
 * starts a line after U+2028 and U+2029.
 */
const LINE_BREAKS = /[\r\n\u2028\u2029]+/;

/** Whether a config or env file has a line whose key names another config (`CONFIG_NAMING_KEYS`). */
function namesAConfig(text: string): boolean {
  return text.split(LINE_BREAKS).some((line) => CONFIG_NAMING_KEYS.has(configKey(line)));
}

/** The configs read a key per line, npm's by its ini parser and the env files by dotenv. */
const LINE_KEYED_CONFIG = /^(?:\.npmrc|\.env(?:\.[^/]*)?)$/;

/**
 * A key, or a section's name, of only the characters a plain one is spelt in;
 * a key may end in the `[]` by which ini reads it as an array of that key
 * (`public-hoist-pattern[]=`), which `configKey` reduces away.
 */
const PLAIN_KEY = /^[A-Za-z0-9._@/:+-]+(?:\[\])?$/;
const PLAIN_SECTION = /^\[[A-Za-z0-9._@/:+-]+\]$/;

/**
 * Whether a line of a `LINE_KEYED_CONFIG` file has a key, or is a section
 * header, spelt in anything but `PLAIN_KEY`'s characters: a quote, a bracket
 * but a last `[]`, whitespace inside, a non-ASCII character. ini strips
 * quotes and parses a quoted key as JSON, which allows whitespace inside, so
 * `' "prefix"'` and `[ "prefix" ]` are `prefix` to npm; rather than reduce
 * each such spelling, any key not plain is refused. The key is the text
 * before the first `=`, trimmed as JavaScript's `trim` trims and as ini trims
 * it, without an `export`. A blank line, or one whose first character is `;`
 * or `#`, is a comment to both parsers.
 */
function unplainKey(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '' || /^[;#]/.test(trimmed)) return false;
  if (trimmed.startsWith('[')) return !PLAIN_SECTION.test(trimmed);
  const key = (trimmed.replace(/^export\s+/, '').split('=')[0] as string).trim();
  return !PLAIN_KEY.test(key);
}

/**
 * Whether the package-manager config or env file `name` may have the run load
 * a file: it names one of `RUNS_A_FILE`'s keys as text, names another config
 * (`namesAConfig`), holds a backslash, by which each of these formats escapes
 * a character of a key, quoted or not (`"yarn\u0050ath"`), or a substitution
 * in a key, or, read a key per line, has a key not plainly spelt
 * (`unplainKey`). Read as text rather than parsed as each package manager
 * parses it, so a value with an escape costs the split too.
 */
export function runsAFile(name: string, text: string): boolean {
  return (
    RUNS_A_FILE.test(text) ||
    namesAConfig(text) ||
    text.includes('\\') ||
    KEY_SUBSTITUTION.test(text) ||
    (LINE_KEYED_CONFIG.test(name) && text.split(LINE_BREAKS).some(unplainKey))
  );
}

/**
 * The user-level `.npmrc` npm and pnpm read for the gate's run: the one the
 * operator names by `npm_config_userconfig` through `--gate-env`, or the one
 * in the home directory the gate's environment keeps, as it keeps `HOME`.
 * npm expands a named path's `~/` against `HOME` and resolves the rest
 * against the run's working directory, the gate checkout, where the branch may
 * commit it; rather than resolve it as npm does, a named path that is not
 * absolute throws, as do two spellings of the name, of which npm reads one.
 */
function userNpmrc({ gateEnv = [] }: CapabilityContext): string {
  const named = gateEnv.filter(
    (name) => name.toLowerCase() === 'npm_config_userconfig' && process.env[name] !== undefined,
  );
  if (named.length > 1) throw new Error(`${named.join(' and ')} both name a user .npmrc`);
  const path =
    named[0] === undefined ? join(homedir(), '.npmrc') : (process.env[named[0]] as string);
  if (!isAbsolute(path)) throw new Error(`the user .npmrc ${path} is not an absolute path`);
  return path;
}

/** The largest user-level `.npmrc` read: any real one is a few lines. */
const USER_CONFIG_MAX_BYTES = 64 * 1024;

/**
 * The user-level `.npmrc` at `path`, opened without following a link and
 * without blocking, so a link, a fifo or a device is never read through: only
 * a regular file whose size on the descriptor is at most
 * `USER_CONFIG_MAX_BYTES`, read for at most one byte more, so a sparse file
 * of any size is never loaded. Throws on anything else, the descriptor closed
 * on every path that holds one.
 */
function readUserConfig(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > USER_CONFIG_MAX_BYTES) {
      throw new Error(`${path} is not a regular file of at most ${USER_CONFIG_MAX_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(USER_CONFIG_MAX_BYTES + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length; length += read) {
      read = readSync(fd, buffer, length, buffer.length - length, null);
    }
    if (length > USER_CONFIG_MAX_BYTES) throw new Error(`${path} grew past the cap as it was read`);
    return buffer.toString('utf8', 0, length);
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the user-level `.npmrc` may have the run load a file
 * (`runsAFile`): a session can write it, and no commit holds it. Read only as
 * `readUserConfig` reads it; throws where anything else stands there, or it
 * cannot be read.
 */
export function userConfigRunsAFile(ctx: CapabilityContext): boolean {
  const path = userNpmrc(ctx);
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return false;
  return runsAFile('.npmrc', readUserConfig(path));
}
