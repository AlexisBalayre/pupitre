import { Box, Text } from 'ink';
import { sanitizeReason } from '../../adapters/capability.utils.js';
import type { DashboardSnapshot } from '../../core/types/dashboard.types.js';

/**
 * The project, whether its conductor is up, and the debt figures `pup init`
 * last measured. `showAttach` is the caller's ruling, not this component's:
 * the attach command carries the socket the conductor's window lives on, and
 * pup is not the thing that hands a session or the conductor itself the way in
 * (decision 47) — `pup ui` asks that question where `pup status` asks it.
 */
export function Header({
  snapshot,
  showAttach,
}: {
  snapshot: DashboardSnapshot;
  showAttach: boolean;
}) {
  const { baseline, conductor } = snapshot;
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>pupitre</Text>
        <Text> {snapshot.projectId} </Text>
        <Text dimColor>{snapshot.repoPath}</Text>
      </Text>
      <Text>
        <Text color={conductor.running ? 'green' : 'gray'}>
          conductor {conductor.running ? 'running' : 'down'}
        </Text>
        {conductor.running && showAttach ? (
          <Text dimColor> (attach: {conductor.attachCommand})</Text>
        ) : null}
      </Text>
      {baseline ? (
        <Text dimColor>
          baseline {baseline.capturedAt}
          {baseline.coverageRatio === undefined
            ? ''
            : `  coverage ${Math.round(baseline.coverageRatio * 100)}%`}
          {baseline.duplicatedLines === undefined ? '' : `  dup ${baseline.duplicatedLines} lines`}
          {baseline.deadExports === undefined ? '' : `  dead exports ${baseline.deadExports}`}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * `pup ui --all`'s header over more than one project (decision 61): a line per
 * project, its id — the one the table's project column prints — its repo and
 * whether its conductor is up, as the fleet `pup status` heads each block. No
 * attach command and no baseline: both are per project and one `--project`
 * away, and a line each would push the table off the screen the fleet is for.
 */
export function FleetHeader({ snapshots }: { snapshots: DashboardSnapshot[] }) {
  return (
    <Box flexDirection="column">
      <Text bold>pupitre</Text>
      {snapshots.map((snapshot) => (
        <Text key={snapshot.projectId} wrap="truncate-end">
          {/* One template per column, as the radar's line: Ink collapses the
              whitespace between children. The path is what a foreign store's
              `projects` row says, so it is sanitized (decision 29). */}
          <Text>{`${snapshot.projectId}  `}</Text>
          <Text dimColor>{`${sanitizeReason(snapshot.repoPath)}  `}</Text>
          <Text color={snapshot.conductor.running ? 'green' : 'gray'}>
            conductor {snapshot.conductor.running ? 'running' : 'down'}
          </Text>
        </Text>
      ))}
    </Box>
  );
}
