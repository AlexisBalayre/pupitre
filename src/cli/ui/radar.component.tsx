import { Box, Text } from 'ink';
import type { DashboardSnapshot } from '../../core/types/dashboard.types.js';

/**
 * The watcher's conflict radar: live sessions whose diffs touch the same file
 * (docs/08 v1.2). A stale heartbeat is reported on every pair rather than once
 * at the bottom — an overlap read off a dead radar is a claim about a scan that
 * may predate everything on the screen above it. Over a fleet each project's
 * radar is its own watcher's, so each is drawn apart under its project id
 * (decision 61).
 */
export function Radar({
  overlaps,
  radarStale,
  project,
}: {
  overlaps: DashboardSnapshot['overlaps'];
  radarStale: boolean;
  project?: string;
}) {
  if (overlaps.length === 0 && !radarStale) return null;
  const lead = project === undefined ? '' : `${project}  `;
  return (
    <Box flexDirection="column">
      {overlaps.map((pair) => (
        // One template, not JSX text: Ink collapses runs of whitespace between
        // children the way a browser does, and this is a row of columns
        // separated by two spaces — the line `pup status` already prints.
        <Text key={`${pair.sessionA}/${pair.sessionB}`} wrap="truncate-end" color="yellow">
          {`${lead}OVERLAP  ${pair.sessionA} <-> ${pair.sessionB}  ${pair.files[0] ?? ''}` +
            (pair.files.length > 1 ? ` (+${pair.files.length - 1} more)` : '') +
            (radarStale ? '  (stale)' : '')}
        </Text>
      ))}
      {radarStale ? (
        <Text dimColor>{`${lead}conflict radar off — start it with \`pup watch --start\``}</Text>
      ) : null}
    </Box>
  );
}
