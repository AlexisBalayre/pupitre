import { Text } from 'ink';
import type { ControlPrompt } from './use-controls.hook.js';

/**
 * The one line a key opens when it needs an answer: a y/n question, or a field
 * to type into. Both are drawn here because both are the same thing on screen —
 * the row of the table that has stopped being a table and is waiting for the
 * operator — and because the controls hook already decides which one a key
 * asks for. Nothing is decided here; the value shown is the value the hook
 * holds, keystroke by keystroke.
 */
export function Prompt({ prompt }: { prompt: ControlPrompt }) {
  if (prompt.kind === 'confirm') {
    return (
      <Text>
        <Text color="yellow">{prompt.question}</Text>
        <Text dimColor> (y/n, Esc cancels)</Text>
      </Text>
    );
  }
  return (
    <Text>
      <Text color="cyan">{prompt.label}: </Text>
      {/* The block is the cursor: Ink draws no caret of its own, and a field
          with no visible end looks like a screen that has stopped responding. */}
      <Text>{prompt.value}</Text>
      <Text inverse> </Text>
      <Text dimColor> (Enter sends, Esc cancels)</Text>
    </Text>
  );
}
