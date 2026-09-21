import { Box, Text } from 'ink';
import type { DashboardSession } from '../../core/types/dashboard.types.js';
import {
  ID_COLUMN_CHARS,
  PROJECT_COLUMN_CHARS,
  STATE_COLOURS,
  STATE_COLUMN_CHARS,
} from './dashboard.constants.js';
import {
  activityLabel,
  contextLabel,
  gateLabel,
  goalColumn,
  steerLabel,
  trailing,
} from './dashboard-text.utils.js';

/**
 * The status table, in the order the snapshot sorted it: blocked and stalled
 * first, because those are the rows that stay on screen until a person acts on
 * them. Every column is a field of the row it renders — nothing here asks the
 * store a second question.
 *
 * Two departures from what `pup status` prints, both because this is a screen
 * held open rather than a list that scrolls away.
 *
 * The goal comes last. A printed row is read once, so it leads with what the
 * session is for; a row here is read fifty times to answer "what needs me", and
 * the 44-char goal pushed every marker that answers it off the end of an
 * eighty-column terminal. Truncation now eats the prose instead of the signal.
 *
 * And finished sessions are a count, not rows: the caller hands over the live
 * ones and how many it kept back. Pupitre's own project had 27 merged sessions
 * the first time this rendered, which pushed the header, the radar and the
 * footer off a 40-row screen to show work nobody can act on. `pup status` is
 * still where the whole history is listed.
 *
 * With `pup ui --all` over more than one project, `projects` names each row's
 * project and a column for it leads the row; a single project draws no such
 * column, so its layout is the one it always had (decision 61).
 */
export function Sessions({
  sessions,
  projects,
  finishedCount,
  selectedIndex,
}: {
  sessions: DashboardSession[];
  /** Each row's project id, in `sessions`' order; absent for a single project. */
  projects?: string[];
  finishedCount: number;
  selectedIndex: number;
}) {
  return (
    <Box flexDirection="column">
      {sessions.length === 0 ? <Text dimColor>no live sessions</Text> : null}
      {sessions.map((session, index) => {
        const project = projects?.[index];
        return (
          // Session ids are unique within a store, not across a fleet.
          <SessionRow
            key={`${project ?? ''}/${session.id}`}
            session={session}
            {...(project === undefined ? {} : { project })}
            selected={index === selectedIndex}
          />
        );
      })}
      {finishedCount > 0 ? (
        <Text dimColor>{`  ${finishedCount} finished — \`pup status\` lists them`}</Text>
      ) : null}
    </Box>
  );
}

function SessionRow({
  session,
  project,
  selected,
}: {
  session: DashboardSession;
  project?: string;
  selected: boolean;
}) {
  return (
    <Text wrap="truncate-end">
      <Text color="cyan">{selected ? '>' : ' '} </Text>
      {project === undefined ? null : <Text dimColor>{project.padEnd(PROJECT_COLUMN_CHARS)}</Text>}
      <Text color={STATE_COLOURS[session.state]} bold={session.needsHuman}>
        {session.state.padEnd(STATE_COLUMN_CHARS)}
      </Text>
      <Text>{session.id.padEnd(ID_COLUMN_CHARS)}</Text>
      {/* Decision 35: a stalled session reads STALLED whatever its last event
          was — or, once the watchdog has answered that stall, what it found
          there — and it is the one marker that must not be dimmed away. */}
      <Text color={session.stalledAgeMs === undefined ? 'yellow' : 'red'}>
        {activityLabel(session)}
      </Text>
      <Text color="red">{session.rejectCount > 0 ? `  ${session.rejectCount} rej` : ''}</Text>
      <Text color={session.lastGate?.passed === false ? 'red' : 'green'}>
        {trailing(gateLabel(session))}
      </Text>
      <Text dimColor>
        {trailing(contextLabel(session))}
        {trailing(steerLabel(session))}
        {'  '}
        {goalColumn(session.goal)}
      </Text>
    </Text>
  );
}
