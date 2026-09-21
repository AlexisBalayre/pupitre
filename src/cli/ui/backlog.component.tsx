import { Box, Text } from 'ink';
import type { DashboardSnapshot } from '../../core/types/dashboard.types.js';
import {
  ID_COLUMN_CHARS,
  PROJECT_COLUMN_CHARS,
  STATE_COLUMN_CHARS,
} from './dashboard.constants.js';
import { goalColumn, originMarker, trailing } from './dashboard-text.utils.js';

/**
 * Planned tasks under the session table's columns, as `pup status` prints them:
 * what will be built belongs beside what is being built, not in a command of
 * its own (decision 41). `planned` is docs/01's state for a task with no
 * session. The origin precedes the goal for the same reason the session rows'
 * markers do — who asked survives a narrow terminal, the prose does not.
 * `projects` is the session table's project column, for the same rows' sake:
 * a planned row is launched into the project it was read from (decision 61).
 */
export function Backlog({
  backlog,
  projects,
  selectedIndex,
}: {
  backlog: DashboardSnapshot['backlog'];
  /** Each row's project id, in `backlog`'s order; absent for a single project. */
  projects?: string[];
  selectedIndex: number;
}) {
  if (backlog.length === 0) return null;
  return (
    <Box flexDirection="column">
      {backlog.map((task, index) => (
        <Text key={`${projects?.[index] ?? ''}/${task.id}`} wrap="truncate-end">
          <Text color="cyan">{index === selectedIndex ? '>' : ' '} </Text>
          {projects === undefined ? null : (
            <Text dimColor>{(projects[index] ?? '').padEnd(PROJECT_COLUMN_CHARS)}</Text>
          )}
          <Text dimColor>{'planned'.padEnd(STATE_COLUMN_CHARS)}</Text>
          <Text>{task.id.padEnd(ID_COLUMN_CHARS)}</Text>
          <Text color="magenta">{originMarker(task.origin)}</Text>
          <Text dimColor>{trailing(goalColumn(task.goal))}</Text>
        </Text>
      ))}
    </Box>
  );
}
