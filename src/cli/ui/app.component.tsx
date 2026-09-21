import { Box, Text } from 'ink';
import { isTerminal } from '../../core/session-state.utils.js';
import { Backlog } from './backlog.component.js';
import { Debt } from './debt.component.js';
import { Detail } from './detail.component.js';
import { Footer } from './footer.component.js';
import { FleetHeader, Header } from './header.component.js';
import { MergeLogPane } from './merge-log.component.js';
import { Prompt } from './prompt.component.js';
import { Radar } from './radar.component.js';
import { Sessions } from './sessions.component.js';
import { type SessionRow, type TaskRow, useControls } from './use-controls.hook.js';
import { type DashboardReading, useSnapshot } from './use-snapshot.hook.js';

/**
 * `pup ui`'s whole layout. The two hooks below hold everything that changes:
 * `useSnapshot` decides when to look at the store, `useControls` decides what
 * a keypress does to it. This component reads both and draws; it holds no
 * state of its own and takes no decision, which is the rule that keeps every
 * value on screen a field of one reading (decision 52).
 *
 * A reading holds one project or, with `--all`, several (decision 61). Their
 * rows share one table and one cursor, each row carrying the project it came
 * from so the keys write through that project's store; a project column is
 * drawn only when more than one project is on screen, which leaves a single
 * project's layout exactly as it was.
 */
export function App({
  read,
  showAttach,
  readOnlyReason,
}: {
  /** One look at every store on screen, each with the deps its rows' keys write through. */
  read: () => DashboardReading;
  showAttach: boolean;
  /** Set for a session or the conductor: the dashboard, and no controls. */
  readOnlyReason?: string;
}) {
  const { reading, readAt, refresh } = useSnapshot(read);
  const { projects, unreadable } = reading;
  const fleet = projects.length > 1;
  // Merged and killed sessions are counted, not listed, and the cursor never
  // lands on one: this view is for the work a person can still change, and
  // every action here acts on a session that is still running. Rows stay
  // grouped by project, each group in the order its snapshot sorted it.
  const live: SessionRow[] = projects.flatMap((project) =>
    project.snapshot.sessions
      .filter((session) => !isTerminal(session.state))
      .map((session) => ({ session, project })),
  );
  const planned: TaskRow[] = projects.flatMap((project) =>
    project.snapshot.backlog.map((task) => ({ task, project })),
  );
  const sessionCount = projects.reduce((sum, project) => sum + project.snapshot.sessions.length, 0);
  const projectColumn = (rows: (SessionRow | TaskRow)[]) =>
    fleet ? { projects: rows.map((row) => row.project.snapshot.projectId) } : {};
  const { cursor, prompt, mergeLog, detail, status } = useControls({
    projects,
    live,
    planned,
    refresh,
    readOnly: Boolean(readOnlyReason),
  });
  const [only] = projects;
  return (
    <Box flexDirection="column" paddingX={1}>
      {fleet || !only ? (
        <FleetHeader snapshots={projects.map((project) => project.snapshot)} />
      ) : (
        <Header snapshot={only.snapshot} showAttach={showAttach} />
      )}
      {unreadable.map((line) => (
        <Text key={line} color="red" wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Box marginTop={1} flexDirection="column">
        {projects.map(({ snapshot }) => (
          <Debt
            key={snapshot.projectId}
            overdueDebt={snapshot.overdueDebt}
            openDebtCount={snapshot.openDebtCount}
            {...(fleet ? { project: snapshot.projectId } : {})}
          />
        ))}
      </Box>
      {/* The detail pane takes the table's place rather than a place under it:
          a row's acceptance, gate stages and events run to twenty lines, and
          beneath the table they would push the radar and the footer off a
          40-row screen. The row it shows names itself, so the cursor is not lost. */}
      <Box marginTop={1} flexDirection="column">
        {detail ? (
          <Detail row={detail} />
        ) : (
          <>
            <Sessions
              sessions={live.map((row) => row.session)}
              {...projectColumn(live)}
              finishedCount={sessionCount - live.length}
              selectedIndex={cursor}
            />
            <Backlog
              backlog={planned.map((row) => row.task)}
              {...projectColumn(planned)}
              selectedIndex={cursor - live.length}
            />
          </>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {projects.map(({ snapshot }) => (
          <Radar
            key={snapshot.projectId}
            overlaps={snapshot.overlaps}
            radarStale={snapshot.radarStale}
            {...(fleet ? { project: snapshot.projectId } : {})}
          />
        ))}
      </Box>
      {mergeLog ? (
        <Box marginTop={1}>
          <MergeLogPane log={mergeLog} />
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {prompt ? <Prompt prompt={prompt} /> : null}
        <Footer
          refreshedAt={readAt.toISOString().slice(11, 19)}
          {...(status ? { status } : {})}
          {...(readOnlyReason ? { readOnlyReason } : {})}
        />
      </Box>
    </Box>
  );
}
