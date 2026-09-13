import { Box, Text } from 'ink';
import type { MergeLog } from './use-controls.hook.js';

/**
 * What the merge child is printing, as it prints it. The gate is minutes of
 * clone, install, build, test and audit, and the operator watching it wants to
 * know which stage it is on — not to learn at the end which one it stopped at.
 * The lines are the child's stdout and stderr, already sanitized where they
 * were read (decision 29); this draws them and nothing else.
 */
export function MergeLogPane({ log }: { log: MergeLog }) {
  // The child's output carries no ids and repeats lines freely — two stages can
  // both print `ok` — so a line is keyed by where it sits in everything the
  // child has written, which does not shift when the tail scrolls off the top.
  const numbered = log.lines.map((line, index) => ({ ordinal: log.firstLine + index, line }));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={log.running ? 'cyan' : 'gray'}>
      <Text bold>
        pup merge {log.sessionId} --pr{' '}
        <Text dimColor>{log.running ? '(running)' : '(done — Enter or Esc closes)'}</Text>
      </Text>
      {log.lines.length === 0 ? <Text dimColor>waiting for the first stage …</Text> : null}
      {numbered.map(({ ordinal, line }) => (
        <Text key={ordinal} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
