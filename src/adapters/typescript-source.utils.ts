import { dirname, join, normalize } from 'node:path';

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

export function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.endsWith('.d.ts');
}

/**
 * Resolve a relative import specifier to a repo file. Tries the literal path,
 * `.js`->`.ts` (ESM-style extensioned imports of TS sources), appended
 * extensions, and directory index files.
 */
export function resolveImport(
  fromFile: string,
  specifier: string,
  files: Set<string>,
): string | undefined {
  const base = normalize(join(dirname(fromFile), specifier));
  if (base.startsWith('..')) return undefined;
  const candidates = [base];
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, '.ts'));
  if (/\.jsx$/.test(base)) candidates.push(base.replace(/\.jsx$/, '.tsx'));
  for (const ext of SOURCE_EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(join(base, `index${ext}`));
  return candidates.find((c) => files.has(c));
}
