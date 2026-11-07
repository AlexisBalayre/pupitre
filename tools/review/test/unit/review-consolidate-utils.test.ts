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
  it("merges the same concern raised twice on nearby lines", () => {
    const result = consolidateFindings([finding(), finding({ line: "12", area: "context" })]);
    expect(result.findings).toHaveLength(1);
    expect(result.merged).toBe(1);
  });

  it("credits the most specific area on the survivor", () => {
    const result = consolidateFindings([finding({ area: "docs" }), finding({ area: "security" })]);
    expect(result.findings[0]?.area).toBe("security");
  });

  it("credits a tripped guard over the prose areas that also noticed it", () => {
    const result = consolidateFindings([finding({ area: "simplicity" }), finding({ area: "guards" })]);
    expect(result.findings[0]?.area).toBe("guards");
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
