import ts from 'typescript';
import { globToRegExp } from '../core/glob.utils.js';
import { loadsAFile, parsedConfig } from './config-module.utils.js';
import type { RootFiles } from './types/adapter.types.js';

/** The root configs vitest looks for, in its own order: the first one present is the one it loads. */
const VITEST_CONFIG_FILES = ['vitest', 'vite'].flatMap((stem) =>
  ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((ext) => `${stem}.config.${ext}`),
);

/**
 * A workspace file, under either name vitest 2 and 3 look for, which turns one
 * run into several projects this does not read.
 */
const VITEST_WORKSPACE_FILE = /^vitest\.(?:workspace|projects)\.(?:[cm]?[jt]s|json)$/i;

/** What vitest collects when its config declares no `include` (vitest 3 and 4). */
const VITEST_DEFAULT_INCLUDE = /(?:^|\/)[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Vitest 3's default `exclude`, a superset of vitest 4's: a path under one of
 * these directories, or a tool config's name. Applied whatever the config
 * declares, since excluding more only counts more as source.
 */
const VITEST_DEFAULT_EXCLUDE =
  /(?:^|\/)(?:node_modules|dist|cypress|\.idea|\.git|\.cache|\.output|\.temp)\/|(?:^|\/)(?:karma|rollup|webpack|vite|vitest|jest|ava|babel|nyc|cypress|tsup|build|eslint|prettier)\.config\.[^/]*$/;

/** Patterns read from one `include` or `exclude`, as pytest's are capped (decision 31). */
const VITEST_MAX_PATTERNS = 64;

/**
 * `**` segments allowed in one pattern before its last: each is a `(?:[^/]+/)*`
 * the next can backtrack into, so two cost a path of k segments k squared. A
 * last `**` is a `.*$`, which matches whatever reaches it.
 */
const VITEST_PATTERN_MAX_INNER_GLOBSTARS = 1;

/**
 * Segments allowed in one pattern: after a `**`, each fixed one is re-walked
 * every time the `**` gives back a segment, so a path costs its length times
 * this.
 */
const VITEST_PATTERN_MAX_SEGMENTS = 16;

/**
 * Characters allowed in one pattern: a `*` gives back one character at a time
 * to the literal after it, so a segment costs its length times this.
 */
const VITEST_PATTERN_MAX_LENGTH = 256;

/**
 * The one spelling of a pattern this reads: segments of ASCII letters, digits,
 * `_`, `-`, `.` and `*` joined by single `/`s, none of them `.` or `..`. Vitest's
 * globber reads `./src/a`, `src/a/`, `src/./a` and `src//a` all as `src/a`,
 * takes `?`, `\\`, braces, classes, extglobs and `!` as glob syntax, which
 * `globToRegExp` escapes, and reads whitespace as part of a name; any other
 * spelling may name what the read does not.
 */
const READ_GLOB = /^(?!\.\.?(?:\/|$))[\w.*-]+(?:\/(?!\.\.?(?:\/|$))[\w.*-]+)*$/;

/** A segment holding two `*` without being a bare `**`, which is not linear. */
const UNREAD_SEGMENT = /^(?!\*\*$)(?:[^*]*\*){2}/;

/**
 * Top-level keys that move what one run collects, or run code the branch may
 * have written; `__proto__` hands the config inherited keys.
 */
const VITEST_UNREAD_KEYS = ['root', 'plugins', '__proto__'];

/**
 * A `resolve.alias` key that is read: a bare `@` or `@name` with no `/`, which
 * names no package. Vite redirects a specifier equal to it or starting with it
 * and a `/`, so `@name` still redirects the packages of a scope of that name,
 * which the caller checks `node_modules` for (`VitestCollection.aliases`); `@`
 * redirects only `@/...`, which no package is named.
 */
const READ_ALIAS_KEY = /^@[\w.-]*$/;

/**
 * Keys under `test` that move or split what one run collects, or name modules
 * the run loads, which the branch may have written: a setup file can register
 * a test in every collected file, and a reporter, runner or pool can pass a
 * run that failed. `typecheck` can make a run collect only type tests, which
 * run no test-named file.
 */
const VITEST_UNREAD_TEST_KEYS = [
  'dir',
  'root',
  'projects',
  'workspace',
  'typecheck',
  'setupFiles',
  'globalSetup',
  'reporters',
  'environment',
  'runner',
  'pool',
  'poolOptions',
  'execArgv',
  'sequence',
  'alias',
  'environmentMatchGlobs',
  'poolMatchGlobs',
  'snapshotSerializers',
  'diff',
  'browser',
  '__proto__',
];

/**
 * A path holding a line break, which `.` in a pattern's regex does not match,
 * so a `**` before an exclude's `(?:/.*)?$` backtracks over it quadratically.
 */
const UNREAD_PATH = /[\n\r\u2028\u2029]/;

/** The modules a config may take `defineConfig` from, which returns its argument. */
const VITEST_CONFIG_MODULES = ['vitest/config', 'vite'];

/** Wrappers that change nothing an expression evaluates to. */
const OUTER_EXPRESSIONS = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
]);

/**
 * A glob's regex, or undefined where it is not one this reads in linear time
 * on a path: each segment is `**` or holds at most one `*`, at most one before
 * the last is `**`, and the pattern is short, since a long one multiplies what
 * each of those costs. Patterns come from config a session writes, or one
 * merge earlier wrote, and are matched against every path on the branch inside
 * the merge lock.
 */
function vitestGlob(pattern: string): RegExp | undefined {
  const segments = pattern.split('/');
  const innerGlobstars = segments.slice(0, -1).filter((segment) => segment === '**').length;
  if (
    pattern.length > VITEST_PATTERN_MAX_LENGTH ||
    segments.length > VITEST_PATTERN_MAX_SEGMENTS ||
    !READ_GLOB.test(pattern) ||
    innerGlobstars > VITEST_PATTERN_MAX_INNER_GLOBSTARS ||
    segments.some((segment) => UNREAD_SEGMENT.test(segment))
  ) {
    return undefined;
  }
  return globToRegExp(pattern);
}

/** An expression with its parentheses, `as` and `satisfies` taken off. */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let expression = node;
  while (OUTER_EXPRESSIONS.has(expression.kind)) {
    expression = (expression as ts.ParenthesizedExpression).expression;
  }
  return expression;
}

/**
 * The `keys` an object literal assigns, or undefined where it cannot be read
 * statically: a spread, a computed name, a key named twice, or one of `keys`
 * given any way but `key: value`. Other keys are not looked at.
 */
function literalProperties(
  node: ts.Expression,
  keys: string[],
): Map<string, ts.Expression> | undefined {
  const object = unwrapExpression(node);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  const found = new Map<string, ts.Expression>();
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) {
      return undefined;
    }
    const key = property.name.text;
    if (!keys.includes(key)) continue;
    if (!ts.isPropertyAssignment(property) || found.has(key)) return undefined;
    found.set(key, property.initializer);
  }
  return found;
}

/** An array of at most 64 string literals, or undefined for anything else. */
function literalStrings(node: ts.Expression): string[] | undefined {
  const array = unwrapExpression(node);
  if (
    !ts.isArrayLiteralExpression(array) ||
    array.elements.length > VITEST_MAX_PATTERNS ||
    !array.elements.every(ts.isStringLiteralLike)
  ) {
    return undefined;
  }
  return array.elements.map((element) => (element as ts.StringLiteralLike).text);
}

/** Whether a statement imports from a module whose `defineConfig` returns its argument. */
function importsVitestConfig(statement: ts.Statement): statement is ts.ImportDeclaration {
  return (
    ts.isImportDeclaration(statement) &&
    VITEST_CONFIG_MODULES.includes((statement.moduleSpecifier as ts.StringLiteral).text)
  );
}

/** The local names an import binds to `defineConfig`, aliased or not. */
function defineConfigNames(statement: ts.ImportDeclaration): string[] {
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return [];
  return bindings.elements
    .filter((element) => (element.propertyName ?? element.name).text === 'defineConfig')
    .map((element) => element.name.text);
}

/**
 * The object a vitest config exports by default, bare or through the
 * `defineConfig` imported from vitest or vite; undefined for a function
 * config, `mergeConfig`, any other callee, an identifier or CommonJS, which no
 * static read answers, and for a config that loads a module the branch wrote
 * (`loadsAFile`), which runs when vitest loads the config.
 */
function exportedConfig(text: string, selfName: string | undefined): ts.Expression | undefined {
  const { source, parses } = parsedConfig(text);
  const exported = source.statements.filter(
    (statement): statement is ts.ExportAssignment =>
      ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  const imports = source.statements.filter(importsVitestConfig);
  if (exported.length !== 1 || !parses || loadsAFile(source, selfName)) {
    return undefined;
  }
  const callees = new Set(imports.flatMap(defineConfigNames));
  let config = unwrapExpression((exported[0] as ts.ExportAssignment).expression);
  if (
    ts.isCallExpression(config) &&
    ts.isIdentifier(config.expression) &&
    callees.has(config.expression.text) &&
    config.arguments.length === 1
  ) {
    config = unwrapExpression(config.arguments[0] as ts.Expression);
  }
  return ts.isObjectLiteralExpression(config) ? config : undefined;
}

/**
 * `text` with each of `lists` cut out, with the whitespace and comments before
 * it, which run nothing: the config the read compares across checkouts.
 */
function withoutLists(text: string, lists: ts.Expression[]): string {
  let rest = text;
  for (const list of lists.sort((a, b) => b.pos - a.pos)) {
    rest = rest.slice(0, list.pos) + rest.slice(list.end);
  }
  return rest;
}

/**
 * Whether an object sets one of `keys`, or cannot be read statically
 * (`literalProperties`), which may hide one.
 */
function setsAny(node: ts.Expression | undefined, keys: string[]): boolean {
  if (node === undefined) return false;
  const found = literalProperties(node, keys);
  return found === undefined || keys.some((key) => found.has(key));
}

/**
 * The keys of a `resolve`'s `alias`, none where it has none, or undefined
 * where one cannot be read: a `resolve` or `alias` that is not an object
 * literal read statically (an array of `find` entries included), or an alias
 * key that is not `READ_ALIAS_KEY`. An alias redirects a specifier a test or
 * the code under it spells to a module the branch wrote.
 */
function aliasKeys(resolve: ts.Expression | undefined): string[] | undefined {
  const found = resolve === undefined ? new Map() : literalProperties(resolve, ['alias']);
  if (found === undefined) return undefined;
  const alias = found.get('alias');
  if (alias === undefined) return [];
  const object = unwrapExpression(alias);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  const keys = object.properties.map((property) =>
    ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)
      ? property.name.text
      : undefined,
  );
  return keys.every((key): key is string => key !== undefined && READ_ALIAS_KEY.test(key))
    ? keys
    : undefined;
}

/**
 * A config's `include` and `exclude` as regexes, and its text without them, or
 * undefined where they cannot be read: an unread key, or an `include` or
 * `exclude` that is not a literal list. An `include` pattern this does not
 * read collects nothing; an `exclude` one leaves the whole answer unknown. An
 * exclude names a directory as well as a file, so it matches a path up to any
 * `/`. `selfName` is the package's own name, a specifier the config may not
 * load (`loadsAFile`).
 */
function configGlobs(
  text: string,
  selfName: string | undefined,
): { include: RegExp[]; exclude: RegExp[]; rest: string; aliases: string[] } | undefined {
  const config = exportedConfig(text, selfName);
  const top = config && literalProperties(config, ['test', 'resolve', ...VITEST_UNREAD_KEYS]);
  if (top === undefined || VITEST_UNREAD_KEYS.some((key) => top.has(key))) return undefined;
  const aliases = aliasKeys(top.get('resolve'));
  if (aliases === undefined) return undefined;
  const testConfig = top.get('test');
  const test = testConfig
    ? literalProperties(testConfig, ['include', 'exclude', 'coverage', ...VITEST_UNREAD_TEST_KEYS])
    : new Map<string, ts.Expression>();
  if (
    test === undefined ||
    VITEST_UNREAD_TEST_KEYS.some((key) => test.has(key)) ||
    setsAny(test.get('coverage'), ['customProviderModule'])
  ) {
    return undefined;
  }
  const included = test.get('include');
  const excluded = test.get('exclude');
  const includePatterns = included && literalStrings(included);
  if (includePatterns?.some((pattern) => pattern.startsWith('!'))) return undefined;
  const include = included
    ? includePatterns?.map(vitestGlob).filter((glob): glob is RegExp => glob !== undefined)
    : [VITEST_DEFAULT_INCLUDE];
  const exclude = excluded ? literalStrings(excluded)?.map(vitestGlob) : [];
  if (!include || !exclude || exclude.some((glob) => glob === undefined)) return undefined;
  return {
    include,
    exclude: [
      VITEST_DEFAULT_EXCLUDE,
      ...(exclude as RegExp[]).map((glob) => new RegExp(`${glob.source.slice(0, -1)}(?:/.*)?$`)),
    ],
    rest: withoutLists(
      text,
      [included, excluded].filter((list): list is ts.Expression => list !== undefined),
    ),
    aliases,
  };
}

/** What one vitest run collects, and the config that says so without its lists. */
interface VitestCollection {
  collects: (path: string) => boolean;
  /**
   * The config's file name and text with its `include` and `exclude` lists cut
   * out. Vitest runs the branch's config, so its lists are read only where the
   * rest is the trusted config's: whatever else the branch's sets runs, and may
   * pass a file the lists collect (decision 143).
   */
  config: string;
  /**
   * The config's `resolve.alias` keys, each a bare `@name`: one that names a
   * scope in `node_modules` redirects its packages to the branch's modules.
   */
  aliases: string[];
}

/**
 * What a plain vitest run over `root` collects, or undefined where that cannot
 * be read: no config at the root, a workspace file, or a config `configGlobs`
 * does not read, given the package's own name from the root's manifest. The
 * config is the first of vitest's own list present, parsed, never run. With none at the root, vitest loads the first it finds in a
 * directory above, which a session can write and no read of the commit sees.
 * A path holding a line break is collected by nothing (`UNREAD_PATH`). Throws
 * where the root cannot be read.
 */
export function vitestCollection(root: RootFiles): VitestCollection | undefined {
  if ([...root.keys()].some((name) => VITEST_WORKSPACE_FILE.test(name))) return undefined;
  const file = VITEST_CONFIG_FILES.find((name) => root.has(name));
  if (file === undefined) return undefined;
  const manifest = root.get('package.json');
  const name = manifest && (JSON.parse(manifest()) as { name?: unknown } | null)?.name;
  const globs = configGlobs(
    (root.get(file) as () => string)(),
    typeof name === 'string' ? name : undefined,
  );
  return (
    globs && {
      collects: (path) =>
        !UNREAD_PATH.test(path) &&
        !globs.exclude.some((glob) => glob.test(path)) &&
        globs.include.some((glob) => glob.test(path)),
      config: [file, globs.rest].join('\0'),
      aliases: globs.aliases,
    }
  );
}
