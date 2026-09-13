import { Text } from 'ink';

/**
 * What the operator may press. Every key here only moves the cursor or re-reads
 * the store: `pup ui` shows the fleet and changes nothing about it, and the
 * hints say so rather than leaving the absence to be discovered (decision 52).
 */
export function Footer({ refreshedAt }: { refreshedAt: string }) {
  return <Text dimColor>↑/↓ or j/k select r refresh q quit · read-only · {refreshedAt}</Text>;
}
