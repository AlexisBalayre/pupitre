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
 * tsconfig's own, which is the repo root), in longest-wildcard-prefix-first
 * order. A Map, so no specifier can reach a prototype key.
 */
export type PathAliases = Map<string, string[]>;

/**
 * Bounds on the `paths` honoured from one tsconfig. The tsconfig is the
 * session's, `readPlainFile` lets it reach 1 MiB, and every bare import is
 * resolved synchronously inside the merge lock, where no stage timeout or
 * interrupt forwarding can reach (decisions 31 and 110). Each bound caps one
 * term of what an import costs. Entries (patterns plus substitutions) cap the
 * wildcard scan. Characters cap the length of every string built from a
 * substitution, so an explicit `baseUrl`, which prefixes each one, counts once
 * per substitution. Substitutions per pattern cap how many targets one import
 * fans out to, each one about 17 candidate paths and a copy of the matched
 * specifier. A real `paths` has a handful of short entries.
 */
const MAX_PATH_ALIAS_ENTRIES = 256;
const MAX_PATH_ALIAS_CHARS = 2048;
const MAX_PATH_ALIAS_SUBSTITUTIONS = 8;

/**
 * The `paths` of a root `tsconfig.json`'s text. `extends` is not followed.
 * Text TypeScript cannot parse, or a `paths` over any of the bounds above,
 * yields no aliases, which is today's relative-only resolution. A `paths` or
 * `baseUrl` of a shape tsc rejects throws, and the caller falls back to no
 * aliases.
 */
export function parsePathAliases(tsconfigText: string): PathAliases {
  const { config, error } = ts.parseConfigFileTextToJson('tsconfig.json', tsconfigText);
  if (error) return new Map();
  const { baseUrl = '.', paths = {} } = config.compilerOptions ?? {};
  const entries = Object.entries(paths) as [string, string[]][];
  const size = entries.reduce((n, [, targets]) => n + 1 + targets.length, 0);
  const baseChars = (config.compilerOptions?.baseUrl ?? '').length;
  const chars = entries.reduce(
    (n, [p, targets]) => n + p.length + targets.join('').length + targets.length * baseChars,
    0,
  );
  if (
    size > MAX_PATH_ALIAS_ENTRIES ||
    chars > MAX_PATH_ALIAS_CHARS ||
    entries.some(([, targets]) => targets.length > MAX_PATH_ALIAS_SUBSTITUTIONS)
  ) {
    return new Map();
  }
  return new Map(
    entries
      .sort(([a], [b]) => b.indexOf('*') - a.indexOf('*'))
      .map(([pattern, targets]) => [pattern, targets.map((t) => join(baseUrl, t))]),
  );
}

/**
 * The substitutions of the pattern TypeScript picks for a bare specifier: an
 * exact key first, else the first matching wildcard, which `parsePathAliases`'
 * order makes the one with the longest prefix, its `*` replaced literally by
 * what it matched, as tsc does: a replacement string would expand `$'`,
 * `` $` `` and `$&` in the specifier into copies of the target. A specifier
 * no pattern matches has none.
 */
function aliasTargets(specifier: string, aliases: PathAliases): string[] {
  const exact = aliases.get(specifier);
  if (exact) return exact;
  for (const [pattern, targets] of aliases) {
    const star = pattern.indexOf('*');
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      star === -1 ||
      specifier.length < prefix.length + suffix.length ||
      !specifier.startsWith(prefix) ||
      !specifier.endsWith(suffix)
    ) {
      continue;
    }
    const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
    return targets.map((t) => t.replace('*', () => matched));
  }
  return [];
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
  const targets = specifier.startsWith('.')
    ? [join(dirname(fromFile), specifier)]
    : aliasTargets(specifier, aliases);
  return targets.map((t) => resolveFile(normalize(t), files)).find((f) => f !== undefined);
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
