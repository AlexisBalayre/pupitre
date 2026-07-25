import { dirname, join, normalize } from 'node:path';

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

export function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.endsWith('.d.ts');
}

/**
 * Files a coverage report is not expected to mention. Kept deliberately narrow
 * and matched against what vitest and istanbul actually exclude: named tool
 * configs rather than every `*.config.*`, and the artifact and test directories
 * anchored where the tools anchor them. A looser rule would be a hiding place —
 * `config` is a valid role suffix in this repo, so `src/core/gate.config.ts` is
 * ordinary production code that must still be covered (decision 30).
 */
export function isCoverageExcluded(path: string): boolean {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(?:^|\/)(?:vite|vitest|webpack|rollup|jest|karma|babel|nyc|tsup|eslint|prettier|cypress|playwright|ava|tailwind|postcss)\.config\.[cm]?[jt]s$/.test(
      path,
    ) ||
    /^(?:dist|build|coverage|tests?)\//.test(path) ||
    /(?:^|\/)(?:node_modules|__tests__|__mocks__)\//.test(path)
  );
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
