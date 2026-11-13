import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { runGit, runGitBytes } from '../core/git-diff.client.js';
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

/** A directory's tree mode, which `ls-tree` lists recursively. */
const TREE_MODE = '040000';

/** The longest line `hash-object` prints for one file: a SHA-256 name and its newline. */
const OBJECT_NAME_LINE_BYTES = 65;

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
 * Keys one level down that name a module the run loads in place of the one a
 * specifier spells: `resolve.alias` at the top, and under `test` the custom
 * coverage provider's module.
 */
const VITEST_UNREAD_NESTED_KEYS: Record<string, string[]> = {
  resolve: ['alias'],
  coverage: ['customProviderModule'],
};

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
 * A specifier naming a file, a path, a `file:` URL or a `#` subpath import,
 * which in the gate is the branch's.
 */
const FILE_SPECIFIER = /^(?:[./#]|file:)/i;

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

/** A call that loads a module named at run time: `require(…)`, `x.require(…)` or `import(…)`. */
function loadsAtRunTime(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === 'require') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'require')
  );
}

/**
 * Whether a config loads a module that in the gate is the branch's: a static
 * specifier naming a file (`FILE_SPECIFIER`) or the package itself by
 * `selfName`, which resolves through its own `exports`, in an import, a
 * re-export or an `import x = require(…)`; or any `require` or dynamic
 * `import()`, whose specifier may be built at run time.
 */
function loadsAFile(source: ts.SourceFile, selfName: string | undefined): boolean {
  const namesAFile = (specifier: string): boolean =>
    FILE_SPECIFIER.test(specifier) ||
    (selfName !== undefined && (specifier === selfName || specifier.startsWith(`${selfName}/`)));
  const statically = source.statements.some((statement) => {
    const specifier = ts.isImportEqualsDeclaration(statement)
      ? ts.isExternalModuleReference(statement.moduleReference) &&
        statement.moduleReference.expression
      : (statement as { moduleSpecifier?: ts.Expression }).moduleSpecifier;
    return specifier && ts.isStringLiteralLike(specifier) && namesAFile(specifier.text);
  });
  const atRunTime = (node: ts.Node): boolean =>
    loadsAtRunTime(node) || ts.forEachChild(node, atRunTime) === true;
  return statically || atRunTime(source);
}

/**
 * The object a vitest config exports by default, bare or through the
 * `defineConfig` imported from vitest or vite; undefined for a function
 * config, `mergeConfig`, any other callee, an identifier or CommonJS, which no
 * static read answers, and for a config that loads a module the branch wrote
 * (`loadsAFile`), which runs when vitest loads the config.
 */
function exportedConfig(text: string, selfName: string | undefined): ts.Expression | undefined {
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
  if (exported.length !== 1 || parseErrors.length > 0 || loadsAFile(source, selfName)) {
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
): { include: RegExp[]; exclude: RegExp[]; rest: string } | undefined {
  const config = exportedConfig(text, selfName);
  const top = config && literalProperties(config, ['test', 'resolve', ...VITEST_UNREAD_KEYS]);
  if (
    top === undefined ||
    VITEST_UNREAD_KEYS.some((key) => top.has(key)) ||
    setsAny(top.get('resolve'), VITEST_UNREAD_NESTED_KEYS.resolve as string[])
  ) {
    return undefined;
  }
  const testConfig = top.get('test');
  const test = testConfig
    ? literalProperties(testConfig, ['include', 'exclude', 'coverage', ...VITEST_UNREAD_TEST_KEYS])
    : new Map<string, ts.Expression>();
  if (
    test === undefined ||
    VITEST_UNREAD_TEST_KEYS.some((key) => test.has(key)) ||
    setsAny(test.get('coverage'), VITEST_UNREAD_NESTED_KEYS.coverage as string[])
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

/** A listing's lines in one order, whichever order they were found in. */
function listing(lines: string[]): string {
  return lines.sort().join('\0');
}

/**
 * A directory on disk listed as `ls-tree -r -z` lists a tree: a line per file,
 * its mode, object name and path, each file hashed in `repoPath`'s object
 * format and nothing written. An empty directory, which no tree holds, lists
 * nothing. Throws on a link or anything else a tree would not check out as a
 * plain file, and on a name holding a line break, which `hash-object` cannot
 * read back from its input.
 */
function diskListing(repoPath: string, dir: string): string {
  const files: { path: string; mode: string }[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(join(dir, at), { withFileTypes: true })) {
      const path = at === '' ? entry.name : `${at}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && !/[\r\n]/.test(path)) {
        const executable = (lstatSync(join(dir, path)).mode & 0o100) !== 0;
        files.push({ path, mode: executable ? '100755' : '100644' });
      } else {
        throw new Error(`${path} is not read: not a plain file named on one line`);
      }
    }
  };
  walk('');
  if (files.length === 0) return '';
  const names = runGitBytes(repoPath, ['hash-object', '--no-filters', '--stdin-paths'], {
    input: Buffer.from(files.map(({ path }) => `${join(dir, path)}\n`).join('')),
    maxBuffer: files.length * OBJECT_NAME_LINE_BYTES,
    timeout: GATE_COMMAND_TIMEOUT_MS,
  })
    .toString('utf8')
    .split('\n');
  return listing(files.map(({ path, mode }, i) => `${mode} blob ${names[i]}\t${path}`));
}

/**
 * A checkout's root as it stands on disk, each file read without following a
 * link. Given the `repoPath` whose object format hashes its files, a directory
 * reads as the listing of its tree (`diskListing`); without one, it is not read.
 */
export function diskRoot(checkout: string, repoPath?: string): RootFiles {
  return rootFiles(
    readdirSync(checkout, { withFileTypes: true }).map((entry) => {
      const path = join(checkout, entry.name);
      const read =
        entry.isDirectory() && repoPath !== undefined
          ? () => diskListing(repoPath, path)
          : () => readPlainFile(path, { followLinks: false });
      return [entry.name, read];
    }),
  );
}

/**
 * A commit's root, listed and read from `repoPath`'s object store, never from a
 * checkout a session's code has run in (decision 143). Only a regular file's
 * blob is read, so a link is not followed; a directory reads as `ls-tree -r`
 * lists it, as `diskRoot` lists one on disk.
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
        const read = PLAIN_BLOB_MODE.test(mode)
          ? () => runGit(repoPath, ['cat-file', 'blob', oid], GIT_READ)
          : mode === TREE_MODE
            ? () =>
                listing(
                  runGit(repoPath, ['ls-tree', '-r', '-z', oid], GIT_READ)
                    .split('\0')
                    .filter((line) => line !== ''),
                )
            : unreadable(name);
        return [name, read];
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
    }
  );
}
