import { Box, Text } from 'ink';
import type { ControlStatus } from './use-controls.hook.js';

/**
 * What the last key did, and what the operator may press next. The status line
 * is where every action's result lands — the session it launched, the PR it
 * opened, the refusal it got — because an action taken on a row three lines up
 * leaves nothing on that row to read, and a screen that changes silently is a
 * screen nobody trusts.
 *
 * `readOnlyReason` is the caller's ruling, not this component's: a session or
 * the conductor gets the dashboard and no controls (decision 47), and is told
 * why rather than left to press keys that do nothing.
 */
export function Footer({
  refreshedAt,
  status,
  readOnlyReason,
}: {
  refreshedAt: string;
  status?: ControlStatus;
  readOnlyReason?: string;
}) {
  return (
    <Box flexDirection="column">
      {status ? (
        <Text color={status.failed ? 'red' : 'green'} wrap="truncate-end">
          {status.message}
        </Text>
      ) : null}
      {readOnlyReason ? <Text color="yellow">{readOnlyReason}</Text> : null}
      {/* Two lines rather than one: the whole set does not fit an eighty-column
          terminal, and a hint line that truncates hides the keys at its end. */}
      {readOnlyReason ? null : (
        <Text dimColor wrap="truncate-end">
          l launch s steer i interrupt k kill u unblock R respawn m merge a attach
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        ↑/↓ select Enter/Esc detail {readOnlyReason ? '' : 'A conductor c on/off '}r refresh q quit
        · {refreshedAt}
      </Text>
    </Box>
  );
}
