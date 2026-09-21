import { dirname, join, normalize } from 'node:path';

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

export function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.endsWith('.d.ts');
}

/**
 * Whether a file holds tests rather than the code under test: the `*.test.ts`
 * suffix, and nothing else (decision 39).
 *
 * The narrowness is the design. Exempting a file hides it from the duplication
 * and dead-export metrics, and that is only safe when something forces the file
 * to actually hold tests. `*.test.ts` is what a vitest `include` conventionally
 * collects, so parking production code there makes the runner hard-fail the
 * test stage with "No test suite found in file" — self-limiting. A `*.spec.ts`
 * this project's runner does not collect, or a `tests/` directory outside its
 * include glob, is collected by nothing: either would buy exemption for free on
 * ordinary importable code, renamed in with a `git mv` that no hook sees. A
 * real test under a `tests/` layout is `tests/foo.test.ts`, which the suffix
 * already covers, so a directory arm would only ever add the unsuffixed files —
 * the attack and nothing else.
 *
 * The cost is a repo whose tests are named or placed some other way: its
 * fixture repetition gets counted rather than hidden, which is the safe
 * direction to be wrong in. Widening it means corroborating against the trusted
 * checkout's runner config rather than the path's spelling — decision 31's
 * pattern, not a longer regex.
 *
 * Deliberately *not* `isCoverageExcluded`, which answers "should a coverage
 * report mention this?" and so also swallows `dist/`, `build/` and named tool
 * configs. Those are not tests, and duplication across two `tailwind.config.ts`
 * files is still duplication.
 */
export function isTestFile(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path);
}

/**
 * Files a coverage report is not expected to mention. Kept deliberately narrow
 * and matched against what vitest and istanbul actually exclude: named tool
 * configs rather than every `*.config.*`, and the artifact and test directories
 * anchored where the tools anchor them. A looser rule would be a hiding place —
 * `config` is a valid role suffix in this repo, so `src/core/gate.config.ts` is
 * ordinary production code that must still be covered (decision 30).
 *
 * `.worktrees/` is here because it is *another checkout of this same repo*, not
 * because it is generated. Measuring the main checkout while sessions are open
 * would otherwise count every session's copy of every source file, so the
 * repo's ratio would move with how many sessions happen to exist. The python
 * adapter already skips it for the same reason.
 */
export function isCoverageExcluded(path: string): boolean {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(?:^|\/)(?:vite|vitest|webpack|rollup|jest|karma|babel|nyc|tsup|eslint|prettier|cypress|playwright|ava|tailwind|postcss)\.config\.[cm]?[jt]s$/.test(
      path,
    ) ||
    /^(?:dist|build|coverage|tests?)\//.test(path) ||
    /(?:^|\/)(?:node_modules|__tests__|__mocks__|\.worktrees)\//.test(path)
  );
}

/** Whether a repo-relative file sits inside one of `nested` (from `git-tree.client.ts`). */
export function isInNestedPackage(file: string, nested: Set<string>): boolean {
  const dirs = file.split('/').slice(0, -1);
  return dirs.some((_, i) => nested.has(dirs.slice(0, i + 1).join('/')));
}

/**
 * Resolve a relative import specifier to a repo file. Tries the literal path,
 * `.js`->`.ts` and `.js`->`.tsx` (ESM-style extensioned imports of TS sources:
 * under NodeNext a `.tsx` module is imported as `.js` too, so a `.ts`-only
 * mapping read every component of the first `.tsx` files as unimported and
 * their exports as dead), appended extensions, and directory index files.
 */
export function resolveImport(
  fromFile: string,
  specifier: string,
  files: Set<string>,
): string | undefined {
  const base = normalize(join(dirname(fromFile), specifier));
  if (base.startsWith('..')) return undefined;
  const candidates = [base];
  if (/\.js$/.test(base)) {
    candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  }
  if (/\.jsx$/.test(base)) candidates.push(base.replace(/\.jsx$/, '.tsx'));
  for (const ext of SOURCE_EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(join(base, `index${ext}`));
  return candidates.find((c) => files.has(c));
}
