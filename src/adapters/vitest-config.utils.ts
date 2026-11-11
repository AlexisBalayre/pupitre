import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { runGit } from '../core/git-diff.client.js';
import { globToRegExp } from '../core/glob.utils.js';
import { GATE_COMMAND_TIMEOUT_MS } from '../core/merge-gate.constants.js';
import { readPlainFile } from './capability.utils.js';
import type { RootFiles } from './types/adapter.types.js';

/** Timed like every other child pup runs: git reads config a session can write. */
const GIT_READ: Parameters<typeof runGit>[2] = {
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: GATE_COMMAND_TIMEOUT_MS,
};

/** The tree modes of a regular file; a link, a submodule or a directory is none. */
const PLAIN_BLOB_MODE = /^100(?:644|755)$/;

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
  '__proto__',
];

/** A specifier naming a file, a path or a `#` subpath import, which in the gate is the branch's. */
const FILE_SPECIFIER = /^[./#]/;

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
 * static read answers, and for a config that imports or re-exports a file by
 * path, which in the gate is the branch's and runs when vitest loads it.
 */
function exportedConfig(text: string): ts.Expression | undefined {
  const source = ts.createSourceFile(
    'vitest.config.ts',
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const exported = source.statements.filter(
    (statement): statement is ts.ExportAssignment =>
      ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  const imports = source.statements.filter(importsVitestConfig);
  // A config with a syntax error: the parser recovers into a tree vitest never loads.
  const parseErrors = (source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics;
  const loadsAFile = source.statements.some((statement) =>
    FILE_SPECIFIER.test(
      (statement as { moduleSpecifier?: ts.StringLiteral }).moduleSpecifier?.text ?? '',
    ),
  );
  if (exported.length !== 1 || parseErrors.length > 0 || loadsAFile) {
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
 * A config's `include` and `exclude` as regexes, and its text without them, or
 * undefined where they cannot be read: an unread key, or an `include` or
 * `exclude` that is not a literal list. An `include` pattern this does not
 * read collects nothing; an `exclude` one leaves the whole answer unknown. An
 * exclude names a directory as well as a file, so it matches a path up to any
 * `/`.
 */
function configGlobs(
  text: string,
): { include: RegExp[]; exclude: RegExp[]; rest: string } | undefined {
  const config = exportedConfig(text);
  const top = config && literalProperties(config, ['test', ...VITEST_UNREAD_KEYS]);
  if (top === undefined || VITEST_UNREAD_KEYS.some((key) => top.has(key))) return undefined;
  const testConfig = top.get('test');
  const test = testConfig
    ? literalProperties(testConfig, ['include', 'exclude', ...VITEST_UNREAD_TEST_KEYS])
    : new Map<string, ts.Expression>();
  if (test === undefined || VITEST_UNREAD_TEST_KEYS.some((key) => test.has(key))) {
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
    rest: withoutLists(text, [...test.values()]),
  };
}

function unreadable(name: string): () => string {
  return () => {
    throw new Error(`${name} is not read: a name not in lower case, or not a plain file`);
  };
}

/** Higher for a name not in lower case, which sorts after one that is. */
const notLowerCase = ([name]: [string, unknown]): number => Number(name !== name.toLowerCase());

/**
 * A character outside ASCII. APFS folds some onto ASCII by its own tables
 * (`ſ` onto `s`), which no JavaScript case mapping reproduces, so a root name
 * holding one may open for any file a run reads.
 */
const NON_ASCII = /[\u0080-￿]/;

/** Throws where a name holds a character outside ASCII (`NON_ASCII`). */
function rootFiles(entries: [string, () => string][]): RootFiles {
  if (entries.some(([name]) => NON_ASCII.test(name))) {
    throw new Error('a root name outside ASCII may open for any file a run reads');
  }
  const root: RootFiles = new Map();
  // Lower-case names first, so one that folds onto another replaces its read.
  for (const [name, read] of entries.sort((a, b) => notLowerCase(a) - notLowerCase(b))) {
    const key = name.toLowerCase();
    root.set(key, name === key ? read : unreadable(name));
  }
  return root;
}

/** A checkout's root as it stands on disk, each file read without following a link. */
export function diskRoot(checkout: string): RootFiles {
  return rootFiles(
    readdirSync(checkout).map((name) => [
      name,
      () => readPlainFile(join(checkout, name), { followLinks: false }),
    ]),
  );
}

/**
 * A commit's root, listed and read from `repoPath`'s object store, never from a
 * checkout a session's code has run in (decision 143). Only a regular file's
 * blob is read, so a link is not followed.
 */
export function treeRoot(repoPath: string, sha: string): RootFiles {
  return rootFiles(
    runGit(repoPath, ['ls-tree', '-z', sha], GIT_READ)
      .split('\0')
      .filter((entry) => entry !== '')
      .map((entry) => {
        // "<mode> <type> <oid>\t<name>": the name is everything after the first tab.
        const tab = entry.indexOf('\t');
        const [mode = '', , oid = ''] = entry.slice(0, tab).split(' ');
        const name = entry.slice(tab + 1);
        const read = () => runGit(repoPath, ['cat-file', 'blob', oid], GIT_READ);
        return [name, PLAIN_BLOB_MODE.test(mode) ? read : unreadable(name)];
      }),
  );
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
}

/**
 * What a plain vitest run over `root` collects, or undefined where that cannot
 * be read: no config at the root, a workspace file, or a config `configGlobs`
 * does not read. The config is the first of vitest's own list present, parsed,
 * never run. With none at the root, vitest loads the first it finds in a
 * directory above, which a session can write and no read of the commit sees.
 * A path holding a line break is collected by nothing (`UNREAD_PATH`). Throws
 * where the root cannot be read.
 */
export function vitestCollection(root: RootFiles): VitestCollection | undefined {
  if ([...root.keys()].some((name) => VITEST_WORKSPACE_FILE.test(name))) return undefined;
  const file = VITEST_CONFIG_FILES.find((name) => root.has(name));
  if (file === undefined) return undefined;
  const globs = configGlobs((root.get(file) as () => string)());
  return (
    globs && {
      collects: (path) =>
        !UNREAD_PATH.test(path) &&
        !globs.exclude.some((glob) => glob.test(path)) &&
        globs.include.some((glob) => glob.test(path)),
      config: [file, globs.rest].join('\0'),
    }
  );
}
