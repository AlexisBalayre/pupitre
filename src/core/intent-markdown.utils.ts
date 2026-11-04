/**
 * An intent's Markdown as a reader of the rendered file sees it (decision
 * 126): what a code fence or an HTML comment hides is never structure, and
 * the understanding section's questions are read from what is shown.
 */

/** The heading whose questions `acceptIntent` counts, matched case-insensitively. */
export const UNDERSTANDING_HEADING = 'What I must understand after review';

export const SECTION_HEADING = /^ {0,3}## (.*)$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|[0-9]{1,9}[.)])[ \t]+(.*)$/;

// FENCE_OPEN and FENCE_CLOSE are copies of brief.service.ts's, until a task shares them.

/** Code fences, as the brief reads them: a heading or a list item inside one is text. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** An HTML comment block opens on a line starting `<!--` and runs to the first line holding `-->`. */
const COMMENT_OPEN = /^ {0,3}<!--/;

/**
 * Each line as the rendered file shows it as Markdown, or undefined inside a
 * code fence or an HTML comment block, which render as code or not at all.
 * Indexes match `lines`. A heading, a list item or a status line in either is
 * text, never structure, so nothing there can say what the reader cannot see.
 */
export function visibleLines(lines: string[]): (string | undefined)[] {
  let fence: string | undefined;
  let comment = false;
  return lines.map((line) => {
    if (comment) {
      comment = !line.includes('-->');
      return undefined;
    }
    if (fence !== undefined) {
      const closer = FENCE_CLOSE.exec(line)?.[1];
      if (closer && closer[0] === fence[0] && closer.length >= fence.length) fence = undefined;
      return undefined;
    }
    const opener = FENCE_OPEN.exec(line)?.[1];
    if (opener) {
      fence = opener;
      return undefined;
    }
    if (COMMENT_OPEN.test(line)) {
      comment = !line.slice(line.indexOf('<!--') + 4).includes('-->');
      return undefined;
    }
    return line;
  });
}

/**
 * The list items ending in `?` under the first understanding heading, up to
 * the next level-2 heading, among the lines `visibleLines` shows: an example
 * in a fence or a comment neither opens the section nor counts as a question.
 */
export function understandingQuestions(visible: (string | undefined)[]): string[] {
  const questions: string[] = [];
  let inSection = false;
  for (const line of visible) {
    if (line === undefined) continue;
    const heading = SECTION_HEADING.exec(line)?.[1];
    if (heading !== undefined) {
      if (inSection) break;
      inSection = heading.trim().toLowerCase() === UNDERSTANDING_HEADING.toLowerCase();
      continue;
    }
    const item = inSection ? LIST_ITEM.exec(line)?.[1]?.trim() : undefined;
    if (item?.endsWith('?')) questions.push(item);
  }
  return questions;
}
