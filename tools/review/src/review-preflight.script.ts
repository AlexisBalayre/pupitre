import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  decideMode,
  isCommentOnlyDelta,
  newestCleanRecord,
  parseRawDiff,
  type PriorRecord,
  porcelainPaths,
} from "./preflight.utils";

/**
 * Deterministic review preflight. Asserts the working
 * tree is the PR's current head and clean, resolves the merge base, and decides
 * full versus incremental against the prior record on `ci/review-metrics`,
 * before the model starts. A failure here is a red step the poster's `always()`
 * guarantee turns into a "not reviewed" verdict; the model never re-derives any
 * of it. The action's config restore has not happened yet at this point, so the
 * tree must be exactly the PR head with nothing dirty at all.
 */

const METRICS_REF = "origin/ci/review-metrics";

function fail(message: string): never {
  process.stdout.write(`::error::${message}\n`);
  process.exit(1);
}

function warn(message: string): void {
  process.stdout.write(`::warning::${message}\n`);
}

function out(name: string, value: string): void {
  appendFileSync(process.env.GITHUB_OUTPUT ?? "preflight-output.txt", `${name}=${value}\n`);
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitOk(...args: string[]): boolean {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
}

function gh(...args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function markNotReviewed(sha: string, description: string): void {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const runUrl = `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
  try {
    execFileSync("gh", ["api", "--method", "POST", `repos/${repository}/statuses/${sha}`, "--input", "-"], {
      input: JSON.stringify({ state: "pending", context: "claude-review", description, target_url: runUrl }),
    });
  } catch {
    warn("could not set the claude-review commit status");
  }
}

function headRefOid(prNumber: string): string {
  return (JSON.parse(gh("pr", "view", prNumber, "--json", "headRefOid")) as { headRefOid: string }).headRefOid;
}

function priorRecords(prNumber: string): PriorRecord[] {
  let hits: string;
  try {
    // `:(top)` anchors the pathspec at the repo root: `pnpm --filter` runs this
    // from the package directory, where a plain `records/` would match nothing.
    hits = git("grep", "-l", `"pr_number": ${prNumber},`, METRICS_REF, "--", ":(top)records/");
  } catch {
    // git grep exits non-zero on no match and when the ref is absent; either
    // way there is no prior record to key off.
    return [];
  }
  const records: PriorRecord[] = [];
  for (const hit of hits.split("\n").filter(Boolean)) {
    try {
      const parsed = JSON.parse(git("show", hit)) as Record<string, unknown>;
      records.push({
        path: hit.slice(hit.indexOf(":") + 1),
        commit_sha: typeof parsed.commit_sha === "string" ? parsed.commit_sha : null,
        timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
        is_error: parsed.is_error === true,
      });
    } catch {
      warn(`unreadable record ${hit}; skipping it`);
    }
  }
  return records;
}

async function main(): Promise<void> {
  const prNumber = process.env.REVIEW_PR_NUMBER ?? "";
  if (!/^\d+$/.test(prNumber)) fail("REVIEW_PR_NUMBER missing or not a number");
  const trigger = process.env.REVIEW_TRIGGER ?? "";
  const forceFull = process.env.REVIEW_FORCE_FULL === "true";

  let headSha = headRefOid(prNumber);
  if (git("rev-parse", "HEAD") !== headSha) {
    // A push can land between the checkout step and here; re-sync once, then
    // re-read the head so a push during the re-sync fails rather than lies.
    warn("working tree is behind the PR head; re-syncing");
    gitOk("-c", "advice.detachedHead=false", "checkout", headSha) || gh("pr", "checkout", prNumber);
    headSha = headRefOid(prNumber);
    if (git("rev-parse", "HEAD") !== headSha) {
      fail(`working tree is not the PR head (${headSha}); a push is racing this run`);
    }
  }
  out("sha", headSha);

  const dirty = porcelainPaths(git("status", "--porcelain"));
  if (dirty.length > 0) {
    fail(`working tree is dirty before the review started: ${dirty.join(", ")}`);
  }

  const baseRef = (JSON.parse(gh("pr", "view", prNumber, "--json", "baseRefName")) as { baseRefName: string })
    .baseRefName;
  out("merge_base", git("merge-base", `origin/${baseRef}`, "HEAD"));

  // The checkout's refs date from the start of the run; refresh so a record the
  // previous run persisted minutes ago is visible. Absence tolerated: no ref
  // means no prior record, which resolves to a full review, never a halt.
  gitOk("fetch", "origin", "ci/review-metrics") || warn("could not fetch ci/review-metrics; resolving mode as full");
  let records = priorRecords(prNumber);
  if (records.length === 0 && trigger === "synchronize") {
    // A queued synchronize run can start while the prior run's persist-metrics
    // job is still writing its record; one short retry covers the race.
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    gitOk("fetch", "origin", "ci/review-metrics");
    records = priorRecords(prNumber);
  }

  const prior = newestCleanRecord(records);
  const priorSha = prior?.commit_sha ?? null;
  let hasMerges = false;
  if (priorSha !== null) {
    try {
      hasMerges = git("rev-list", `${priorSha}..HEAD`, "--merges").length > 0;
    } catch {
      hasMerges = true; // unknown prior object; resolves to full below
    }
  }
  const isAncestor = priorSha !== null && gitOk("merge-base", "--is-ancestor", priorSha, "HEAD");
  let isCommentOnly = false;
  if (priorSha !== null && isAncestor && !hasMerges) {
    try {
      // `--ignore-submodules=none` overrides an `ignore = all` the PR's own
      // `.gitmodules` could set to hide a gitlink bump from the listing.
      const raw = execFileSync(
        "git",
        ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--ignore-submodules=none", priorSha, "HEAD"],
        { encoding: "utf8" },
      );
      // Fatal decoding: two invalid byte runs must not both read as U+FFFD.
      const utf8 = new TextDecoder("utf-8", { fatal: true });
      isCommentOnly = isCommentOnlyDelta(parseRawDiff(raw), (sha) =>
        utf8.decode(execFileSync("git", ["cat-file", "blob", sha])),
      );
    } catch {
      isCommentOnly = false; // an unreadable delta is reviewed, never skipped
    }
  }
  const decision = decideMode({ prior, headSha, trigger, forceFull, isAncestor, hasMerges, isCommentOnly });

  if (decision.kind === "skip-duplicate") {
    process.stdout.write(`::notice::head ${headSha} already reviewed (${decision.priorPath}); nothing new to review\n`);
    out("skip", "true");
    return;
  }
  if (decision.kind === "skip-comment-only") {
    process.stdout.write(
      `::notice::only comments and prose changed since ${priorSha} (${decision.priorPath}); the next code push reviews them\n`,
    );
    // Pending, not green, on the PR at this head, so a merge here is not read as
    // reviewed; nothing requires the check, so it never blocks the merge.
    markNotReviewed(headSha, `Not reviewed: only comments and prose changed since ${priorSha?.slice(0, 7)}`);
    out("skip", "true");
    return;
  }
  out(
    "mode_line",
    decision.kind === "incremental"
      ? `Mode: incremental from ${decision.fromSha} (prior record: ${decision.priorPath} on ${METRICS_REF})`
      : "Mode: full",
  );
}

// ESM-native `require.main === module`; keeps unit-test imports side-effect free.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
