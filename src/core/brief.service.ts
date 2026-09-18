import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { projectPaths } from './paths.utils.js';

/**
 * The project brief: the operator's direction, written once and carried into
 * the conductor and every session launched afterwards (decision 57). Free
 * Markdown — pup reads no meaning out of it and stores nothing from it. The
 * three headings are the only structure it knows, and they exist to split the
 * file in one place: Destination and Constraints are what a session is given,
 * Priorities are the conductor's alone.
 */
export const BRIEF_TEMPLATE = `<!-- The project brief. Free Markdown: pup never interprets what you
write here, it only splits the file at the three headings below. Destination and
Constraints reach every session's context; Priorities reach the conductor only.
An edit takes effect at the next launch and the next conductor start, never in a window
that is already running. -->

## Destination

## Constraints

## Priorities
`;

/** The headings a session is given, lowercased — everything else is the conductor's. */
const WORKER_HEADINGS = ['destination', 'constraints'];

/** Absolute path of the project's brief, whether or not it exists yet. */
export function briefPath(repoPath: string): string {
  return projectPaths(repoPath).briefFile;
}

/**
 * The brief as the operator wrote it, or undefined when the project has none —
 * which is also what a file holding only whitespace is. A project with no brief
 * compiles exactly as it did before there were briefs, so `undefined` has to
 * cover "never created" and "emptied out" alike.
 */
export function readBrief(repoPath: string): string | undefined {
  const path = briefPath(repoPath);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  return text.trim() ? text : undefined;
}

/**
 * The brief `pup brief edit` opens, created from the template on first use.
 * Reports whether it had to create it, so the command can say so.
 */
export function ensureBrief(repoPath: string): { path: string; created: boolean } {
  const path = briefPath(repoPath);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, BRIEF_TEMPLATE);
  return { path, created: true };
}

interface BriefSection {
  heading: string;
  body: string;
}

/**
 * Split the brief at its level-2 headings. `###` and deeper stay inside the
 * section they were written under, and anything before the first `##` — the
 * template's comment, a title the operator added — belongs to no section and
 * is dropped by every caller that slices.
 */
function sections(brief: string): BriefSection[] {
  const found: { heading: string; lines: string[] }[] = [];
  for (const line of brief.split('\n')) {
    const match = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (match?.[1]) found.push({ heading: match[1], lines: [] });
    else found.at(-1)?.lines.push(line);
  }
  return found.map(({ heading, lines }) => ({ heading, body: lines.join('\n').trim() }));
}

/**
 * The slice of the brief a session is given, demoted one level so it nests
 * under the context's own `## Project brief`. Undefined when neither heading
 * carries anything: a brief still on its template is direction nobody wrote,
 * and it must not turn into a section of empty headings in every kickoff.
 */
export function workerBrief(brief: string): string | undefined {
  const kept = sections(brief).filter(
    (section) => WORKER_HEADINGS.includes(section.heading.toLowerCase()) && section.body,
  );
  if (kept.length === 0) return undefined;
  return kept.map((section) => `### ${section.heading}\n${section.body}`).join('\n\n');
}
