const GLOB_SPECIALS = /[.+^${}()|[\]\\]/g;
const GLOBSTAR_SLASH = '\0G\0';
const GLOBSTAR = '\0g\0';

/**
 * Convert a scope glob to an anchored regex source string.
 * Supported: `**` (any path segment run), `*` (within one segment), `?` (one char).
 * A trailing `/` or a bare directory name matches everything beneath it.
 *
 * Globstars are swapped for NUL-delimited sentinels before the single-`*` pass so
 * their expansion can't be re-processed, then restored — plain string ops, no regex
 * over the intermediate form.
 */
export function globToRegExpSource(glob: string): string {
  let g = glob.trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g = `${g}**`;
  const source = g
    .replace(GLOB_SPECIALS, '\\$&')
    .replaceAll('**/', GLOBSTAR_SLASH)
    .replaceAll('**', GLOBSTAR)
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
    .replaceAll(GLOBSTAR_SLASH, '(?:[^/]+/)*')
    .replaceAll(GLOBSTAR, '.*');
  return `^${source}$`;
}

export function globToRegExp(glob: string): RegExp {
  return new RegExp(globToRegExpSource(glob));
}

/**
 * One anchored regex per line — the format `grep -E -f <file>` expects.
 *
 * Empty lines are dropped rather than written: to `grep -E -f` a blank pattern
 * matches every input, so a single one would silently turn a scope allowlist
 * into allow-all. Belt and braces with `validateInput`, which rejects the
 * control characters that can produce one.
 */
export function globsToGrepFile(globs: string[]): string {
  // A converted glob is always `^…$` and so never blank on its own, but one
  // carrying a newline expands into two pattern lines and the blank half is
  // what `grep -E -f` matches every path against. Such a glob is malformed —
  // `validateInput` rejects it upstream — and the whole glob is dropped rather
  // than split, because splitting emits the tail as an unanchored fragment that
  // matches more than the glob ever named. An empty result writes an empty
  // file, failing the hook's grep closed.
  const patterns = globs.filter((glob) => !/[\r\n\0]/.test(glob)).map(globToRegExpSource);
  return patterns.length > 0 ? `${patterns.join('\n')}\n` : '';
}
