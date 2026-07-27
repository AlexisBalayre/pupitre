import ts from 'typescript';
import type { DeadExport, DuplicateBlock, DuplicationReport } from './types/adapter.types.js';
import { DUPLICATION_WINDOW_LINES } from './typescript-debt.constants.js';
import { resolveImport } from './typescript-source.utils.js';

function parse(file: string, content: string): ts.SourceFile {
  const kind =
    file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false, kind);
}

function exportKey(file: string, name: string): string {
  return `${file}\u0000${name}`;
}

interface UsageMarks {
  /** `file\0exportName` pairs imported somewhere in the repo. */
  used: Set<string>;
  /** Files whose whole export surface counts as used (namespace import, `export *`, side-effect import). */
  fullyUsed: Set<string>;
}

function collectUsage(
  file: string,
  source: ts.SourceFile,
  fileSet: Set<string>,
  marks: UsageMarks,
): void {
  for (const statement of source.statements) {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      specifier = statement.moduleSpecifier;
    }
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
    const resolved = resolveImport(file, specifier.text, fileSet);
    if (!resolved) continue;

    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) {
        marks.fullyUsed.add(resolved);
        continue;
      }
      if (clause.name) marks.used.add(exportKey(resolved, 'default'));
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          marks.fullyUsed.add(resolved);
        } else {
          for (const element of clause.namedBindings.elements) {
            marks.used.add(exportKey(resolved, (element.propertyName ?? element.name).text));
          }
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          marks.used.add(exportKey(resolved, (element.propertyName ?? element.name).text));
        }
      } else {
        marks.fullyUsed.add(resolved);
      }
    }
  }
}

function exportedNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.push(element.name.text);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      names.push('default');
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      names.push('default');
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      if (statement.name && ts.isIdentifier(statement.name)) names.push(statement.name.text);
    }
  }
  return names;
}

/**
 * Exports no other file imports. Test files never contribute dead exports
 * (vitest is their consumer) but their imports still count as usage; entry
 * files (package.json main/bin/exports) are excluded the same way. Dynamic
 * `import()` is not tracked — baseline-relative gating absorbs the noise.
 */
export function findDeadExports(
  files: Record<string, string>,
  entryFiles: Set<string>,
): DeadExport[] {
  const fileSet = new Set(Object.keys(files));
  const marks: UsageMarks = { used: new Set(), fullyUsed: new Set() };
  const exportsByFile = new Map<string, string[]>();
  for (const file of [...fileSet].sort()) {
    const source = parse(file, files[file] as string);
    collectUsage(file, source, fileSet, marks);
    if (!entryFiles.has(file) && !file.includes('.test.')) {
      exportsByFile.set(file, exportedNames(source));
    }
  }
  const dead: DeadExport[] = [];
  for (const [file, names] of exportsByFile) {
    if (marks.fullyUsed.has(file)) continue;
    for (const name of names) {
      if (!marks.used.has(exportKey(file, name))) dead.push({ file, exportName: name });
    }
  }
  return dead;
}

interface NormalizedLine {
  text: string;
  /** 1-based line number in the original file. */
  line: number;
}

/** Last line of an import statement: `… from '<spec>';` or a bare `import '<spec>';`. */
const IMPORT_TERMINATOR = /(\bfrom\s+|^import\s+)['"][^'"]*['"]\s*;?$/;

/**
 * Trimmed lines minus blanks, lone punctuation, comment lines, and import
 * statements.
 *
 * Imports are dropped because a member list is not collapsible: two files that
 * import the same seven types from `adapter.types.js` are reusing a contract,
 * which is the intended design, yet a line-window scan reads the shared list as a
 * clone. Counting it made the ratchet flag a PR for doing the right thing, and
 * `--accept-debt` was the author's only available response.
 *
 * Line-based, like the rest of this scan: a dynamic `import(...)` call is
 * excluded by hand, and an `import` inside a template literal is skipped as if it
 * were real. Both are acceptable — the fixture case is still an import line.
 */
function normalizeLines(content: string): NormalizedLine[] {
  const lines: NormalizedLine[] = [];
  let inImport = false;
  content.split('\n').forEach((raw, index) => {
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')) return;

    if (inImport) {
      if (IMPORT_TERMINATOR.test(text)) inImport = false;
      return;
    }
    if (/^import\b/.test(text) && !/^import\s*\(/.test(text)) {
      inImport = !IMPORT_TERMINATOR.test(text);
      return;
    }

    if (/^[{}()[\]:;,]+$/.test(text)) return;
    lines.push({ text, line: index + 1 });
  });
  return lines;
}

/**
 * Sliding-window clone detection over normalized lines (the jscpd-equivalent
 * docs/06 allows). The metric counts each duplicated normalized line once, so
 * overlapping windows over one long clone don't inflate it.
 */
export function findDuplication(files: Record<string, string>): DuplicationReport {
  const windows = new Map<string, { file: string; line: number; index: number }[]>();
  for (const file of Object.keys(files).sort()) {
    const lines = normalizeLines(files[file] as string);
    for (let i = 0; i + DUPLICATION_WINDOW_LINES <= lines.length; i++) {
      const key = lines
        .slice(i, i + DUPLICATION_WINDOW_LINES)
        .map((l) => l.text)
        .join('\n');
      const occurrences = windows.get(key) ?? [];
      occurrences.push({ file, line: (lines[i] as NormalizedLine).line, index: i });
      windows.set(key, occurrences);
    }
  }
  const duplicated = new Set<string>();
  const blocks: DuplicateBlock[] = [];
  for (const occurrences of windows.values()) {
    if (occurrences.length < 2) continue;
    blocks.push({ locations: occurrences.map(({ file, line }) => ({ file, line })) });
    for (const { file, index } of occurrences) {
      for (let offset = 0; offset < DUPLICATION_WINDOW_LINES; offset++) {
        duplicated.add(`${file}\u0000${index + offset}`);
      }
    }
  }
  return { duplicatedLines: duplicated.size, blocks };
}

const COMPLEXITY_NODE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);

const COMPLEXITY_OPERATOR_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/** Decision points in one file — the gate compares deltas, so the absolute scale is free. */
export function measureComplexity(file: string, content: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (COMPLEXITY_NODE_KINDS.has(node.kind)) {
      count++;
    } else if (
      ts.isBinaryExpression(node) &&
      COMPLEXITY_OPERATOR_KINDS.has(node.operatorToken.kind)
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, content));
  return count;
}
