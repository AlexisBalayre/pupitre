import { Box, Text } from 'ink';
import type { DashboardSnapshot } from '../../core/types/dashboard.types.js';
import { clip, moreLine } from './viewport.utils.js';

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
  maxLines = Number.POSITIVE_INFINITY,
}: {
  overdueDebt: DashboardSnapshot['overdueDebt'];
  openDebtCount: number;
  project?: string;
  /** The rows this block may take, the `+N more` line and the count line included. */
  maxLines?: number;
}) {
  if (overdueDebt.length === 0 && openDebtCount === 0) return null;
  const lead = project === undefined ? '' : `${project}  `;
  const { shown, hidden } = clip(overdueDebt, Math.max(maxLines - 1, 1));
  return (
    <Box flexDirection="column">
      {shown.map((entry) => (
        // One template for the reason the radar's line is one: Ink collapses
        // the whitespace between JSX children, and these are columns.
        <Text key={entry.id} wrap="truncate-end" color="red">
          {`${lead}OVERDUE DEBT #${entry.id}  ${entry.description}  (review by: ${entry.reviewBy})`}
        </Text>
      ))}
      {hidden > 0 ? <Text color="red">{`${lead}${moreLine(hidden).trim()}`}</Text> : null}
      <Text dimColor>
        {`${lead}${openDebtCount} open debt ${openDebtCount === 1 ? 'entry' : 'entries'}`}
      </Text>
    </Box>
  );
}
