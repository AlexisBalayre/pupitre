import ts from "typescript";

/**
 * Pure logic behind the review preflight. Head freshness,
 * tree cleanliness, and the full/incremental mode choice are arithmetic over
 * git facts, so they run as a deterministic CI step before the model starts
 * instead of as model turns that could stall on a permission prompt and exit
 * green over an unreviewed diff.
 */

/** A review-metrics record as the preflight reads it off `ci/review-metrics`. */
export interface PriorRecord {
  /** Branch-relative path, e.g. `records/123.json`; what the model `git show`s. */
  path: string;
  commit_sha: string | null;
  timestamp: string;
  is_error: boolean;
}

/** Working-tree paths from `git status --porcelain`, rename targets included. */
export function porcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    for (const path of line.slice(3).split(" -> ")) {
      paths.push(path.replace(/^"|"$/g, ""));
    }
  }
  return paths;
}

/** The newest non-errored record, or null when the PR has never been reviewed. */
export function newestCleanRecord(records: PriorRecord[]): PriorRecord | null {
  let newest: PriorRecord | null = null;
  for (const record of records) {
    if (record.is_error || record.commit_sha === null) continue;
    if (newest === null || record.timestamp > newest.timestamp) newest = record;
  }
  return newest;
}

/** One file of `git diff --raw -z --no-abbrev --no-renames`. */
export interface RawDiffEntry {
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
  status: string;
  path: string;
}

/** NUL-separated, so no path is quoted or split, whatever bytes it holds. */
export function parseRawDiff(raw: string): RawDiffEntry[] {
  const fields = raw.split("\0");
  const entries: RawDiffEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(fields[i] ?? "");
    if (!meta) throw new Error(`unparseable raw diff entry: ${JSON.stringify(fields[i])}`);
    entries.push({
      oldMode: meta[1] ?? "",
      newMode: meta[2] ?? "",
      oldBlob: meta[3] ?? "",
      newBlob: meta[4] ?? "",
      status: meta[5] ?? "",
      path: fields[i + 1] ?? "",
    });
  }
  return entries;
}

/**
 * Markdown nobody loads as instructions, as an allowlist: agent config here is
 * Markdown too (`CLAUDE.md`, skills, agent manifests, rules and the
 * conventions they import), and the reviewers read `docs/09-decisions.md` as
 * the accepted exposures, so only the design chapters and repo meta qualify.
 */
export function isProseMarkdown(path: string): boolean {
  return /^(README|CONTRIBUTING|CHANGELOG)\.md$/.test(path) || /^docs\/0[0-8]-[^/]+\.md$/.test(path);
}

const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/**
 * Comments that change what the toolchain does. The coverage spellings are
 * the ones `ast-v8-to-istanbul` matches, so a tab or a `node:coverage` prefix
 * is caught too.
 */
const PRAGMA =
  /(?:istanbul|[cv]8|node:coverage)\s+ignore|@ts-|biome-ignore|eslint|[#@]__PURE__|__NO_SIDE_EFFECTS__|@jsx|@vite-ignore|webpack[A-Z]|[#@]\s*source(?:Mapping)?URL|^\/\/\/\s*<|@vitest|@license|@preserve/i;

/**
 * Each pragma with where it sits: the count of code tokens before it, and
 * whether a line break separates it from the last one. The scanner breaks
 * lines where TypeScript does (CR, U+2028), and a pragma moved onto other code
 * changes its count, so a moved `v8 ignore next` reads as a change.
 */
function pragmaAnchors(path: string, text: string): string[] {
  const variant = /x$/i.test(path) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant, text);
  const anchors: string[] = [];
  let codeTokens = 0;
  let lineBreak = false;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.NewLineTrivia) {
      lineBreak = true;
    } else if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia ||
      kind === ts.SyntaxKind.ShebangTrivia
    ) {
      const comment = scanner.getTokenText();
      if (kind === ts.SyntaxKind.ShebangTrivia || PRAGMA.test(comment)) {
        anchors.push(`${codeTokens}:${lineBreak}:${comment}`);
      }
    } else if (kind !== ts.SyntaxKind.WhitespaceTrivia) {
      codeTokens += 1;
      lineBreak = false;
    }
  }
  return anchors;
}

/**
 * Whether two versions of a script differ only in comments: both parse
 * cleanly, print identically with comments removed, and carry the same
 * pragmas in the same places. The parser, not a regex, decides where a comment
 * ends, so a delimiter that comments code out, a `//` inside a string or a
 * regex, and a U+2028 or lone CR that ends a line comment early all show up as
 * a code change.
 */
export function sameCodeIgnoringComments(path: string, before: string, after: string): boolean {
  const printer = ts.createPrinter({ removeComments: true });
  const print = (text: string): string | null => {
    // With parent nodes the printer keeps each literal's source text, so an
    // escaped `'use\\x20strict'` does not print as the directive it is not.
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const { diagnostics } = ts.transpileModule(text, { fileName: path, reportDiagnostics: true });
    if ((diagnostics ?? []).length > 0) return null;
    return printer.printFile(file);
  };
  const printedBefore = print(before);
  const printedAfter = print(after);
  if (printedBefore === null || printedAfter === null || printedBefore !== printedAfter) return false;
  return JSON.stringify(pragmaAnchors(path, before)) === JSON.stringify(pragmaAnchors(path, after));
}

/**
 * Whether a delta touches nothing but prose: every entry a modified regular
 * file, each either prose Markdown or a script whose code is unchanged. A new,
 * deleted or renamed file, a mode change, a symlink, a submodule and any other
 * file type are never prose, so they are always reviewed.
 */
export function isCommentOnlyDelta(entries: RawDiffEntry[], readBlob: (sha: string) => string): boolean {
  if (entries.length === 0) return false;
  return entries.every((entry) => {
    if (entry.oldMode !== "100644" || entry.newMode !== "100644") return false;
    if (isProseMarkdown(entry.path)) return true;
    if (!CODE_FILE.test(entry.path)) return false;
    return sameCodeIgnoringComments(entry.path, readBlob(entry.oldBlob), readBlob(entry.newBlob));
  });
}

export type ModeDecision =
  | { kind: "skip-duplicate"; priorPath: string }
  | { kind: "skip-comment-only"; priorPath: string }
  | { kind: "full" }
  | { kind: "incremental"; fromSha: string; priorPath: string };

export function decideMode(args: {
  prior: PriorRecord | null;
  headSha: string;
  trigger: string;
  forceFull: boolean;
  isAncestor: boolean;
  hasMerges: boolean;
  commentOnly: boolean;
}): ModeDecision {
  const { prior, headSha, trigger, forceFull, isAncestor, hasMerges, commentOnly } = args;
  if (prior === null || prior.commit_sha === null) return { kind: "full" };
  // An already-reviewed head re-reviews only on an explicit human request: a
  // synchronize or opened retrigger of the same SHA has nothing new to look at,
  // while a comment is a person asking again on purpose.
  if (prior.commit_sha === headSha) {
    return trigger === "comment" ? { kind: "full" } : { kind: "skip-duplicate", priorPath: prior.path };
  }
  if (forceFull) return { kind: "full" };
  // A rebase or force-push breaks ancestry, and a merge from the base folds
  // upstream code into the delta; neither leaves a delta that is this PR's own
  // change to review.
  if (!isAncestor || hasMerges) return { kind: "full" };
  // A delta of comments and prose alone waits for the next code push, whose
  // incremental review starts from the same prior head and so still reads it;
  // a person asking by comment gets the review now.
  if (commentOnly && trigger !== "comment") return { kind: "skip-comment-only", priorPath: prior.path };
  return { kind: "incremental", fromSha: prior.commit_sha, priorPath: prior.path };
}
