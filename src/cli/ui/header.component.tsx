import { Box, Text } from 'ink';
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
