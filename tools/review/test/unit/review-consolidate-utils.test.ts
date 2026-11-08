import { consolidateFindings, consolidateSummary } from "@src/review-consolidate.utils";
import type { Finding, ReviewSummary } from "@src/review-metrics.schemas";
import { describe, expect, it } from "vitest";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: "10",
    area: "correctness",
    confidence: "high",
    tag: "important",
    description: "the retry loop never stops when the budget is zero",
    body: "body",
    suggestion: null,
    ...overrides,
  };
}

describe("consolidateFindings", () => {
  it("merges the same important raised twice on one line", () => {
    const result = consolidateFindings([finding(), finding({ area: "context" })]);
    expect(result.findings).toHaveLength(1);
    expect(result.merged).toBe(1);
  });

  it("merges the same minor raised twice on nearby lines", () => {
    const nit = (line: string) => finding({ tag: "nit", line });
    expect(consolidateFindings([nit("10"), nit("12")]).findings).toHaveLength(1);
  });

  it("keeps identical importants on different lines apart", () => {
    expect(consolidateFindings([finding(), finding({ line: "12" })]).findings).toHaveLength(2);
  });

  it("credits the most specific area on the survivor", () => {
    const result = consolidateFindings([finding({ area: "docs" }), finding({ area: "security" })]);
    expect(result.findings[0]?.area).toBe("security");
  });

  it("keeps the most severe tag and its own description", () => {
    const nit = finding({ tag: "nit", body: null, description: "the retry loop never stops when the budget is zero!" });
    const result = consolidateFindings([nit, finding()]);
    expect(result.findings).toEqual([expect.objectContaining({ tag: "important", body: "body" })]);
  });

  it("keeps findings on distant lines apart", () => {
    expect(consolidateFindings([finding(), finding({ line: "80" })]).findings).toHaveLength(2);
  });

  it("keeps findings in different files apart", () => {
    expect(consolidateFindings([finding(), finding({ file: "src/b.ts" })]).findings).toHaveLength(2);
  });

  it("keeps different concerns on one line apart", () => {
    const other = finding({ description: "token is logged in plain text" });
    expect(consolidateFindings([finding(), other]).findings).toHaveLength(2);
  });

  it("keeps two importants one substituted word apart as two findings", () => {
    const fails = finding({ description: "retries is never reset when the request fails" });
    const succeeds = finding({ description: "retries is never reset when the request succeeds" });
    expect(consolidateFindings([fails, succeeds]).findings).toHaveLength(2);
  });

  it("keeps two importants that differ only in a short token as two findings", () => {
    const id = finding({ description: "id is not validated before the query" });
    const ip = finding({ description: "ip is not validated before the query" });
    expect(consolidateFindings([id, ip]).findings).toHaveLength(2);
  });

  it("keeps two importants with the same words in opposite order as two findings", () => {
    const a = finding({ description: "retries is checked before budget is decremented" });
    const b = finding({ description: "budget is checked before retries is decremented" });
    expect(consolidateFindings([a, b]).findings).toHaveLength(2);
  });

  it("still folds a nit one word apart into the important", () => {
    const nit = finding({ tag: "nit", description: "the retry loop never stops when the budget is zero today" });
    expect(consolidateFindings([finding(), nit]).findings).toHaveLength(1);
  });

  it("does not chain a cluster past the line limit, whatever the input order", () => {
    const at = (line: string) => finding({ tag: "nit", line });
    expect(consolidateFindings([at("10"), at("13"), at("16")]).findings).toHaveLength(2);
    expect(consolidateFindings([at("10"), at("16"), at("13")]).findings).toHaveLength(2);
  });

  it("treats a line-less finding as near only another line-less one", () => {
    const nit = (line: string | null) => finding({ tag: "nit", line });
    expect(consolidateFindings([nit(null), nit("300")]).findings).toHaveLength(2);
    expect(consolidateFindings([nit(null), nit(null)]).findings).toHaveLength(1);
  });

  it("never merges findings with no file", () => {
    const orphan = finding({ file: null, line: null });
    expect(consolidateFindings([orphan, orphan]).findings).toHaveLength(2);
  });

  it("orders importants before nits before pre-existing", () => {
    const tags = ["pre-existing", "nit", "important"] as const;
    const result = consolidateFindings(tags.map((tag, i) => finding({ tag, file: `f${i}.ts` })));
    expect(result.findings.map((f) => f.tag)).toEqual(["important", "nit", "pre-existing"]);
  });
});

describe("consolidateSummary", () => {
  it("adds the consolidator's own count to the mechanical one", () => {
    const base = {
      reviewers_spawned: ["correctness"],
      reviewers_returned: ["correctness"],
      review_mode: "full",
      incremental_from_sha: null,
      prior_importants: [],
      findings: [finding(), finding()],
      refuted_findings: [],
      process_issues: [],
      merged_duplicates: 2,
    } satisfies ReviewSummary;
    const result = consolidateSummary(base);
    expect(result.merged).toBe(3);
    expect(result.summary.findings).toHaveLength(1);
  });
});
