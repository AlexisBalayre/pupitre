import { execFileSync } from "node:child_process";
import { type BotReview, type BotThread, minorsIn, renderTable, summarize } from "./review-response.utils";

/**
 * Reports how authors respond to the CI review: per review round, how many important findings
 * were posted and how many got fixed, dismissed or left open at merge, plus the minors posted
 * (minors carry no thread, so their outcome is not tracked). Read-only: it only calls `gh api`.
 *
 * Usage: tsx src/review-response.script.ts [--last <n>=30] [--since <YYYY-MM-DD>]
 * It reads the merged PRs of the repository the current directory's `gh` resolves.
 */

const THREADS_QUERY = `query($owner:String!,$repo:String!,$n:Int!,$after:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$n){
    reviewThreads(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{isResolved isOutdated comments(first:50){nodes{createdAt author{__typename} originalCommit{oid}}}}
    }
  }}
}`;

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          isResolved: boolean;
          isOutdated: boolean;
          comments: { nodes: { createdAt: string; author: { __typename: string } | null; originalCommit: { oid: string } | null }[] };
        }[];
      };
    };
  };
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function mergedPrs(last: number, since: string | undefined): number[] {
  const out = gh(["pr", "list", "--state", "merged", "--limit", String(last), "--json", "number,mergedAt"]);
  const prs = JSON.parse(out) as { number: number; mergedAt: string }[];
  return prs.filter((p) => !since || p.mergedAt >= since).map((p) => p.number);
}

function botThreads(owner: string, repo: string, pr: number): BotThread[] {
  const threads: BotThread[] = [];
  let after: string | null = null;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `n=${pr}`];
    if (after) args.push("-f", `after=${after}`);
    const page = (JSON.parse(gh(args)) as { data: ThreadsPage }).data.repository.pullRequest.reviewThreads;
    for (const n of page.nodes) {
      const [first, ...replies] = n.comments.nodes;
      if (first?.author?.__typename !== "Bot" || !first.originalCommit) continue;
      threads.push({
        pr,
        commit: first.originalCommit.oid,
        createdAt: first.createdAt,
        isResolved: n.isResolved,
        isOutdated: n.isOutdated,
        humanReplies: replies.filter((r) => r.author?.__typename === "User").length,
      });
    }
    if (!page.pageInfo.hasNextPage) return threads;
    after = page.pageInfo.endCursor;
  }
}

function botReviews(owner: string, repo: string, pr: number): BotReview[] {
  const out = gh(["api", `repos/${owner}/${repo}/pulls/${pr}/reviews`, "--paginate"]);
  const pages = out.replaceAll("][", ",");
  const reviews = JSON.parse(pages) as { user: { type: string } | null; body: string }[];
  return reviews.filter((r) => r.user?.type === "Bot").map((r) => ({ pr, minors: minorsIn(r.body) }));
}

function main(): void {
  const args = process.argv.slice(2);
  const last = Number(flag(args, "--last") ?? 30);
  const prs = mergedPrs(last, flag(args, "--since"));
  const { owner, name } = JSON.parse(gh(["repo", "view", "--json", "owner,name"])) as { owner: { login: string }; name: string };
  const threads: BotThread[] = [];
  const reviews: BotReview[] = [];
  for (const pr of prs) {
    threads.push(...botThreads(owner.login, name, pr));
    reviews.push(...botReviews(owner.login, name, pr));
  }
  console.log(`${prs.length} merged PRs, ${threads.length} important findings posted as threads\n`);
  console.log(renderTable(summarize(threads, reviews)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
