import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { projectPaths } from './paths.utils.js';
import { InvalidProfileError } from './profile.errors.js';

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

/**
 * A brief longer than this is refused rather than compiled. The number is a
 * guard rail, not a budget: the context budget already caps the compiled
 * result, but it fails as `ContextBudgetExceededError` naming a token count,
 * which reads as "your task spec is too long" and sends the operator to the
 * wrong file. Refusing here names the brief.
 */
export const BRIEF_MAX_CHARS = 8000;

/**
 * C0 and C1 control characters, keeping only newline and tab. Every reader goes
 * through `readBrief` — `pup brief show` prints it to a terminal, and the
 * kickoff pastes it into tmux — so an escape sequence, a bracketed-paste
 * terminator or a bare carriage return written into the file would repaint the
 * operator's terminal or cut the paste short (decision 29's shape). Stripped
 * rather than escaped, and not with `sanitizeReason`, which collapses the
 * whitespace that a Markdown document is structured by.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * An opening code fence, with CommonMark's three spaces of slack. Captures the
 * run so a closing fence can be matched to the one that opened. An opener may
 * carry an info string after the run; a closer may not, so `~~~ end of example`
 * is fence content and the fence stays open past it.
 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * A level-2 ATX heading, which is the only structure the brief has, with the
 * three spaces of indent CommonMark allows. `###` and deeper do not match, and
 * a closed heading (`## Constraints ##`) yields the same title as an open one:
 * CommonMark treats both as the same heading, and an operator whose
 * constraints reached no session because they typed the closing run or
 * indented the line would have no way to see why.
 */
const SECTION_HEADING = /^ {0,3}##(?:[ \t]+(.*?)(?:[ \t]+#+)?)?[ \t]*$/;

/** Absolute path of the project's brief, whether or not it exists yet. */
export function briefPath(repoPath: string): string {
  return projectPaths(repoPath).briefFile;
}

/**
 * The brief as the operator wrote it, stripped of control characters, or
 * undefined when the project has none — which is also what a file holding only
 * whitespace is. A project with no brief compiles exactly as it did before
 * there were briefs, so `undefined` has to cover "never created" and "emptied
 * out" alike.
 *
 * The one door: both compilers and `pup brief show` read the brief through
 * here, so the sanitizing and the cap are applied once and cannot be walked
 * around by a later reader. What this returns is also what is hashed, so the
 * hash covers the text that was actually used.
 */
export function readBrief(repoPath: string): string | undefined {
  const path = briefPath(repoPath);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8').replace(CONTROL_CHARS, '');
  if (text.length > BRIEF_MAX_CHARS) {
    // Measured after stripping, which is the text every reader would get.
    throw new InvalidProfileError(
      `The project brief at ${path} is ${text.length} characters, over the ` +
        `${BRIEF_MAX_CHARS} a brief may carry. Shorten it with \`pup brief edit\`.`,
    );
  }
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
 *
 * Headings inside a fenced code block are text, not headings. A line-based
 * split without that saw `## Destination` in a fenced example under Priorities
 * and started a section there, which put the rest of the Priorities in front of
 * every session. An unclosed fence swallows the rest of the file, which is
 * CommonMark's reading and the safe direction: it carries less, never more.
 */
function sections(brief: string): BriefSection[] {
  const found: { heading: string; lines: string[] }[] = [];
  let fence: string | undefined;
  for (const line of brief.split('\n')) {
    if (fence !== undefined) {
      // Closed only by a run of the same character, at least as long.
      const closer = FENCE_CLOSE.exec(line)?.[1];
      if (closer && closer[0] === fence[0] && closer.length >= fence.length) fence = undefined;
      found.at(-1)?.lines.push(line);
      continue;
    }
    const opener = FENCE_OPEN.exec(line)?.[1];
    if (opener) {
      fence = opener;
      found.at(-1)?.lines.push(line);
      continue;
    }
    const match = SECTION_HEADING.exec(line);
    // A heading with no title still opens a section, so what follows it cannot
    // fall back into the section above and reach a reader that one was meant for.
    if (match) found.push({ heading: match[1] ?? '', lines: [] });
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
