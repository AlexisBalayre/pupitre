import { Box, Text } from 'ink';
import type { ControlPrompt } from './use-controls.hook.js';
import { wrapLines } from './viewport.utils.js';

const CONFIRM_HINT = ' (y/n, Esc cancels)';

/**
 * A y/n question as the rows it takes at `width`, and whether the hint fits on
 * the last of them. The question is wrapped, not truncated: `u` asks with the
 * stored block reason, which nothing else on screen shows, and an operator
 * cannot answer a question whose end was cut off (decision 121).
 */
function confirmLayout(question: string, width: number) {
  const lines = wrapLines(question, width);
  const hintInline = (lines.at(-1) ?? '').length + CONFIRM_HINT.length <= width;
  return { lines, hintInline };
}

/** The rows `Prompt` draws at `width`, for `App` to count. */
export function promptLines(prompt: ControlPrompt, width: number): number {
  if (prompt.kind !== 'confirm') return 1;
  const { lines, hintInline } = confirmLayout(prompt.question, width);
  return lines.length + (hintInline ? 0 : 1);
}

/**
 * The line a key opens when it needs an answer: a y/n question, or a field
 * to type into. Both are drawn here because both are the same thing on screen —
 * the row of the table that has stopped being a table and is waiting for the
 * operator — and because the controls hook already decides which one a key
 * asks for. Nothing is decided here; the value shown is the value the hook
 * holds, keystroke by keystroke.
 */
export function Prompt({ prompt, width }: { prompt: ControlPrompt; width: number }) {
  if (prompt.kind === 'confirm') {
    const { lines, hintInline } = confirmLayout(prompt.question, width);
    return (
      <Box flexDirection="column">
        {lines.map((line, index) => (
          // Each row is truncated so a character wider than the count above
          // cannot wrap into a row `App` did not leave room for.
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one string, in order
          <Text key={index} wrap="truncate-end">
            <Text color="yellow">{line}</Text>
            {hintInline && index === lines.length - 1 ? <Text dimColor>{CONFIRM_HINT}</Text> : null}
          </Text>
        ))}
        {hintInline ? null : (
          <Text dimColor wrap="truncate-end">
            {CONFIRM_HINT.trim()}
          </Text>
        )}
      </Box>
    );
  }
  return (
    <Text wrap="truncate-start">
      <Text color="cyan">{prompt.label}: </Text>
      {/* The block is the cursor: Ink draws no caret of its own, and a field
          with no visible end looks like a screen that has stopped responding. */}
      <Text>{prompt.value}</Text>
      <Text inverse> </Text>
      <Text dimColor> (Enter sends, Esc cancels)</Text>
    </Text>
  );
}
