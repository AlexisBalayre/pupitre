import {
  decideMode,
  isCommentOnlyDelta,
  isPartialReview,
  isProseMarkdown,
  newestCleanRecord,
  parseRawDiff,
  parseReviewRequest,
  type RawDiffEntry,
  sameCodeIgnoringComments,
  type PriorRecord,
  porcelainPaths,
} from "@src/preflight.utils";
import { describe, expect, it } from "vitest";

function record(overrides: Partial<PriorRecord> = {}): PriorRecord {
  return {
    path: "records/1.json",
    commit_sha: "aaa",
    timestamp: "2026-08-01T00:00:00.000Z",
    is_error: false,
    partial: false,
    ...overrides,
  };
}

describe("porcelainPaths", () => {
  it("extracts the path from a status entry", () => {
    expect(porcelainPaths(" M src/a.ts\n?? src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("includes both sides of a rename", () => {
    expect(porcelainPaths("R  old.ts -> new.ts")).toEqual(["old.ts", "new.ts"]);
  });

  it("strips the quoting git applies to special characters", () => {
    expect(porcelainPaths('?? "with space.ts"')).toEqual(["with space.ts"]);
  });

  it("yields nothing for a clean tree", () => {
    expect(porcelainPaths("")).toEqual([]);
  });
});

describe("newestCleanRecord", () => {
  it("picks the newest by timestamp", () => {
    const older = record({ path: "records/1.json", timestamp: "2026-08-01T00:00:00.000Z" });
    const newer = record({ path: "records/2.json", timestamp: "2026-08-02T00:00:00.000Z" });
    expect(newestCleanRecord([older, newer])).toBe(newer);
    expect(newestCleanRecord([newer, older])).toBe(newer);
  });

  it("ignores errored records and records without a sha", () => {
    const errored = record({ timestamp: "2026-08-03T00:00:00.000Z", is_error: true });
    const shaless = record({ timestamp: "2026-08-03T00:00:00.000Z", commit_sha: null });
    const clean = record();
    expect(newestCleanRecord([errored, shaless, clean])).toBe(clean);
  });

  it("never takes a partial review as the prior", () => {
    const partial = record({ timestamp: "2026-08-03T00:00:00.000Z", partial: true });
    const complete = record();
    expect(newestCleanRecord([partial, complete])).toBe(complete);
  });

  it("returns null when nothing usable exists", () => {
    expect(newestCleanRecord([record({ is_error: true })])).toBeNull();
    expect(newestCleanRecord([])).toBeNull();
  });
});

describe("decideMode", () => {
  const base = {
    headSha: "bbb",
    trigger: "synchronize",
    forceFull: false,
    isAncestor: true,
    hasMerges: false,
    isCommentOnly: false,
  };

  it("resolves full when the PR has never been reviewed", () => {
    expect(decideMode({ ...base, prior: null })).toEqual({ kind: "full" });
  });

  it("skips a synchronize retrigger of an already-reviewed head", () => {
    expect(decideMode({ ...base, prior: record({ commit_sha: "bbb" }) })).toEqual({
      kind: "skip-duplicate",
      priorPath: "records/1.json",
    });
  });

  it("re-reviews an already-reviewed head when a human asked by comment", () => {
    expect(decideMode({ ...base, prior: record({ commit_sha: "bbb" }), trigger: "comment" })).toEqual({ kind: "full" });
  });

  it("resolves incremental from the prior head on a clean fast-forward", () => {
    expect(decideMode({ ...base, prior: record() })).toEqual({
      kind: "incremental",
      fromSha: "aaa",
      priorPath: "records/1.json",
    });
  });

  it("honors an explicit full request over an eligible delta", () => {
    expect(decideMode({ ...base, prior: record(), forceFull: true })).toEqual({ kind: "full" });
  });

  it("falls back to full when a rebase broke ancestry", () => {
    expect(decideMode({ ...base, prior: record(), isAncestor: false })).toEqual({ kind: "full" });
  });

  it("falls back to full when the delta contains a merge from the base", () => {
    expect(decideMode({ ...base, prior: record(), hasMerges: true })).toEqual({ kind: "full" });
  });

  it("skips a delta of comments and Markdown alone", () => {
    expect(decideMode({ ...base, prior: record(), isCommentOnly: true })).toEqual({
      kind: "skip-comment-only",
      priorPath: "records/1.json",
    });
  });

  it("reviews a comment-only delta when a human asked by comment", () => {
    expect(decideMode({ ...base, prior: record(), isCommentOnly: true, trigger: "comment" })).toEqual({
      kind: "incremental",
      fromSha: "aaa",
      priorPath: "records/1.json",
    });
  });

  it("reviews in full a comment-only delta whose ancestry broke", () => {
    expect(decideMode({ ...base, prior: record(), isCommentOnly: true, isAncestor: false })).toEqual({ kind: "full" });
  });
});

describe("parseRawDiff", () => {
  it("reads modes, blobs, status and a path git would have quoted", () => {
    const raw = `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0src/caf\u00e9 "q".ts\0`;
    expect(parseRawDiff(raw)).toEqual([
      { oldMode: "100644", newMode: "100644", oldBlob: "a".repeat(40), newBlob: "b".repeat(40), status: "M", path: 'src/caf\u00e9 "q".ts' },
    ]);
  });

  it("refuses an entry it cannot read rather than skip it", () => {
    expect(() => parseRawDiff("garbage\0path\0")).toThrow("unparseable");
  });
});

describe("isProseMarkdown", () => {
  it.each(["README.md", "CHANGELOG.md", "CONTRIBUTING.md"])("takes %s as prose", (path) => {
    expect(isProseMarkdown(path)).toBe(true);
  });

  it.each([
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/agents/review-correctness.md",
    ".claude/skills/pr-ci-review/SKILL.md",
    "skills/pup/LOOP.md",
    "docs/conventions/general.md",
    ".github/pull_request_template.md",
    "tools/review/README.md",
    "docs/page.mdx",
    "docs/09-decisions.md",
    "docs/08-roadmap.md",
    "docs/03-profiles.md",
    "CLAUDE.local.md",
    "tools/x/notes.md",
    "pkg/.claude/agents/x.md",
    "Skills/pup/LOOP.md",
  ])("does not take %s as prose", (path) => {
    expect(isProseMarkdown(path)).toBe(false);
  });
});

describe("sameCodeIgnoringComments", () => {
  const same = (before: string, after: string, path = "src/a.ts") => sameCodeIgnoringComments(path, before, after);

  it("accepts a changed line comment, JSDoc and blank lines", () => {
    expect(same("// old why\nconst x = 1;\n", "// new why\n\n/** doc */\nconst x = 1;\n")).toBe(true);
  });

  it("refuses comment delimiters that comment code out or back in", () => {
    expect(same("if (!admin) throw new Error();\n", "/*\nif (!admin) throw new Error();\n*/\n")).toBe(false);
    expect(same("/*\nrun();\n*/\n", "run();\n")).toBe(false);
  });

  it("refuses code after a comment on the same line", () => {
    expect(same("const ok = false;\n", "/* ok */ const ok = true;\n")).toBe(false);
  });

  it("refuses a line comment that a U+2028 or a lone CR ends early", () => {
    expect(same("// note\n", "// note\u2028run();\n")).toBe(false);
    expect(same("// note\n", "// note\rrun();\n")).toBe(false);
  });

  it("refuses a // inside a string or a regex", () => {
    expect(same("const u = `a`;\n", "const u = `a // b`;\n")).toBe(false);
    expect(same("const r = /[a]/;\n", "const r = /[a//]/;\n")).toBe(false);
  });

  it("refuses a changed pragma comment", () => {
    expect(same("run();\n", "// @ts-ignore\nrun();\n")).toBe(false);
    expect(same("run();\n", "/* v8 ignore next */\nrun();\n")).toBe(false);
    expect(same("run();\n", "/// <reference path=\"x.d.ts\" />\nrun();\n")).toBe(false);
  });

  it("refuses a pragma moved onto other code, or put after a lone CR", () => {
    // Same line-break state, other code after it.
    expect(same("a();\n/* v8 ignore next */\nb();\nc();\n", "a();\nb();\n/* v8 ignore next */\nc();\n")).toBe(false);
    // Same code after it, moved from trailing to its own line.
    expect(same("risky(); /* v8 ignore next */\nsafe();\n", "risky();\n/* v8 ignore next */\nsafe();\n")).toBe(false);
    expect(same("const a = 1; // c\n", "const a = 1; // c\r// @ts-ignore\n")).toBe(false);
  });

  it("refuses a pragma added after code on the same line", () => {
    expect(same("a();\nb();\n", "a(); // @ts-ignore\nb();\n")).toBe(false);
    expect(same("const a = c ? x() : y();\n", "const a = c ? /* v8 ignore next */ x() : y();\n")).toBe(false);
    expect(same("const x = f();\n", "const x = /* @__PURE__ */ f();\n")).toBe(false);
    expect(same("log(x);\n", "log(x); // eslint-disable-line no-console\n")).toBe(false);
  });

  it("refuses the coverage spellings the tools accept beyond the plain one", () => {
    expect(same("run();\n", "/* v8\tignore next */\nrun();\n")).toBe(false);
    expect(same("run();\n", "/* node:coverage ignore next */\nrun();\n")).toBe(false);
  });

  it("refuses an escaped directive the printer would otherwise normalise", () => {
    expect(same("'use strict';\nx = 1;\n", "'use\\x20strict';\nx = 1;\n", "src/a.cjs")).toBe(false);
  });

  it("accepts an unchanged pragma beside an edited comment", () => {
    expect(same("// old\n// biome-ignore lint: why\nrun();\n", "// new\n// biome-ignore lint: why\nrun();\n")).toBe(true);
  });

  it("sees a pragma after a template substitution, a regex or JSX text", () => {
    const tail = "\nrun();\nconst t = `t`;\n";
    expect(same("const u = `${b}/x`;" + tail, "const u = `${b}/x`;\n/* v8 ignore next */" + tail)).toBe(false);
    expect(same("const r = /'/;" + tail, "const r = /'/;\n// @ts-ignore" + tail)).toBe(false);
    expect(same("const r = /`/;" + tail, "const r = /`/;\n// biome-ignore lint: x" + tail)).toBe(false);
    const jsx = (pragma: string) => `const e = <p>it's</p>;\n${pragma}run();\n`;
    expect(same(jsx(""), jsx("// @ts-ignore\n"), "src/a.tsx")).toBe(false);
  });

  it("accepts a JSDoc tag added above code that a pragma follows", () => {
    const code = "function f(x) {}\n// @ts-ignore\nrun();\n";
    expect(same(`/** a */\n${code}`, `/** @param x the x */\n${code}`, "src/a.js")).toBe(true);
  });

  it("refuses a changed shebang", () => {
    expect(same("#!/usr/bin/env node\nrun();\n", "#!/usr/bin/env bash\nrun();\n", "src/a.js")).toBe(false);
  });

  it("refuses a version that does not parse", () => {
    expect(same("run();\n", "run(;\n// note\n")).toBe(false);
  });
});

describe("isCommentOnlyDelta", () => {
  const blobs: Record<string, string> = { a: "// old\nrun();\n", b: "// new\nrun();\n", c: "stop();\n" };
  const entry = (overrides: Partial<RawDiffEntry> = {}): RawDiffEntry => ({
    oldMode: "100644",
    newMode: "100644",
    oldBlob: "a",
    newBlob: "b",
    status: "M",
    path: "src/a.ts",
    ...overrides,
  });
  const delta = (...entries: RawDiffEntry[]) => isCommentOnlyDelta(entries, (sha) => blobs[sha] ?? "");

  it("accepts comment edits in code and edits to prose Markdown", () => {
    expect(delta(entry(), entry({ path: "README.md", newBlob: "c" }))).toBe(true);
  });

  it("refuses a code change anywhere in the delta", () => {
    expect(delta(entry(), entry({ path: "src/b.ts", newBlob: "c" }))).toBe(false);
  });

  it("refuses new, deleted and mode-changed files, symlinks and submodules", () => {
    expect(delta(entry({ status: "A", oldMode: "000000" }))).toBe(false);
    expect(delta(entry({ path: "docs/a.md", status: "D", newMode: "000000" }))).toBe(false);
    expect(delta(entry({ newMode: "100755" }))).toBe(false);
    expect(delta(entry({ path: "docs/link.md", oldMode: "120000", newMode: "120000" }))).toBe(false);
    expect(delta(entry({ path: "vendor/x.md", oldMode: "160000", newMode: "160000" }))).toBe(false);
  });

  it("refuses config Markdown and files it cannot judge", () => {
    expect(delta(entry({ path: ".claude/skills/pr-ci-review/SKILL.md" }))).toBe(false);
    expect(delta(entry({ path: "scripts/pre-commit.sh" }))).toBe(false);
    expect(delta(entry({ path: ".github/workflows/r.yml" }))).toBe(false);
  });

  it("refuses an empty delta", () => {
    expect(delta()).toBe(false);
  });
});

describe("isPartialReview", () => {
  it("counts a quick review as partial", () => {
    expect(isPartialReview("quick", [])).toBe(true);
  });

  it("counts a review restricted to named areas as partial", () => {
    expect(isPartialReview("deep", ["security"])).toBe(true);
  });

  it("counts a standard or deep review of the gated areas as complete", () => {
    expect(isPartialReview("standard", [])).toBe(false);
    expect(isPartialReview("deep", [])).toBe(false);
  });

  it("reads a record from before the request fields as complete", () => {
    expect(isPartialReview(undefined, undefined)).toBe(false);
  });
});

describe("parseReviewRequest", () => {
  const standard = { full: false, depth: "standard", areas: [] };

  it.each([
    ["asks for a standard review of the gated areas by default", "@claude review", standard],
    [
      "reads full, a depth, and areas in any order",
      "@claude review security deep full docs",
      { full: true, depth: "deep", areas: ["security", "docs"] },
    ],
    ["ignores case", "@Claude Review Quick Correctness", { ...standard, depth: "quick", areas: ["correctness"] }],
    [
      "splits words on commas",
      "@claude review correctness,security",
      { ...standard, areas: ["correctness", "security"] },
    ],
    ["reads a keyword before a full stop", "@claude review full.", { ...standard, full: true }],
    ["reads a keyword in a code span", "`@claude review full`", { ...standard, full: true }],
    ["reads a keyword in bold", "**@claude review deep**", { ...standard, depth: "deep" }],
    ["reads a keyword after a colon", "@claude review: quick", { ...standard, depth: "quick" }],
    ["stops at the first word that is not a keyword", "@claude review, thanks for the security fix", standard],
    ["keeps a hyphenated word whole", "@claude review security-related changes", standard],
    ["takes spec as prose, not an area", "@claude review spec", standard],
    ["reads only the trigger's own line", "@claude review\nsecurity looks fine to me", standard],
    [
      "skips a trigger quoted from an earlier comment",
      "> @claude review security\n\n@claude review deep",
      { ...standard, depth: "deep" },
    ],
  ])("%s", (_label, comment, expected) => {
    expect(parseReviewRequest(comment)).toEqual(expected);
  });
});
