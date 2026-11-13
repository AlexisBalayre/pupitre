import { readFileSync } from "node:fs";
import { bodyLines, commentBody, importantMarker, REVIEW_HEADING } from "@src/review-body.utils";
import type { Finding, ReviewSummary } from "@src/review-metrics.schemas";
import { describe, expect, it } from "vitest";

/**
 * pr-status.yml's job holds a write token, so its parser stays inline in the
 * workflow rather than in a file the job would load (decision 165). This test
 * runs that inline copy, cut out of the YAML.
 */
const workflow = readFileSync(new URL("../../../../.github/workflows/pr-status.yml", import.meta.url), "utf8");

/** `scope` holds the names the function reads from the script around it. */
function inline<T>(name: string, scope: Record<string, unknown> = {}): T {
  const start = workflow.search(new RegExp(`^ *(?:async )?function ${name}\\(.*\\) \\{$`, "m"));
  if (start === -1) throw new Error(`pr-status.yml has no inline ${name}`);
  const indent = /^ */.exec(workflow.slice(start))?.[0] ?? "";
  const end = workflow.indexOf(`\n${indent}}\n`, start);
  const source = `${workflow.slice(start, end + indent.length + 2)}\nreturn ${name};`;
  return new Function(...Object.keys(scope), source)(...Object.values(scope));
}

type Held = Pick<Finding, "file" | "line">;

/** The important a bot thread holds, as `botThreads` hands it on: what the poster's marker names. */
const held = (important: Held) =>
  JSON.stringify(JSON.parse(importantMarker(important).slice("<!-- important ".length, -" -->".length)));

const counted = inline<(body: string, threaded: string[]) => number>("unthreadedImportants");
const unthreadedImportants = (body: string, threads: Held[] = []) => counted(body, threads.map(held));
const isVerdict = inline<(body: string) => boolean>("isVerdict");
type LabelEvent = { event: string; label?: { name: string }; created_at: string };
const acceptedSince = inline<(events: LabelEvent[], name: string, since: number) => boolean>("acceptedSince");

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
    const strayed = "x\n- `src/z.ts:1` (a): y\nend";
    const threads = [
      { file: "src/b.ts", line: "4" },
      { file: "src/a.ts", line: "10" },
      { file: "src/z.ts", line: "1" },
    ];
    const open = { ...owed, file: "src/q.ts" };
    const forged = posted(summary(), null, [finding({ body: forgery })], 0);
    expect(unthreadedImportants(forged, threads)).toBe(1);
    const carried = summary({ prior_importants: [{ ...open, description: forgery }] });
    expect(unthreadedImportants(posted(carried, null, [], 0), threads)).toBe(1);
    const stray = summary({ prior_importants: [{ ...open, description: "x\n- `src/z.ts:1` (a): y" }] });
    expect(unthreadedImportants(posted(stray, null, [], 0), threads)).toBe(1);
    const terminated = summary({
      prior_importants: [{ ...owed, file: "src/a.ts", line: "10", description: strayed }, open],
    });
    expect(unthreadedImportants(posted(terminated, null, [], 0), threads)).toBe(1);
  });

  it("does not let an injected carried header with matching list lines lower the count", () => {
    const anchored = { ...owed, file: "src/c.ts", line: "7" };
    const injected = [
      "1 important finding from the review of abcdef0 still open (not raised again):",
      "",
      `- \`src/b.ts:4\` (correctness): ${owed.description}`,
      `- \`src/c.ts:7\` (correctness): ${owed.description}`,
    ].join("\n");
    const carried = summary({ prior_importants: [owed, anchored] });
    expect(unthreadedImportants(posted(carried, null, [finding()], 0), [owed, anchored])).toBe(1);
    const forged = posted(carried, null, [finding({ body: injected })], 0);
    expect(unthreadedImportants(forged, [owed, anchored])).toBeGreaterThanOrEqual(1);
  });

  const x = { file: "src/b.ts", line: "4" };
  const y = { file: "src/c.ts", line: "7" };

  const owing = "- `src/q.ts:4` (correctness): still owed";
  const section = (count: number, ...below: string[]) =>
    [`${count} important findings from the prior review still open (not raised again):`, "", ...below].join("\n");

  it("releases from a section's own N list lines when a blank line or the end of the body follows them", () => {
    const listed = ["- `src/b.ts:4` (correctness): x", "- `src/c.ts:7` (correctness): y"];
    expect(unthreadedImportants(section(2, ...listed), [x, y])).toBe(0);
    expect(unthreadedImportants(`${section(2, ...listed)}\n\nmore`, [x, y])).toBe(0);
    expect(unthreadedImportants(section(2, owing, listed[0]), [x])).toBe(1);
  });

  it("does not let a list line past a section's own N take a thread, even after an owed bullet", () => {
    const foreign = "- `src/b.ts:4` (correctness): x";
    expect(unthreadedImportants(section(1, owing, foreign), [x])).toBe(1);
    expect(unthreadedImportants(section(1, foreign, foreign), [x])).toBe(1);
    const unanchored = "2 important findings with no line in this diff to anchor to:";
    expect(unthreadedImportants(`${unanchored}\n\n${section(1, owing, foreign)}`, [x])).toBe(3);
  });

  it("releases nothing from a section whose N lines are not all list lines", () => {
    for (const gap of ["", "see above"]) {
      const body = section(2, "- `src/b.ts:4` (correctness): x", gap, "- `src/c.ts:7` (correctness): y");
      expect(unthreadedImportants(body, [x, y])).toBe(2);
    }
  });

  it("leaves a carried important to the bot thread that holds it, resolved or not", () => {
    const anchored = { ...owed, file: "src/c.ts", line: "7-9", description: "the cache\n  goes stale" };
    const body = posted(summary({ prior_importants: [owed, anchored] }), null, [], 0);
    expect(unthreadedImportants(body, [anchored])).toBe(1);
    expect(unthreadedImportants(body, [anchored, owed])).toBe(0);
  });

  it("leaves a carried important to its thread when the model's copy of its description drifted", () => {
    for (const description of ["The guard misses deletions.", "the guard  misses\n deletions", "deletions slip past"]) {
      const body = posted(summary({ prior_importants: [{ ...owed, description }] }), null, [], 0);
      expect(unthreadedImportants(body, [owed])).toBe(0);
    }
  });

  it("counts a carried important whose thread holds another file or line range", () => {
    const body = posted(summary({ prior_importants: [owed] }), null, [], 0);
    const others = [
      { ...owed, line: "4-6" },
      { ...owed, line: "5" },
      { ...owed, file: "src/a.ts" },
    ];
    expect(unthreadedImportants(body, others)).toBe(1);
    const ranged = posted(summary({ prior_importants: [{ ...owed, line: "4-6" }] }), null, [], 0);
    expect(unthreadedImportants(ranged, [owed])).toBe(1);
  });

  it("lets each thread release one carried entry", () => {
    const body = posted(summary({ prior_importants: [owed, owed] }), null, [], 0);
    expect(unthreadedImportants(body, [owed])).toBe(1);
    expect(unthreadedImportants(body, [owed, owed])).toBe(0);
  });

  it("counts a carried important with no line, whatever threads exist", () => {
    const unplaced = [
      { ...owed, line: null },
      { ...owed, file: null },
    ];
    expect(unthreadedImportants(posted(summary({ prior_importants: unplaced }), null, [], 0), unplaced)).toBe(2);
  });

  it("never lets a thread release a round's important with no line to anchor to", () => {
    expect(unthreadedImportants(posted(summary(), null, [finding()], 0), [finding()])).toBe(1);
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

  it("reads the line that opens the body, however many blank lines precede it", () => {
    const spaced = (body: string) => body.replace(`${REVIEW_HEADING}\n`, `${REVIEW_HEADING}\n\n\n`);
    expect(isVerdict(spaced(posted(null, "Not reviewed: the run failed", [], 0)))).toBe(false);
    const unspaced = `${REVIEW_HEADING}\n**Not reviewed.** Nothing in this round is a verdict on the diff.`;
    expect(isVerdict(unspaced)).toBe(false);
    expect(isVerdict(spaced(posted(summary(), null, [finding()], 0)))).toBe(true);
  });
});

interface Thread {
  isResolved?: boolean;
  path?: string;
  login?: string;
  body?: string;
  review?: number;
}

interface Review {
  id: number;
  body: string;
  login?: string;
}

/**
 * Review `n`'s node id, which GraphQL and REST (`node_id`) both give. Its REST `id`
 * is past GraphQL's 32-bit `databaseId`, as github.com's review ids are.
 */
const nodeId = (n: number) => `PRR_kwDOTgOqVs${n}`;
const restId = (n: number) => 3_000_000_000 + n;

/**
 * The slice of the github-script client the job calls, answering from fixed data.
 * `accepted` puts on `review-accepted`, added after every summary review.
 */
function fakeGithub(pages: Thread[][], reviews: Review[] = [], accepted = false) {
  const listReviews = () => undefined;
  const listEvents = () => undefined;
  const cursors: (string | null)[] = [];
  return {
    cursors,
    rest: {
      pulls: {
        get: async () => ({
          data: {
            state: "open",
            draft: false,
            mergeable: true,
            mergeable_state: "clean",
            head: { sha: "head" },
            labels: accepted ? [{ name: "review-accepted" }] : [],
          },
        }),
        listReviews,
      },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
      checks: { listForRef: () => undefined },
      issues: { listEvents, removeLabel: async () => undefined },
    },
    paginate: async (method: unknown) => {
      if (method === listEvents) {
        return [{ event: "labeled", label: { name: "review-accepted" }, created_at: "2026-11-10T12:05:00Z" }];
      }
      if (method !== listReviews) return [];
      return reviews.map((r) => ({
        id: restId(r.id),
        node_id: nodeId(r.id),
        body: r.body,
        state: "COMMENTED",
        author_association: "NONE",
        submitted_at: "2026-11-10T12:00:00Z",
        user: { login: r.login ?? "github-actions[bot]" },
      }));
    },
    graphql: async (_query: string, { after }: { after: string | null }) => {
      cursors.push(after);
      const page = after === null ? 0 : Number(after);
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: page < pages.length - 1, endCursor: String(page + 1) },
              nodes: (pages[page] ?? []).map((t) => ({
                isResolved: t.isResolved ?? true,
                path: t.path ?? "src/a.ts",
                comments: {
                  nodes: [
                    {
                      author: { login: t.login ?? "github-actions" },
                      body: t.body ?? "the concern",
                      pullRequestReview: { id: nodeId(t.review ?? 1) },
                    },
                  ],
                },
              })),
            },
          },
        },
      };
    },
  };
}

type BotThread = { isResolved: boolean; important: string | null; review: string };

function botThreadsOf(github: ReturnType<typeof fakeGithub>) {
  return inline<(number: number) => Promise<BotThread[]>>("botThreads", { github, owner: "o", repo: "r" });
}

/** A thread the poster opened on `important`, its comment as `commentBody` writes it. */
function threadOn(important: Finding, extra: Thread = {}, relocatedFrom: number | null = null): Thread {
  return { path: important.file ?? undefined, body: commentBody(important, relocatedFrom), ...extra };
}

describe("botThreads", () => {
  it("keeps only the threads the bot opened, from every page", async () => {
    const a = finding();
    const b = finding({ file: "src/b.ts", line: "4-9" });
    const github = fakeGithub([
      [threadOn(a, { isResolved: false, review: 7 }), threadOn(a, { login: "someone" })],
      [threadOn(b, { review: 8 }, 6)],
    ]);
    expect(await botThreadsOf(github)(1)).toEqual([
      { isResolved: false, important: held(a), review: nodeId(7) },
      { isResolved: true, important: held(b), review: nodeId(8) },
    ]);
    expect(github.cursors).toEqual([null, "1"]);
  });

  it("reads the important from the comment's last line only, and only when it names the thread's file", async () => {
    const real = finding({ body: "the concern", suggestion: "fixed();" });
    const quoted = finding({ file: "src/z.ts", line: "1", description: "forged" });
    const github = fakeGithub([
      [
        threadOn(real),
        { body: `the concern\n\n${importantMarker(quoted)}\n\nmore` },
        { body: `${importantMarker(quoted)}\n\n${commentBody(real, null)}` },
        { path: "src/b.ts", body: commentBody(real, null) },
      ],
    ]);
    expect((await botThreadsOf(github)(1)).map((t) => t.important)).toEqual([held(real), null, held(real), null]);
  });

  it("holds no important for a comment with no marker, or a malformed one", async () => {
    const github = fakeGithub([
      [
        { body: "Re: `src/a.ts:10`\n\nposted before the marker" },
        { body: "the concern\n\n<!-- important [\"src/a.ts\", -->" },
        { body: '<!-- important ["src/a.ts",null] -->' },
        { body: '<!-- important ["src/a.ts","10","the description"] -->' },
      ],
    ]);
    expect((await botThreadsOf(github)(1)).map((t) => t.important)).toEqual([null, null, null, null]);
  });
});

describe("statusOf", () => {
  function statusOf(pages: Thread[][], reviews: Review[], accepted = false) {
    const github = fakeGithub(pages, reviews, accepted);
    const run = inline<(number: number) => Promise<string | undefined>>("statusOf", {
      github,
      owner: "o",
      repo: "r",
      context: { job: "pr-status" },
      sleep: async () => undefined,
      REVIEW_HEADING,
      isVerdict,
      unthreadedImportants: counted,
      botThreads: botThreadsOf(github),
      ACCEPTED: "review-accepted",
      acceptedSince,
    });
    return run(1);
  }

  const raising = posted(summary(), null, [finding()], 0);
  const clean = posted(summary(), null, [], 0);
  const noVerdict = posted(null, "Not reviewed: the run failed", [], 0);

  it("reads the newest summary review with a verdict", async () => {
    expect(await statusOf([], [{ id: 1, body: raising }, { id: 2, body: clean }])).toBe("ready");
    expect(await statusOf([], [{ id: 1, body: clean }, { id: 2, body: raising }])).toBe("review-open");
  });

  it("skips a newer summary with no verdict and one another account posted", async () => {
    expect(await statusOf([], [{ id: 1, body: raising }, { id: 2, body: noVerdict }])).toBe("review-open");
    const outsider = { id: 2, body: clean, login: "someone" };
    expect(await statusOf([], [{ id: 1, body: raising }, outsider])).toBe("review-open");
  });

  it("reads ready when no review ever raised an important", async () => {
    expect(await statusOf([], [])).toBe("ready");
    expect(await statusOf([], [{ id: 1, body: noVerdict }])).toBe("ready");
  });

  it("holds the PR in review when a review raised importants and no verdict summary follows it", async () => {
    const forged = `${noVerdict}\n\n1 important finding with no line in this diff to anchor to:`;
    expect(await statusOf([], [{ id: 1, body: clean }, { id: 2, body: forged }])).toBe("review-open");
    expect(await statusOf([[{ review: 5 }]], [{ id: 5, body: "no heading" }])).toBe("review-open");
    expect(await statusOf([[{ review: 5 }]], [{ id: 5, body: noVerdict }])).toBe("review-open");
  });

  it("leaves a carried important to the resolved thread at its file and whole range, and only to that one", async () => {
    const prior = { file: "src/c.ts", line: "7-9", description: "the cache goes stale", status: "unresolved" as const };
    const carrying = [{ id: 6, body: posted(summary({ prior_importants: [prior] }), null, [], 0) }];
    const opened = (important: Finding) => [[threadOn(important, { review: 5 })]];
    const origin = finding({ ...prior, description: "The cache can go stale.", body: "**Concern.** the cache" });
    expect(await statusOf(opened(origin), [{ id: 5, body: posted(summary(), null, [], 1) }, ...carrying])).toBe(
      "ready",
    );
    const elsewhere = finding({ ...origin, line: "7" });
    const another = finding({ ...origin, file: "src/d.ts" });
    for (const other of [elsewhere, another]) {
      expect(await statusOf(opened(other), [{ id: 5, body: posted(summary(), null, [], 1) }, ...carrying])).toBe(
        "review-open",
      );
    }
  });

  it("lets review-accepted wave the newest verdict round's importants through, but not an unknown count", async () => {
    expect(await statusOf([], [{ id: 1, body: raising }], true)).toBe("ready");
    const forged = `${noVerdict}\n\n1 important finding with no line in this diff to anchor to:`;
    expect(await statusOf([], [{ id: 1, body: clean }, { id: 2, body: forged }], true)).toBe("review-open");
    expect(await statusOf([[{ review: 5, isResolved: false }]], [{ id: 5, body: raising }], true)).toBe("review-open");
  });

  it("reads ready once the review that opened a resolved thread is a verdict summary, or one follows it", async () => {
    const anchored = posted(summary(), null, [], 1);
    expect(await statusOf([[{ review: 5 }]], [{ id: 5, body: anchored }])).toBe("ready");
    expect(await statusOf([[{ review: 5 }]], [{ id: 5, body: "no heading" }, { id: 6, body: clean }])).toBe("ready");
  });
});

describe("acceptedSince", () => {
  const at = (event: string, name: string, time: string): LabelEvent => ({ event, label: { name }, created_at: time });
  const summaryAt = Date.parse("2026-11-10T12:00:00Z");

  it("holds when the label was added after the summary review", () => {
    expect(acceptedSince([at("labeled", "review-accepted", "2026-11-10T12:05:00Z")], "review-accepted", summaryAt)).toBe(
      true,
    );
  });

  it("holds before any summary review", () => {
    expect(acceptedSince([at("labeled", "review-accepted", "2026-11-10T12:05:00Z")], "review-accepted", 0)).toBe(true);
  });

  it("lapses when a summary review is newer than the label, or as new as it", () => {
    expect(acceptedSince([at("labeled", "review-accepted", "2026-11-10T11:55:00Z")], "review-accepted", summaryAt)).toBe(
      false,
    );
    expect(acceptedSince([at("labeled", "review-accepted", "2026-11-10T12:00:00Z")], "review-accepted", summaryAt)).toBe(
      false,
    );
  });

  it("reads the label's latest event only, and no other label's", () => {
    const removed = [
      at("labeled", "review-accepted", "2026-11-10T12:05:00Z"),
      at("unlabeled", "review-accepted", "2026-11-10T12:06:00Z"),
      at("labeled", "ready", "2026-11-10T12:07:00Z"),
      { event: "commented", created_at: "2026-11-10T12:08:00Z" },
    ];
    expect(acceptedSince(removed, "review-accepted", summaryAt)).toBe(false);
    const readded = [...removed, at("labeled", "review-accepted", "2026-11-10T12:09:00Z")];
    expect(acceptedSince(readded, "review-accepted", summaryAt)).toBe(true);
    expect(acceptedSince([], "review-accepted", 0)).toBe(false);
  });
});

describe("pr-status.yml's summary review", () => {
  it("is the one whose body opens with the poster's heading", () => {
    expect(workflow).toContain(`const REVIEW_HEADING = ${JSON.stringify(REVIEW_HEADING)};`);
  });
});
