import { parsePriorReview, priorImportants, priorRecordPath } from "@src/prior-record.utils";
import type { Finding, PriorReview } from "@src/review-metrics.schemas";
import { describe, expect, it } from "vitest";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: "10",
    area: "correctness",
    confidence: "high",
    tag: "important",
    description: "the guard misses deletions",
    body: "The guard reads only additions, so a deleted file skips it.",
    suggestion: null,
    ...overrides,
  };
}

const carriedBefore = { file: "src/c.ts", line: "7-9", description: "the retry never backs off", status: "unresolved" as const };

const record: PriorReview = {
  findings: [finding({ tag: "nit", description: "a nit" }), finding()],
  prior_importants: [{ ...carriedBefore, status: "resolved", description: "already fixed" }, carriedBefore],
};

describe("priorImportants", () => {
  it("names each owed entry from the record: its importants, then the entries it still carried", () => {
    expect(
      priorImportants(record, [
        { from: "findings", index: 1, status: "unresolved" },
        { from: "prior_importants", index: 1, status: "unresolved" },
      ]),
    ).toEqual([
      { file: "src/a.ts", line: "10", description: "the guard misses deletions", status: "unresolved" },
      carriedBefore,
    ]);
  });

  it("marks an entry resolved only on the model's resolved verdict for it", () => {
    const named = priorImportants(record, [
      { from: "findings", index: 1, status: "resolved" },
      { from: "prior_importants", index: 1, status: "unresolved" },
    ]);
    expect(named.map((entry) => entry.status)).toEqual(["resolved", "unresolved"]);
  });

  it("keeps an entry open that the model left out, misnumbered or called both ways", () => {
    expect(priorImportants(record, []).map((entry) => entry.status)).toEqual(["unresolved", "unresolved"]);
    const misnumbered = priorImportants(record, [
      { from: "findings", index: 0, status: "resolved" },
      { from: "prior_importants", index: 9, status: "resolved" },
    ]);
    expect(misnumbered.map((entry) => entry.status)).toEqual(["unresolved", "unresolved"]);
    const torn = priorImportants(record, [
      { from: "findings", index: 1, status: "resolved" },
      { from: "findings", index: 1, status: "unresolved" },
      { from: "prior_importants", index: 1, status: "resolved" },
    ]);
    expect(torn.map((entry) => entry.status)).toEqual(["unresolved", "resolved"]);
  });

  it("keeps every entry open when the model counted only the owed entries", () => {
    const threeCarried: PriorReview = {
      findings: [],
      prior_importants: [
        { ...carriedBefore, status: "resolved", description: "X" },
        { ...carriedBefore, description: "Y" },
        { ...carriedBefore, description: "Z" },
      ],
    };
    const offByOwed = priorImportants(threeCarried, [
      { from: "prior_importants", index: 0, status: "unresolved" },
      { from: "prior_importants", index: 1, status: "resolved" },
    ]);
    expect(offByOwed.map((entry) => [entry.description, entry.status])).toEqual([
      ["Y", "unresolved"],
      ["Z", "unresolved"],
    ]);
    const onlyZ = priorImportants(threeCarried, [{ from: "prior_importants", index: 1, status: "resolved" }]);
    expect(onlyZ.map((entry) => entry.status)).toEqual(["unresolved", "unresolved"]);
  });

  it("carries the next round from the entries this round recorded", () => {
    const round1 = priorImportants(record, []);
    const round2 = priorImportants({ findings: [], prior_importants: round1 }, [
      { from: "prior_importants", index: 0, status: "resolved" },
      { from: "prior_importants", index: 1, status: "unresolved" },
    ]);
    expect(round2).toEqual([{ ...round1[0], status: "resolved" }, round1[1]]);
  });

  it("owes nothing without a record, or from a record whose fields are null", () => {
    expect(priorImportants(null, [{ from: "findings", index: 0, status: "unresolved" }])).toEqual([]);
    expect(priorImportants({ findings: null, prior_importants: null }, [])).toEqual([]);
  });
});

describe("parsePriorReview", () => {
  it("reads a record's carried fields and drops the rest", () => {
    const raw = JSON.stringify({ schema_version: 7, run_id: "1", ...record });
    expect(parsePriorReview(raw)).toEqual(record);
  });

  it("is null for no record, invalid JSON, or a record of another shape", () => {
    expect(parsePriorReview(null)).toBeNull();
    expect(parsePriorReview("{")).toBeNull();
    expect(parsePriorReview(JSON.stringify({ findings: "none", prior_importants: [] }))).toBeNull();
  });
});

describe("priorRecordPath", () => {
  it("is the job's temp directory, unless the environment names the file", () => {
    expect(priorRecordPath({ RUNNER_TEMP: "/tmp/job" })).toBe("/tmp/job/prior-record.json");
    expect(priorRecordPath({ RUNNER_TEMP: "/tmp/job", REVIEW_PRIOR_RECORD: "/x.json" })).toBe("/x.json");
  });
});
