import ts from 'typescript';

/**
 * A specifier naming a file, a path, a `file:` URL or a `#` subpath import,
 * which in the gate is the branch's.
 */
const FILE_SPECIFIER = /^(?:[./#]|file:)/i;

/**
 * A node that loads a module named at run time: a call to `require(…)`,
 * `x.require(…)` or `import(…)`, or an `import x = require(…)` below the top
 * level, in a namespace or a block, which the parser takes there without a
 * syntax error and the bundler turns into a `require` as it does one at the
 * top. Reads `parent`, so the tree must be parsed with parent nodes set.
 */
function loadsAtRunTime(node: ts.Node): boolean {
  if (ts.isExternalModuleReference(node)) return !ts.isSourceFile(node.parent.parent);
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
 * re-export or an `import x = require(…)` at the top level; or any `require`
 * or dynamic `import()`, whose specifier may be built at run time, or
 * `import x = require(…)` below the top level (`loadsAtRunTime`).
 */
export function loadsAFile(source: ts.SourceFile, selfName: string | undefined): boolean {
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
 * A config module parsed with parent nodes set, never run, and whether the
 * parser reported a syntax error.
 */
export function parsedConfig(text: string): { source: ts.SourceFile; parses: boolean } {
  const source = ts.createSourceFile(
    'vitest.config.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  // A config with a syntax error: the parser recovers into a tree no tool loads.
  const parseErrors = (source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics;
  return { source, parses: parseErrors.length === 0 };
}

/**
 * Whether a root config module of any tool may load a module that in the gate
 * is the branch's (`loadsAFile`), or does not parse, so that what it loads is
 * not read. Parsed, never run.
 */
export function configLoadsAFile(text: string, selfName: string | undefined): boolean {
  const { source, parses } = parsedConfig(text);
  return !parses || loadsAFile(source, selfName);
}
