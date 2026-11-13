import { join } from "node:path";
import { type PriorImportant, type PriorReview, priorReviewSchema, type PriorVerdict } from "./review-metrics.schemas";

/**
 * The prior review record a round carries its open importants from. The
 * preflight leaves the record it chose in the job's temp directory; the poster
 * and the metrics step rebuild each carried important from that record's own
 * finding, so the bullet the poster writes is the text the prior round posted,
 * never the model's copy of it. The model only says which entries the head
 * resolves.
 */

/** Where the preflight leaves the prior record: the job's temp directory, which every later step of the review job reads. */
export function priorRecordPath(env: NodeJS.ProcessEnv): string {
  return env.REVIEW_PRIOR_RECORD ?? join(env.RUNNER_TEMP ?? ".", "prior-record.json");
}

/** The prior record's carried fields, or null when there is no record or it does not parse. */
export function parsePriorReview(raw: string | null): PriorReview | null {
  if (raw === null) return null;
  try {
    const result = priorReviewSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Every important the prior record owes this round, named from the record: its
 * own importants, then the unresolved entries it carried. An entry stays
 * unresolved unless the model's verdicts mark it resolved and none marks it
 * unresolved, so a verdict the model left out or misnumbered keeps the
 * important open rather than dropping it.
 */
export function priorImportants(record: PriorReview | null, verdicts: PriorVerdict[]): PriorImportant[] {
  if (record === null) return [];
  const owed = [
    ...(record.findings ?? []).map((finding, index) => ({
      from: "findings" as const,
      index,
      entry: finding,
      open: finding.tag === "important",
    })),
    ...(record.prior_importants ?? []).map((prior, index) => ({
      from: "prior_importants" as const,
      index,
      entry: prior,
      open: prior.status === "unresolved",
    })),
  ].filter(({ open }) => open);
  return owed.map(({ from, index, entry }) => {
    const said = verdicts.filter((verdict) => verdict.from === from && verdict.index === index);
    const resolved = said.length > 0 && said.every((verdict) => verdict.status === "resolved");
    return {
      file: entry.file,
      line: entry.line,
      description: entry.description,
      status: resolved ? "resolved" : "unresolved",
    };
  });
}
