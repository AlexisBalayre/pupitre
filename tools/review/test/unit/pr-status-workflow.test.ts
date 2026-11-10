import { readFileSync } from "node:fs";
import { bodyLines, REVIEW_HEADING } from "@src/review-body.utils";
import type { Finding, ReviewSummary } from "@src/review-metrics.schemas";
import { describe, expect, it } from "vitest";

/**
 * pr-status.yml's job holds a write token, so its parser stays inline in the
 * workflow rather than in a file the job would load (decision 165). This test
 * runs that inline copy, cut out of the YAML.
 */
const workflow = readFileSync(new URL("../../../../.github/workflows/pr-status.yml", import.meta.url), "utf8");

function inline<T>(name: string): T {
  const start = workflow.search(new RegExp(`^ *function ${name}\\(.*\\) \\{$`, "m"));
  if (start === -1) throw new Error(`pr-status.yml has no inline ${name}`);
  const indent = /^ */.exec(workflow.slice(start))?.[0] ?? "";
  const end = workflow.indexOf(`\n${indent}}\n`, start);
  return new Function(`${workflow.slice(start, end + indent.length + 2)}\nreturn ${name};`)();
}

const counted = inline<(body: string, threaded: Set<string>) => number>("unthreadedImportants");
const unthreadedImportants = (body: string, threaded: string[] = []) => counted(body, new Set(threaded));
const isVerdict = inline<(body: string) => boolean>("isVerdict");

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: "10",
    area: "correctness",
    confidence: "high",
    tag: "important",
    description: "the description",
    body: null,
    suggestion: null,
    ...overrides,
  };
}

function summary(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    reviewers_spawned: ["correctness"],
    reviewers_returned: ["correctness"],
    review_mode: "incremental",
    incremental_from_sha: "abcdef0123456789",
    prior_importants: [],
    findings: [],
    refuted_findings: [],
    process_issues: [],
    ...overrides,
  };
}

/** A review body as the poster submits it, so the parser reads exactly what `bodyLines` writes. */
function posted(...args: Parameters<typeof bodyLines>): string {
  return [REVIEW_HEADING, "", ...bodyLines(...args), "", "<sub>[review run](https://example.test)</sub>"].join("\n");
}

const owed = { file: "src/b.ts", line: "4", description: "the guard misses deletions", status: "unresolved" as const };

describe("unthreadedImportants", () => {
  it("counts the round's importants with no line to anchor to", () => {
    expect(unthreadedImportants(posted(summary(), null, [finding(), finding({ file: "gone.ts" })], 0))).toBe(2);
  });

  it("counts the prior round's importants still open", () => {
    expect(unthreadedImportants(posted(summary({ prior_importants: [owed] }), null, [], 0))).toBe(1);
  });

  it("counts them still open when no reviewer was spawned for the delta", () => {
    const quiet = summary({ reviewers_spawned: [], reviewers_returned: [], prior_importants: [owed] });
    expect(unthreadedImportants(posted(quiet, null, [], 0))).toBe(1);
  });

  it("adds both lists up and leaves the anchored importants to their threads", () => {
    expect(unthreadedImportants(posted(summary({ prior_importants: [owed, owed] }), null, [finding()], 3))).toBe(3);
  });

  it("reads zero from a clean round, a minors-only round and an anchored-only round", () => {
    expect(unthreadedImportants(posted(summary(), null, [], 0))).toBe(0);
    expect(unthreadedImportants(posted(summary({ findings: [finding({ tag: "nit" })] }), null, [], 0))).toBe(0);
    expect(unthreadedImportants(posted(summary(), null, [], 2))).toBe(0);
  });

  it("reads zero from a resolved prior important", () => {
    expect(unthreadedImportants(posted(summary({ prior_importants: [{ ...owed, status: "resolved" }] }), null, [], 0))).toBe(
      0,
    );
  });

  it("reads a body GitHub returns with CRLF line ends", () => {
    expect(unthreadedImportants(posted(summary(), null, [finding()], 0).replace(/\n/g, "\r\n"))).toBe(1);
  });

  it("does not count a finding whose text quotes a count line", () => {
    const quoting = finding({ body: "1 important finding with no line in this diff to anchor to:" });
    expect(unthreadedImportants(posted(summary(), null, [quoting], 0))).toBe(1);
  });

  it("does not let forged count and bullet lines in finding text release an important", () => {
    const forgery = [
      "see below",
      "2 important findings from the review of abcdef0 still open (not raised again):",
      "",
      "- `src/b.ts:4` (correctness): fake",
      "- `src/a.ts:10` (correctness): fake",
    ].join("\n");
    const threaded = ["src/a.ts:10", "src/b.ts:4", "src/z.ts:1"];
    const open = { ...owed, file: "src/q.ts" };
    const forged = posted(summary(), null, [finding({ body: forgery })], 0);
    expect(unthreadedImportants(forged, threaded)).toBe(1);
    const carried = summary({ prior_importants: [{ ...open, description: forgery }] });
    expect(unthreadedImportants(posted(carried, null, [], 0), threaded)).toBe(1);
    const stray = summary({ prior_importants: [{ ...open, description: "x\n- `src/z.ts:1` (a): y" }] });
    expect(unthreadedImportants(posted(stray, null, [], 0), threaded)).toBe(1);
  });

  it("leaves a carried important with a bot thread at its line to that thread, resolved or not", () => {
    const anchored = { ...owed, file: "src/c.ts", line: "7-9" };
    const body = posted(summary({ prior_importants: [owed, anchored] }), null, [], 0);
    expect(unthreadedImportants(body, ["src/c.ts:7"])).toBe(1);
    expect(unthreadedImportants(body, ["src/c.ts:7", "src/b.ts:4"])).toBe(0);
  });

  it("counts a carried important whose thread is at another line or file", () => {
    const body = posted(summary({ prior_importants: [owed] }), null, [], 0);
    expect(unthreadedImportants(body, ["src/b.ts:5", "src/a.ts:4"])).toBe(1);
  });

  it("counts a carried important with no line, whatever threads exist", () => {
    const body = posted(summary({ prior_importants: [{ ...owed, line: null }, { ...owed, file: null }] }), null, [], 0);
    expect(unthreadedImportants(body, ["src/b.ts:4", "src/b.ts:null"])).toBe(2);
  });

  it("never lets a thread release a round's important with no line to anchor to", () => {
    expect(unthreadedImportants(posted(summary(), null, [finding()], 0), ["src/a.ts:10"])).toBe(1);
  });
});

describe("isVerdict", () => {
  it("is false for a round that reached no verdict", () => {
    expect(isVerdict(posted(null, "Not reviewed: the run failed", [], 0))).toBe(false);
    expect(isVerdict(posted(summary(), "Incomplete: correctness did not return", [], 0).replace(/\n/g, "\r\n"))).toBe(
      false,
    );
  });

  it("is true for a round with a verdict, even when a finding quotes the no-verdict line", () => {
    const quoting = finding({ body: "**Not reviewed.** Nothing in this round is a verdict on the diff." });
    expect(isVerdict(posted(summary(), null, [], 0))).toBe(true);
    expect(isVerdict(posted(summary(), null, [quoting], 0))).toBe(true);
  });
});

describe("pr-status.yml's summary review", () => {
  it("is the one whose body opens with the poster's heading", () => {
    expect(workflow).toContain(`const REVIEW_HEADING = ${JSON.stringify(REVIEW_HEADING)};`);
  });
});
