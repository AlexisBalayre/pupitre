/**
 * Pure parsers over `tmux capture-pane` text. Transport-level heuristics only —
 * session STATE must come from hooks/transcripts (decision 2), but verifying
 * that a paste physically reached the input box is a transport concern.
 */

const INPUT_PROMPT = /^❯(.*)$/;
/** Empty input box renders a dimmed hint (`❯ Try "…"`), not user text. */
const PLACEHOLDER_PREFIX = /^Try "/;

/**
 * True when the input box still holds unsubmitted text. The prompt `❯` renders
 * at column 0; dialog selectors and history lines are indented, so only
 * column-0 matches count. Verified against Claude Code 2.1.218 panes.
 */
export function hasUnsubmittedInput(pane: string): boolean {
  const promptLines = pane.split('\n').filter((line) => INPUT_PROMPT.test(line));
  const last = promptLines.at(-1);
  if (last === undefined) return false;
  const content = (INPUT_PROMPT.exec(last)?.[1] ?? '').trim();
  return content.length > 0 && !PLACEHOLDER_PREFIX.test(content);
}
