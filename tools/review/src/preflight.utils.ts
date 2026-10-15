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
 * Markdown nobody loads as instructions, as an allowlist of the root's repo
 * meta. Everything else may steer an agent: `CLAUDE.md`, skills, manifests and
 * rules directly, and the design docs as the spec and stack decisions
 * `AGENTS.md` and the reviewers send sessions to.
 */
export function isProseMarkdown(path: string): boolean {
  return /^(README|CONTRIBUTING|CHANGELOG)\.md$/.test(path);
}

const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/**
 * Comments that change what the toolchain does. The coverage spellings are
 * the ones `ast-v8-to-istanbul` matches, so a tab or a `node:coverage` prefix
 * is caught too.
 */
const PRAGMA =
  /(?:istanbul|[cv]8|node:coverage)\s+ignore|@ts-|biome-ignore|eslint|[#@]__PURE__|__NO_SIDE_EFFECTS__|@jsx|@vite-ignore|webpack[A-Z]|[#@]\s*source(?:Mapping)?URL|^\/\/\/\s*<|@vitest|@jest-environment|@flow|@refresh|@license|@preserve/i;

/**
 * Each pragma with where it sits: the index of the code token it precedes,
 * and whether a line break separates it from the token before. A comment on
 * the same line as the token before is that token's trailing comment, so both
 * ranges are read: together they split the trivia at its first line break. Comments come
 * from the parsed tree, whose tokens know template parts, regexes and JSX
 * text, so no backtick or slash hides a comment; a pragma moved onto other
 * code changes its index, so a moved `v8 ignore next` reads as a change.
 */
function pragmaAnchors(file: ts.SourceFile): [number, boolean, string][] {
  const { text } = file;
  const anchors: [number, boolean, string][] = [];
  let tokenIndex = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isJSDoc(node)) return;
    if (node.kind > ts.SyntaxKind.LastToken) {
      for (const child of node.getChildren(file)) visit(child);
      return;
    }
    const trailing = ts.getTrailingCommentRanges(text, node.pos) ?? [];
    for (const range of [...trailing, ...(ts.getLeadingCommentRanges(text, node.pos) ?? [])]) {
      const comment = text.slice(range.pos, range.end);
      if (!PRAGMA.test(comment)) continue;
      const hasLineBreak = /[\n\r\u2028\u2029]/.test(text.slice(node.pos, range.pos));
      anchors.push([tokenIndex, hasLineBreak, comment]);
    }
    tokenIndex += 1;
  };
  visit(file);
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
  const fingerprint = (text: string): string | null => {
    // With parent nodes the printer keeps each literal's source text, so an
    // escaped `'use\x20strict'` does not print as the directive it is not.
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const { diagnostics } = ts.transpileModule(text, { fileName: path, reportDiagnostics: true });
    if ((diagnostics ?? []).length > 0) return null;
    return JSON.stringify([printer.printFile(file), pragmaAnchors(file)]);
  };
  const beforePrint = fingerprint(before);
  return beforePrint !== null && beforePrint === fingerprint(after);
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
  isCommentOnly: boolean;
}): ModeDecision {
  const { prior, headSha, trigger, forceFull, isAncestor, hasMerges, isCommentOnly } = args;
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
  if (isCommentOnly && trigger !== "comment") return { kind: "skip-comment-only", priorPath: prior.path };
  return { kind: "incremental", fromSha: prior.commit_sha, priorPath: prior.path };
}
