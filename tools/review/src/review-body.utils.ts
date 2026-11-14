import { type Finding, REVIEWER_AREAS, type RefutedFinding, type ReviewSummary } from "./review-metrics.schemas";

/**
 * Renders what the poster submits: the review body, and the line comment for
 * each important anchored inline on the diff. Everything else the run
 * confirmed, and everything validation refuted, renders in the body in
 * collapsed sections, so severity decides how loudly a finding is displayed.
 * Only the minors are capped (`MINOR_CAP`), and the body says how many it held
 * back, so a long tail of nits cannot keep a PR in review.
 */

export const MINOR_CAP = 5;

/** First line of every review body the poster writes, which tells its summary reviews from the empty ones GitHub wraps around standalone line comments. */
export const REVIEW_HEADING = "## Claude code review";

type Listed = Pick<Finding, "file" | "line" | "area" | "description"> & { body?: string | null };

export function findingLine(finding: Listed): string {
  const location = finding.file
    ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\``
    : "location unrecorded";
  return `- ${location} (${finding.area}): ${finding.body ?? finding.description}`;
}

function isPlainLanguage(info: string): boolean {
  const language = info.trim();
  return /^[\w+#.-]*$/.test(language) && !/^suggestion/i.test(language);
}

// GitHub turns a block whose language is `suggestion` into a "Commit suggestion"
// button in a line comment, and a finding's text can quote what a PR or issue
// author wrote. GitHub decodes the info string first (`&#115;uggestion` counts)
// and opens a fence after any container prefix, so a fence opener whose language
// is not a plain token, or starts with `suggestion`, gets `text` as its language.
// A raw `<pre lang="suggestion">` renders the same block. Only a full parser
// knows where that tag ends inside markdown, but its name follows `<` directly,
// so a zero-width space there stops it opening and the text reads as it did.
function inertFences(markdown: string): string {
  return markdown
    .replace(
      // A label ends at its first unescaped `]`, so a line of labels splits only
      // one way; a lazy `.*?` would backtrack exponentially on `[^a]:[^a]:...`.
      /^((?:[^\S\r\n]*(?:>|[-+*]|\d{1,9}[.)]|\[\^(?:\\.|[^\]\\\r\n])*\]:))*[^\S\r\n]*)(`{3,}|~{3,})(.*)$/gm,
      (match, prefix: string, fence: string, info: string) =>
        // A backtick in a backtick fence's info string makes it inline code.
        isPlainLanguage(info) || (fence.startsWith("`") && info.includes("`"))
          ? match
          : `${prefix}${fence}text ${info}`,
    )
    .replace(/<(?=pre\b)/gi, "<\u200b");
}

/**
 * The hidden last line of every line comment: the important the thread holds.
 * pr-status.yml leaves a carried important to the thread whose marker names its
 * file and whole line range, and its description in the same letters and digits,
 * as its bullet does: an earlier finding's thread at the same lines holds no other.
 * `<` and `>` are escaped, so no text can end the comment early.
 */
export function importantMarker(finding: Pick<Finding, "file" | "line" | "description">): string {
  const held = JSON.stringify([finding.file, finding.line, finding.description]);
  return `<!-- important ${held.replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
}

export function commentBody(finding: Finding, relocatedFrom: number | null): string {
  const parts: string[] = [];
  if (relocatedFrom !== null) parts.push(inertFences(`Re: \`${finding.file}:${relocatedFrom}\``), "");
  parts.push(inertFences(finding.body ?? finding.description));
  if (finding.suggestion !== null) {
    // Longer than any backtick run in the suggestion, so its code can never
    // close the fence early and is posted exactly as written.
    const runs = finding.suggestion.match(/`+/g) ?? [];
    const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
    // A committable suggestion rewrites the line it is attached to, so on a
    // relocated anchor it would replace code the finding never mentioned. Same
    // text, inert fence.
    parts.push("", relocatedFrom === null ? `${fence}suggestion` : fence, finding.suggestion, fence);
  }
  parts.push("", importantMarker(finding));
  return parts.join("\n");
}

function refutedLine(finding: RefutedFinding): string {
  return `${findingLine(finding)}\n  - refuted: ${finding.refutation}`;
}

function detailsBlock(label: string, lines: string[]): string[] {
  return ["", "<details>", `<summary>${label}</summary>`, "", ...lines, "", "</details>"];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function collapsedSections(summary: ReviewSummary): string[] {
  const nits = summary.findings.filter((finding) => finding.tag === "nit");
  const preExisting = summary.findings.filter((finding) => finding.tag === "pre-existing");
  // Nits fill the cap first: they are what this diff introduced, pre-existing issues are not.
  const shownNits = nits.slice(0, MINOR_CAP);
  const shownPreExisting = preExisting.slice(0, MINOR_CAP - shownNits.length);
  const heldBack = nits.length + preExisting.length - shownNits.length - shownPreExisting.length;
  const sections: string[] = [];
  if (nits.length > 0) {
    // description, not body: sub-important findings carry no body by contract.
    sections.push(...detailsBlock(`${plural(nits.length, "minor issue")} (not blocking)`, shownNits.map(findingLine)));
  }
  if (shownPreExisting.length > 0) {
    sections.push(
      ...detailsBlock(
        `${plural(preExisting.length, "pre-existing issue")} (predate this diff)`,
        shownPreExisting.map(findingLine),
      ),
    );
  }
  if (heldBack > 0) {
    sections.push("", `${plural(heldBack, "more minor issue")} held back (the review lists at most ${MINOR_CAP}).`);
  }
  if (summary.refuted_findings.length > 0) {
    // Displayed so a validator that over-killed a real finding is catchable by
    // the one reader who can tell: nothing else surfaces that failure mode.
    sections.push(
      ...detailsBlock(
        `${plural(summary.refuted_findings.length, "finding")} refuted by validation`,
        summary.refuted_findings.map(refutedLine),
      ),
    );
  }
  return sections;
}

/**
 * The prior round's importants this head still has open. A round's delta can be
 * clean while one of them is still owed, so the body names them: otherwise a clean
 * incremental round reads as "nothing left to fix".
 */
export function unresolvedPrior(summary: ReviewSummary): ReviewSummary["prior_importants"] {
  return summary.prior_importants.filter((prior) => prior.status === "unresolved");
}

function carriedLines(summary: ReviewSummary): string[] {
  const open = unresolvedPrior(summary);
  if (open.length === 0) return [];
  const sha = summary.incremental_from_sha?.slice(0, 7);
  return [
    `${plural(open.length, "important finding")} from ${sha ? `the review of ${sha}` : "the prior review"} still open (not raised again):`,
    "",
    // One line per bullet: pr-status.yml parses the block by counting its lines.
    ...open.map((prior) =>
      findingLine({ ...prior, description: prior.description.replace(/\s*[\r\n]+\s*/g, " "), area: "correctness", body: null }),
    ),
  ];
}

function issueLines(summary: ReviewSummary | null): string[] {
  return (summary?.process_issues ?? []).map((issue) => `- **${issue.component}**: ${issue.description}`);
}

/** `noVerdict` is `noVerdictReason`'s answer for the round: the one rule for whether this body may read as a review. */
export function bodyLines(
  summary: ReviewSummary | null,
  noVerdict: string | null,
  unanchored: Finding[],
  anchoredCount: number,
): string[] {
  if (noVerdict !== null || summary === null) {
    const blockers = issueLines(summary);
    return [
      `**${noVerdict ?? "Not reviewed"}.** Nothing in this round is a verdict on the diff.`,
      ...(blockers.length ? ["", "What stopped it:", "", ...blockers] : []),
      "",
      "Comment `@claude review` to run it again.",
    ];
  }

  if (summary.reviewers_spawned.length === 0) {
    const notes = issueLines(summary);
    const since = summary.incremental_from_sha?.slice(0, 7) ?? "the prior review";
    const carried = carriedLines(summary);
    return [
      `No reviewer was spawned for the changes since ${since}.`,
      ...(carried.length ? ["", ...carried] : []),
      ...(notes.length ? ["", ...notes] : []),
    ];
  }

  const spawned = [...new Set(summary.reviewers_spawned)];
  // spec and workflow-safety run only when the PR gives them something to read, so their absence is no gap to report.
  const skipped = REVIEWER_AREAS.filter(
    (area) => !spawned.includes(area) && area !== "spec" && area !== "workflow-safety",
  );
  const coverage = `Checked ${spawned.join(", ")}.${skipped.length ? ` Skipped ${skipped.join(", ")}.` : ""}`;
  const scope =
    summary.review_mode === "incremental" && summary.incremental_from_sha
      ? `Incremental review of the changes since ${summary.incremental_from_sha.slice(0, 7)}. `
      : "";

  const sections = collapsedSections(summary);
  const carried = carriedLines(summary);
  if (anchoredCount === 0 && unanchored.length === 0 && sections.length === 0 && carried.length === 0) {
    return [`No issues found. ${scope}${coverage}`];
  }

  const lines: string[] = [];
  if (anchoredCount > 0) {
    lines.push(`${plural(anchoredCount, "important finding")} on the diff below.`);
  }
  if (unanchored.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${plural(unanchored.length, "important finding")} with no line in this diff to anchor to:`,
      "",
      ...unanchored.map(findingLine),
    );
  }
  if (carried.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...carried);
  }
  if (lines.length === 0) lines.push("No blocking issues found.");
  return [...lines, ...sections, "", `${scope}${coverage}`];
}
