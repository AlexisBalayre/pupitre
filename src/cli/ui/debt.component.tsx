import { Box, Text } from 'ink';
import type { DashboardSnapshot } from '../../core/types/dashboard.types.js';

/**
 * The ledger's overdue entries, each with the condition someone accepted it
 * under (docs/04), and the open count behind them. Overdue debt is the one
 * section that is loud whenever it has anything at all: an entry whose
 * review-by has passed is a promise the project has already broken.
 */
export function Debt({
  overdueDebt,
  openDebtCount,
}: {
  overdueDebt: DashboardSnapshot['overdueDebt'];
  openDebtCount: number;
}) {
  if (overdueDebt.length === 0 && openDebtCount === 0) return null;
  return (
    <Box flexDirection="column">
      {overdueDebt.map((entry) => (
        // One template for the reason the radar's line is one: Ink collapses
        // the whitespace between JSX children, and these are columns.
        <Text key={entry.id} wrap="truncate-end" color="red">
          {`OVERDUE DEBT #${entry.id}  ${entry.description}  (review by: ${entry.reviewBy})`}
        </Text>
      ))}
      <Text dimColor>
        {`${openDebtCount} open debt ${openDebtCount === 1 ? 'entry' : 'entries'}`}
      </Text>
    </Box>
  );
}
