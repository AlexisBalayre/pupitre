import {
  type BotReview,
  type BotThread,
  classifyThread,
  isSummaryReview,
  minorsIn,
  renderTable,
  roundsOf,
  summarize,
  totals,
} from "@src/review-response.utils";
import { describe, expect, it } from "vitest";

function thread(overrides: Partial<BotThread> = {}): BotThread {
  return {
    pr: 1,
    createdAt: "2026-11-01T10:00:00Z",
    isResolved: false,
    isOutdated: false,
    humanReplies: 0,
    ...overrides,
  };
}

function review(overrides: Partial<BotReview> = {}): BotReview {
  return { pr: 1, submittedAt: "2026-11-01T10:00:01Z", minors: 0, ...overrides };
}

describe("classifyThread", () => {
  it("counts a thread whose line changed as fixed, even if it is also resolved", () => {
    expect(classifyThread({ isResolved: true, isOutdated: true, humanReplies: 0 })).toBe("fixed");
  });

  it("counts a thread resolved or answered without a change as dismissed", () => {
    expect(classifyThread({ isResolved: true, isOutdated: false, humanReplies: 0 })).toBe("dismissed");
    expect(classifyThread({ isResolved: false, isOutdated: false, humanReplies: 2 })).toBe("dismissed");
  });

  it("counts an untouched thread as ignored", () => {
    expect(classifyThread({ isResolved: false, isOutdated: false, humanReplies: 0 })).toBe("ignored");
  });
});

describe("isSummaryReview", () => {
  it("accepts the poster's body and rejects the empty review wrapping a standalone comment", () => {
    expect(isSummaryReview("## Claude code review\n\nNo blocking issues.")).toBe(true);
    expect(isSummaryReview("")).toBe(false);
    expect(isSummaryReview("Looks fine to me")).toBe(false);
  });
});

describe("minorsIn", () => {
  it("reads the collapsed minors count", () => {
    expect(minorsIn("## Review\n<details>\n<summary>5 minor issues (not blocking)</summary>")).toBe(5);
    expect(minorsIn("<summary>1 minor issue (not blocking)</summary>")).toBe(1);
  });

  it("is zero when the review carried none", () => {
    expect(minorsIn("No blocking issues found.")).toBe(0);
  });
});

describe("roundsOf", () => {
  it("puts a thread in the review that posted it", () => {
    const a = thread({ createdAt: "2026-11-01T10:00:00Z" });
    const b = thread({ createdAt: "2026-11-01T12:00:00Z" });
    const rounds = roundsOf(
      [b, a],
      [review({ submittedAt: "2026-11-01T12:00:01Z" }), review({ submittedAt: "2026-11-01T10:00:01Z" })],
    );
    expect([rounds.get(a), rounds.get(b)]).toEqual([0, 1]);
  });

  it("counts a round that opened no thread", () => {
    const first = thread({ createdAt: "2026-11-01T10:00:00Z" });
    const third = thread({ createdAt: "2026-11-01T14:00:00Z" });
    const rounds = roundsOf(
      [first, third],
      [
        review({ submittedAt: "2026-11-01T10:00:01Z" }),
        review({ submittedAt: "2026-11-01T12:00:01Z" }),
        review({ submittedAt: "2026-11-01T14:00:01Z" }),
      ],
    );
    expect([rounds.get(first), rounds.get(third)]).toEqual([0, 2]);
  });

  it("numbers each PR on its own", () => {
    const a = thread({ pr: 1 });
    const b = thread({ pr: 2 });
    const rounds = roundsOf([a, b], [review({ pr: 1 }), review({ pr: 2 })]);
    expect([rounds.get(a), rounds.get(b)]).toEqual([0, 0]);
  });

  it("falls back to the last review for a thread no review claims", () => {
    const late = thread({ createdAt: "2026-11-02T00:00:00Z" });
    expect(roundsOf([late], [review(), review({ submittedAt: "2026-11-01T11:00:00Z" })]).get(late)).toBe(1);
  });
});

describe("summarize", () => {
  const reviews = [
    review({ submittedAt: "2026-11-01T10:00:01Z", minors: 3 }),
    review({ submittedAt: "2026-11-01T12:00:01Z", minors: 2 }),
  ];
  const threads = [
    thread({ isOutdated: true }),
    thread({ isResolved: true }),
    thread({ createdAt: "2026-11-01T12:00:00Z" }),
  ];

  it("tallies the outcomes per round and the minors of the same round", () => {
    expect(summarize(threads, reviews)).toEqual([
      { round: "1", importantPosted: 2, fixed: 1, dismissed: 1, ignored: 0, actionableRate: 0.5, minorsPosted: 3 },
      { round: "2", importantPosted: 1, fixed: 0, dismissed: 0, ignored: 1, actionableRate: 0, minorsPosted: 2 },
    ]);
  });

  it("keeps a clean round's minors out of the next round's importants", () => {
    const rows = summarize(
      [thread({ createdAt: "2026-11-01T12:00:00Z", isOutdated: true }), thread({ createdAt: "2026-11-01T12:00:00Z" })],
      [review({ submittedAt: "2026-11-01T10:00:01Z", minors: 3 }), review({ submittedAt: "2026-11-01T12:00:01Z" })],
    );
    expect(rows).toEqual([
      { round: "1", importantPosted: 0, fixed: 0, dismissed: 0, ignored: 0, actionableRate: null, minorsPosted: 3 },
      { round: "2", importantPosted: 2, fixed: 1, dismissed: 0, ignored: 1, actionableRate: 0.5, minorsPosted: 0 },
    ]);
  });

  it("folds the fourth round onward into one row", () => {
    const hours = ["10", "11", "12", "13", "14"];
    const many = hours.map((h) => thread({ createdAt: `2026-11-01T${h}:00:00Z` }));
    const rs = hours.map((h) => review({ submittedAt: `2026-11-01T${h}:00:01Z` }));
    expect(summarize(many, rs).map((r) => r.round)).toEqual(["1", "2", "3", "4+"]);
  });

  it("leaves the rate null for a round with only minors", () => {
    const rows = summarize([], [review({ minors: 4 })]);
    expect(rows[0]?.actionableRate).toBeNull();
  });
});

describe("totals and renderTable", () => {
  it("adds the rounds up and renders a markdown table with an all row", () => {
    const rows = summarize([thread({ isOutdated: true }), thread()], [review()]);
    expect(totals(rows)).toMatchObject({ importantPosted: 2, fixed: 1, actionableRate: 0.5 });
    expect(renderTable(rows)).toContain("| all | 2 | 1 | 0 | 1 | 50% | 0 |");
  });
});
