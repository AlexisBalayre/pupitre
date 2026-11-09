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

function inlineParser(): (body: string) => number {
  const start = workflow.search(/^ *function unthreadedImportants\(body\) \{$/m);
  if (start === -1) throw new Error("pr-status.yml has no inline unthreadedImportants");
  const indent = /^ */.exec(workflow.slice(start))?.[0] ?? "";
  const end = workflow.indexOf(`\n${indent}}\n`, start);
  return new Function(`${workflow.slice(start, end + indent.length + 2)}\nreturn unthreadedImportants;`)();
}

const unthreadedImportants = inlineParser();

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
});

describe("pr-status.yml's summary review", () => {
  it("is the one whose body opens with the poster's heading", () => {
    expect(workflow).toContain(`const REVIEW_HEADING = ${JSON.stringify(REVIEW_HEADING)};`);
  });
});
