import { REVIEW_HEADING } from "./review-status.utils";

export type Outcome = "fixed" | "dismissed" | "ignored";

/** One inline review thread opened by the review bot, as the GraphQL API returns it. */
export interface BotThread {
  pr: number;
  createdAt: string;
  isResolved: boolean;
  isOutdated: boolean;
  /** Replies from anyone but a bot. */
  humanReplies: number;
}

/** One summary review the poster posted. It posts one every round, thread or not, so the n-th is round n. */
export interface BotReview {
  pr: number;
  submittedAt: string;
  minors: number;
}

export interface RoundRow {
  round: string;
  importantPosted: number;
  fixed: number;
  dismissed: number;
  ignored: number;
  /** fixed / importantPosted; null when no important was posted. */
  actionableRate: number | null;
  minorsPosted: number;
}

const ROUND_CAP = 4;

/**
 * GitHub marks a thread outdated once the commented line changed in a later commit, which is the
 * best signal that the author acted on it. A thread resolved or answered without that change is
 * the author ruling it out; one nobody touched was open at merge.
 */
export function classifyThread(t: Pick<BotThread, "isResolved" | "isOutdated" | "humanReplies">): Outcome {
  if (t.isOutdated) return "fixed";
  if (t.isResolved || t.humanReplies > 0) return "dismissed";
  return "ignored";
}

/** The poster's summary review, not the empty review GitHub wraps around each comment posted on its own when the batch fails. */
export function isSummaryReview(reviewBody: string): boolean {
  return reviewBody.startsWith(REVIEW_HEADING);
}

export function minorsIn(reviewBody: string): number {
  const m = /<summary>(\d+) minor issues?/.exec(reviewBody);
  return m ? Number(m[1]) : 0;
}

function roundLabel(index: number): string {
  return index + 1 >= ROUND_CAP ? `${ROUND_CAP}+` : String(index + 1);
}

/** Each PR's bot reviews, oldest first: the n-th is round n. */
function reviewsByPr(reviews: BotReview[]): Map<number, BotReview[]> {
  const byPr = new Map<number, BotReview[]>();
  for (const r of reviews) byPr.set(r.pr, [...(byPr.get(r.pr) ?? []), r]);
  for (const list of byPr.values()) list.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return byPr;
}

/**
 * Round index (from 0) per thread: the review that posted it, which is the first of the PR's bot
 * reviews submitted at or after the thread's first comment. Threads and minors then share one
 * numbering, so a clean round between two that open threads is still a round.
 */
export function roundsOf(threads: BotThread[], reviews: BotReview[]): Map<BotThread, number> {
  const byPr = reviewsByPr(reviews);
  const rounds = new Map<BotThread, number>();
  for (const t of threads) {
    const list = byPr.get(t.pr) ?? [];
    const i = list.findIndex((r) => r.submittedAt >= t.createdAt);
    rounds.set(t, i === -1 ? Math.max(list.length - 1, 0) : i);
  }
  return rounds;
}

export function summarize(threads: BotThread[], reviews: BotReview[]): RoundRow[] {
  const rounds = roundsOf(threads, reviews);
  const rows = new Map<string, RoundRow>();
  const row = (label: string): RoundRow => {
    let r = rows.get(label);
    if (!r) {
      r = { round: label, importantPosted: 0, fixed: 0, dismissed: 0, ignored: 0, actionableRate: null, minorsPosted: 0 };
      rows.set(label, r);
    }
    return r;
  };
  for (const t of threads) {
    const r = row(roundLabel(rounds.get(t) ?? 0));
    r.importantPosted += 1;
    r[classifyThread(t)] += 1;
  }
  for (const list of reviewsByPr(reviews).values()) {
    list.forEach((rv, i) => {
      row(roundLabel(i)).minorsPosted += rv.minors;
    });
  }
  const out = [...rows.values()].sort((a, b) => a.round.localeCompare(b.round));
  for (const r of out) r.actionableRate = r.importantPosted ? r.fixed / r.importantPosted : null;
  return out;
}

export function totals(rows: RoundRow[]): RoundRow {
  const t: RoundRow = { round: "all", importantPosted: 0, fixed: 0, dismissed: 0, ignored: 0, actionableRate: null, minorsPosted: 0 };
  for (const r of rows) {
    t.importantPosted += r.importantPosted;
    t.fixed += r.fixed;
    t.dismissed += r.dismissed;
    t.ignored += r.ignored;
    t.minorsPosted += r.minorsPosted;
  }
  t.actionableRate = t.importantPosted ? t.fixed / t.importantPosted : null;
  return t;
}

export function renderTable(rows: RoundRow[]): string {
  const pct = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(0)}%`);
  const lines = [
    "| Round | Important posted | Fixed | Dismissed | Ignored | Actionable | Minors posted |",
    "| :---- | ---------------: | ----: | --------: | ------: | ---------: | ------------: |",
  ];
  for (const r of [...rows, totals(rows)]) {
    lines.push(
      `| ${r.round} | ${r.importantPosted} | ${r.fixed} | ${r.dismissed} | ${r.ignored} | ${pct(r.actionableRate)} | ${r.minorsPosted} |`,
    );
  }
  return lines.join("\n");
}
