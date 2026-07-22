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

/** One anchored regex per line — the format `grep -E -f <file>` expects. */
export function globsToGrepFile(globs: string[]): string {
  return `${globs.map(globToRegExpSource).join('\n')}\n`;
}
