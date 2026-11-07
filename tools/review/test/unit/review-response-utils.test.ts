import {
  type BotThread,
  classifyThread,
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
    commit: "aaa",
    createdAt: "2026-11-01T10:00:00Z",
    isResolved: false,
    isOutdated: false,
    humanReplies: 0,
    ...overrides,
  };
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
  it("numbers a PR's rounds by the order its commits first drew a thread", () => {
    const a = thread({ commit: "c1", createdAt: "2026-11-01T10:00:00Z" });
    const b = thread({ commit: "c2", createdAt: "2026-11-01T12:00:00Z" });
    const c = thread({ commit: "c1", createdAt: "2026-11-01T10:00:05Z" });
    const rounds = roundsOf([b, a, c]);
    expect([rounds.get(a), rounds.get(b), rounds.get(c)]).toEqual([0, 1, 0]);
  });

  it("numbers each PR on its own", () => {
    const a = thread({ pr: 1, commit: "x" });
    const b = thread({ pr: 2, commit: "y" });
    const rounds = roundsOf([a, b]);
    expect([rounds.get(a), rounds.get(b)]).toEqual([0, 0]);
  });
});

describe("summarize", () => {
  const threads = [
    thread({ commit: "c1", isOutdated: true }),
    thread({ commit: "c1", isResolved: true }),
    thread({ commit: "c2", createdAt: "2026-11-01T12:00:00Z" }),
  ];

  it("tallies the outcomes per round and the minors by review order", () => {
    const rows = summarize(threads, [
      { pr: 1, minors: 3 },
      { pr: 1, minors: 2 },
    ]);
    expect(rows).toEqual([
      { round: "1", importantPosted: 2, fixed: 1, dismissed: 1, ignored: 0, actionableRate: 0.5, minorsPosted: 3 },
      { round: "2", importantPosted: 1, fixed: 0, dismissed: 0, ignored: 1, actionableRate: 0, minorsPosted: 2 },
    ]);
  });

  it("folds the fourth round onward into one row", () => {
    const many = ["c1", "c2", "c3", "c4", "c5"].map((commit, i) =>
      thread({ commit, createdAt: `2026-11-01T1${i}:00:00Z` }),
    );
    expect(summarize(many, []).map((r) => r.round)).toEqual(["1", "2", "3", "4+"]);
  });

  it("leaves the rate null for a round with only minors", () => {
    const rows = summarize([], [{ pr: 1, minors: 4 }]);
    expect(rows[0]?.actionableRate).toBeNull();
  });
});

describe("totals and renderTable", () => {
  it("adds the rounds up and renders a markdown table with an all row", () => {
    const rows = summarize([thread({ isOutdated: true }), thread({ commit: "z" })], []);
    expect(totals(rows)).toMatchObject({ importantPosted: 2, fixed: 1, actionableRate: 0.5 });
    expect(renderTable(rows)).toContain("| all | 2 | 1 | 0 | 1 | 50% | 0 |");
  });
});
