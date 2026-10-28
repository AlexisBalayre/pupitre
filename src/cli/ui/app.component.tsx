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
import { type LiveRow, type PlannedRow, useControls } from './use-controls.hook.js';
import { type DashboardReading, type ProjectReading, useSnapshot } from './use-snapshot.hook.js';
import { useTerminalRows } from './use-terminal-rows.hook.js';
import { useTerminalStatus } from './use-terminal-status.hook.js';
import { moreLine, sectionShare, usedLines, windowStart } from './viewport.utils.js';

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
 *
 * The frame is never as tall as the terminal: Ink clears and rewrites the whole
 * screen when it is, and a re-read every two seconds would flicker it that often
 * (decision 121). The parts that cannot shrink are counted, the debt and radar
 * blocks are held to a quarter of what is left each, and the table windows
 * around the cursor in the rest.
 */
export interface AppProps {
  /** One look at every store on screen, each with the deps its rows' keys write through. */
  read: () => DashboardReading;
  showAttach: boolean;
  /** Set for a session or the conductor: the dashboard, and no controls. */
  readOnlyReason?: string;
}

export function App({ read, showAttach, readOnlyReason }: AppProps) {
  const { reading, readAt, refresh } = useSnapshot(read);
  const { projects, unreadable } = reading;
  useTerminalStatus(reading);
  const isFleet = projects.length > 1;
  // Merged and killed sessions are counted, not listed, and the cursor never
  // lands on one: this view is for the work a person can still change, and
  // every action here acts on a session that is still running. Rows stay
  // grouped by project, each group in the order its snapshot sorted it.
  const live: LiveRow[] = projects.flatMap((project) =>
    project.snapshot.sessions
      .filter((session) => !isTerminal(session.state))
      .map((session) => ({ session, project })),
  );
  const planned: PlannedRow[] = projects.flatMap((project) =>
    project.snapshot.backlog.map((task) => ({ task, project })),
  );
  const sessionCount = projects.reduce((sum, project) => sum + project.snapshot.sessions.length, 0);
  const projectColumn = (rows: { project: ProjectReading }[]) =>
    isFleet ? { projects: rows.map((row) => row.project.snapshot.projectId) } : {};
  const terminalRows = useTerminalRows();
  const { cursor, prompt, mergeLog, detail, status } = useControls({
    projects,
    live,
    planned,
    refresh,
    readOnly: Boolean(readOnlyReason),
  });
  const [only] = projects;

  // Lines the frame spends before any list: the header, the unreadable stores,
  // the four margins between blocks, the prompt, the footer and the merge pane.
  // Each is one terminal row because each is truncated, never wrapped.
  const headerLines = isFleet || !only ? 1 + projects.length : only.snapshot.baseline ? 3 : 2;
  // The footer's two lines (hint or read-only reason, then the keys), and the status line over them.
  const footerLines = 2 + (status ? 1 : 0);
  const mergeLogLines = mergeLog ? 1 + 3 + Math.max(mergeLog.lines.length, 1) : 0;
  const chrome =
    headerLines + unreadable.length + 4 + (prompt ? 1 : 0) + footerLines + mergeLogLines;
  // One row short of the terminal, because a frame as tall as it is already clears.
  const body = Math.max(terminalRows - 1 - chrome, 0);
  const sectionCap = Math.floor(body / 4);
  const debtShare = sectionShare(sectionCap, projects.length, 2);
  const radarShare = sectionShare(sectionCap, projects.length, 2);
  const debtUsed = usedLines(
    projects.map(({ snapshot }) =>
      snapshot.overdueDebt.length + snapshot.openDebtCount === 0
        ? 0
        : snapshot.overdueDebt.length + 1,
    ),
    debtShare,
  );
  const radarUsed = usedLines(
    projects.map(({ snapshot }) => snapshot.overlaps.length + (snapshot.radarStale ? 1 : 0)),
    radarShare,
  );
  const tableLines = Math.max(body - debtUsed - radarUsed, 2);
  const total = live.length + planned.length;
  const fixedRows = (live.length === 0 ? 1 : 0) + (sessionCount - live.length > 0 ? 1 : 0);
  const fits = total <= tableLines - fixedRows;
  const windowSize = fits ? total : Math.max(tableLines - fixedRows - 1, 1);
  const start = fits ? 0 : windowStart(total, windowSize, cursor);
  const end = start + windowSize;
  const plannedStart = Math.max(start - live.length, 0);
  const visibleLive = live.slice(start, end);
  const visiblePlanned = planned.slice(plannedStart, Math.max(end - live.length, 0));
  return (
    <Box flexDirection="column" paddingX={1}>
      {isFleet || !only ? (
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
            maxLines={debtShare}
            {...(isFleet ? { project: snapshot.projectId } : {})}
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
              sessions={visibleLive.map((row) => row.session)}
              {...projectColumn(visibleLive)}
              finishedCount={sessionCount - live.length}
              selectedIndex={cursor - start}
              liveCount={live.length}
            />
            <Backlog
              backlog={visiblePlanned.map((row) => row.task)}
              {...projectColumn(visiblePlanned)}
              selectedIndex={cursor - live.length - plannedStart}
            />
            {fits ? null : <Text dimColor>{moreLine(total - windowSize)}</Text>}
          </>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {projects.map(({ snapshot }) => (
          <Radar
            key={snapshot.projectId}
            overlaps={snapshot.overlaps}
            radarStale={snapshot.radarStale}
            maxLines={radarShare}
            {...(isFleet ? { project: snapshot.projectId } : {})}
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
