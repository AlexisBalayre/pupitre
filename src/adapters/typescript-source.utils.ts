import { dirname, join, normalize } from 'node:path';
import ts from 'typescript';

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

/** Whether a repo-relative file sits inside one of `nested` (see `nestedPackageDirs` in `git-tree.client.ts`). */
export function isInNestedPackage(file: string, nested: Set<string>): boolean {
  const dirs = file.split('/').slice(0, -1);
  return dirs.some((_, i) => nested.has(dirs.slice(0, i + 1).join('/')));
}

/**
 * A tsconfig's `compilerOptions.paths`: pattern -> substitutions, each already
 * joined to the repo-relative directory it resolves from (`baseUrl`, else the
 * tsconfig's own, which is the repo root). A Map, so no specifier can reach a
 * prototype key.
 */
export type PathAliases = Map<string, string[]>;

/**
 * The `paths` of a root `tsconfig.json`'s text. `extends` is not followed, and
 * text TypeScript cannot parse yields no aliases, which is today's relative-only
 * resolution.
 */
export function parsePathAliases(tsconfigText: string): PathAliases {
  const aliases: PathAliases = new Map();
  const { config, error } = ts.parseConfigFileTextToJson('tsconfig.json', tsconfigText);
  const options = error ? undefined : config?.compilerOptions;
  const paths = options?.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return aliases;
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : '.';
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue;
    aliases.set(
      pattern,
      targets.filter((t): t is string => typeof t === 'string').map((t) => join(baseUrl, t)),
    );
  }
  return aliases;
}

/**
 * The substitutions of the pattern TypeScript picks for a bare specifier: an
 * exact key first, else the wildcard pattern with the longest prefix, its `*`
 * replaced by what it matched. A specifier no pattern matches has none.
 */
function aliasTargets(specifier: string, aliases: PathAliases): string[] {
  const exact = aliases.get(specifier);
  if (exact && !specifier.includes('*')) return exact;
  let best: { prefix: string; matched: string; targets: string[] } | undefined;
  for (const [pattern, targets] of aliases) {
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      (!best || prefix.length > best.prefix.length)
    ) {
      const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
      best = { prefix, matched, targets };
    }
  }
  return best ? best.targets.map((t) => t.replace('*', best.matched)) : [];
}

/**
 * Resolve an import specifier to a repo file: a relative one from `fromFile`,
 * a bare one through `aliases` and nowhere else, so a package import never
 * lands on a same-named repo file. Each target tries the literal path,
 * `.js`->`.ts` and `.js`->`.tsx` (ESM-style extensioned imports of TS sources:
 * under NodeNext a `.tsx` module is imported as `.js` too, so a `.ts`-only
 * mapping read every component of the first `.tsx` files as unimported and
 * their exports as dead), appended extensions, and directory index files.
 */
export function resolveImport(
  fromFile: string,
  specifier: string,
  files: Set<string>,
  aliases: PathAliases = new Map(),
): string | undefined {
  if (!specifier.startsWith('.')) {
    for (const target of aliasTargets(specifier, aliases)) {
      const resolved = resolveFile(normalize(target), files);
      if (resolved) return resolved;
    }
    return undefined;
  }
  return resolveFile(normalize(join(dirname(fromFile), specifier)), files);
}

function resolveFile(base: string, files: Set<string>): string | undefined {
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
