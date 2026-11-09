/**
 * What `pr-status.yml` reads from the poster's summary review. That workflow
 * loads this file with node's own type stripping, outside any install, so it
 * imports nothing and uses only erasable TypeScript.
 */

/** First line of every review body the poster writes, which tells its summary reviews from the empty ones GitHub wraps around standalone line comments. */
export const REVIEW_HEADING = "## Claude code review";

/**
 * The importants a summary review lists with no inline thread to resolve: the
 * round's findings with no line in the diff to anchor to, and the prior round's
 * still open. Each list opens with a count line `bodyLines` writes. A finding's
 * text that passed for one could only hold a PR in review, never clear it.
 */
const UNTHREADED = /^(\d+) important findings? (?:with no line in this diff to anchor to|from .+ still open \(not raised again\)):$/;

export function unthreadedImportants(body: string): number {
  return body
    .split(/\r?\n/)
    .reduce((sum, line) => sum + Number(UNTHREADED.exec(line)?.[1] ?? 0), 0);
}
