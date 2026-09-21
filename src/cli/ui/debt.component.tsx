import { Box, Text } from 'ink';
import type { DashboardSnapshot } from '../../core/types/dashboard.types.js';

/**
 * The ledger's overdue entries, each with the condition someone accepted it
 * under (docs/04), and the open count behind them. Overdue debt is the one
 * section that is loud whenever it has anything at all: an entry whose
 * review-by has passed is a promise the project has already broken. Over a
 * fleet each project's ledger is drawn apart, every line led by its project id:
 * entry numbers are per store, and `#8` alone would name two debts (decision 61).
 */
export function Debt({
  overdueDebt,
  openDebtCount,
  project,
}: {
  overdueDebt: DashboardSnapshot['overdueDebt'];
  openDebtCount: number;
  project?: string;
}) {
  if (overdueDebt.length === 0 && openDebtCount === 0) return null;
  const lead = project === undefined ? '' : `${project}  `;
  return (
    <Box flexDirection="column">
      {overdueDebt.map((entry) => (
        // One template for the reason the radar's line is one: Ink collapses
        // the whitespace between JSX children, and these are columns.
        <Text key={entry.id} wrap="truncate-end" color="red">
          {`${lead}OVERDUE DEBT #${entry.id}  ${entry.description}  (review by: ${entry.reviewBy})`}
        </Text>
      ))}
      <Text dimColor>
        {`${lead}${openDebtCount} open debt ${openDebtCount === 1 ? 'entry' : 'entries'}`}
      </Text>
    </Box>
  );
}
