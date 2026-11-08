import type { Finding, ReviewerArea, ReviewSummary } from "./review-metrics.schemas";

/**
 * The mechanical half of consolidation: findings that sit on the same spot of
 * the same file and say the same thing are one finding, however many reviewers
 * raised it. The semantic half (one root cause on different lines or in
 * different files) is the `review-consolidator` agent's, which runs before
 * validation; this pass only catches what that one left, so the author never
 * reads the same concern twice.
 */

// Citation-first, as the orchestrator assigns an area: a finding resting on a
// spec requirement is spec's, a defect the code alone proves is security's or
// correctness's, and prose and structure are the leftovers.
const SPECIFICITY: readonly ReviewerArea[] = [
  "spec",
  "security",
  "correctness",
  "conventions",
  "docs",
  "context",
  "maintainability",
];

const SEVERITY: Record<Finding["tag"], number> = { important: 0, nit: 1, "pre-existing": 2 };

// Two reviewers rarely anchor the same concern on the same line; a few lines
// apart is still the same spot for minors. Importants need the same line.
const NEAR_LINES = 3;

// Word overlap above which two descriptions of one spot are one concern. Below
// it they stay apart: a missed merge costs the author a line, a wrong one hides
// a finding.
const SIMILARITY = 0.6;

function startLine(line: string | null): number | null {
  const match = line?.match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function overlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

function sameConcern(a: Finding, b: Finding): boolean {
  if (a.file === null || a.file !== b.file) return false;
  const lineA = startLine(a.line);
  const lineB = startLine(b.line);
  // A line-less finding is near only another line-less one: "near everything" chains clusters.
  const nearby = lineA === null || lineB === null ? lineA === lineB : Math.abs(lineA - lineB) <= NEAR_LINES;
  return nearby && overlap(a.description, b.description) >= SIMILARITY;
}

// A confirmed important folded away is never commented, so an important joins a cluster that
// already holds one only on the very same spot with the very same text. Word overlap cannot say
// that: it drops short tokens ("id" and "ip" look alike) and ignores order.
function sameImportant(a: Finding, b: Finding): boolean {
  return a.file === b.file && startLine(a.line) === startLine(b.line) && normalized(a.description) === normalized(b.description);
}

function joins(cluster: Finding[], finding: Finding): boolean {
  const [anchor] = cluster;
  if (!anchor || !sameConcern(anchor, finding)) return false;
  if (finding.tag !== "important") return true;
  return cluster.every((member) => member.tag !== "important" || sameImportant(member, finding));
}

// Most severe tag first, then the more certain, then the more specific area:
// the survivor keeps its own description byte for byte, because rewriting prose
// is where line anchors get lost.
function outranks(a: Finding, b: Finding): boolean {
  if (SEVERITY[a.tag] !== SEVERITY[b.tag]) return SEVERITY[a.tag] < SEVERITY[b.tag];
  if (a.confidence !== b.confidence) return a.confidence === "high";
  return SPECIFICITY.indexOf(a.area) < SPECIFICITY.indexOf(b.area);
}

function mostSpecific(areas: ReviewerArea[]): ReviewerArea {
  return areas.reduce((best, area) => (SPECIFICITY.indexOf(area) < SPECIFICITY.indexOf(best) ? area : best));
}

export interface Consolidated {
  findings: Finding[];
  /** How many findings the merge dropped: the input count minus the output count. */
  merged: number;
}

export function consolidateFindings(findings: Finding[]): Consolidated {
  const clusters: Finding[][] = [];
  for (const finding of findings) {
    const home = clusters.find((cluster) => joins(cluster, finding));
    if (home) home.push(finding);
    else clusters.push([finding]);
  }
  const survivors = clusters.map((cluster) => {
    const survivor = cluster.reduce((best, member) => (outranks(member, best) ? member : best));
    const body = survivor.body ?? cluster.find((member) => member.tag === survivor.tag && member.body)?.body ?? null;
    return { ...survivor, area: mostSpecific(cluster.map((member) => member.area)), body };
  });
  // Stable: findings of one severity keep the order their reviewers returned them in.
  survivors.sort((a, b) => SEVERITY[a.tag] - SEVERITY[b.tag]);
  return { findings: survivors, merged: findings.length - survivors.length };
}

/** The poster and the metrics step both read the summary through this, so the PR and the record agree on the findings. */
export function consolidateSummary(summary: ReviewSummary): { summary: ReviewSummary; merged: number } {
  const { findings, merged } = consolidateFindings(summary.findings);
  return { summary: { ...summary, findings }, merged: merged + (summary.merged_duplicates ?? 0) };
}
