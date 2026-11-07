export type Outcome = "fixed" | "dismissed" | "ignored";

/** One inline review thread opened by the review bot, as the GraphQL API returns it. */
export interface BotThread {
  pr: number;
  /** The commit the first comment was made on; one commit is one review round. */
  commit: string;
  createdAt: string;
  isResolved: boolean;
  isOutdated: boolean;
  /** Replies from anyone but a bot. */
  humanReplies: number;
}

/** The review bot's posted reviews of one PR, oldest first, with the minors each carried. */
export interface BotReview {
  pr: number;
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

export function minorsIn(reviewBody: string): number {
  const m = /<summary>(\d+) minor issues?/.exec(reviewBody);
  return m ? Number(m[1]) : 0;
}

function roundLabel(index: number): string {
  return index + 1 >= ROUND_CAP ? `${ROUND_CAP}+` : String(index + 1);
}

/** Round numbers per thread: the n-th distinct commit a PR's bot threads were opened on. */
export function roundsOf(threads: BotThread[]): Map<BotThread, number> {
  const byPr = new Map<number, BotThread[]>();
  for (const t of threads) byPr.set(t.pr, [...(byPr.get(t.pr) ?? []), t]);
  const rounds = new Map<BotThread, number>();
  for (const list of byPr.values()) {
    const firstSeen = new Map<string, string>();
    for (const t of list) {
      const seen = firstSeen.get(t.commit);
      if (seen === undefined || t.createdAt < seen) firstSeen.set(t.commit, t.createdAt);
    }
    const order = [...firstSeen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([c]) => c);
    for (const t of list) rounds.set(t, order.indexOf(t.commit));
  }
  return rounds;
}

export function summarize(threads: BotThread[], reviews: BotReview[]): RoundRow[] {
  const rounds = roundsOf(threads);
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
  const seenPerPr = new Map<number, number>();
  for (const rv of reviews) {
    const i = seenPerPr.get(rv.pr) ?? 0;
    seenPerPr.set(rv.pr, i + 1);
    row(roundLabel(i)).minorsPosted += rv.minors;
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
