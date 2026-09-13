import { Box, useApp, useInput } from 'ink';
import { useState } from 'react';
import { isTerminal } from '../../core/session-state.utils.js';
import type { DashboardSnapshot } from '../../core/types/dashboard.types.js';
import { Backlog } from './backlog.component.js';
import { Debt } from './debt.component.js';
import { Footer } from './footer.component.js';
import { Header } from './header.component.js';
import { Radar } from './radar.component.js';
import { Sessions } from './sessions.component.js';
import { useSnapshot } from './use-snapshot.hook.js';

/**
 * `pup ui`'s whole layout, and the only component that holds state: where the
 * cursor is, and which reading is on screen. Sessions and backlog share one
 * cursor because they are one list on screen — the status table with the
 * planned rows under it (decision 41) — and part 3's actions will act on
 * whichever row it sits on, which is why the cursor exists before they do.
 */
export function App({ read, showAttach }: { read: () => DashboardSnapshot; showAttach: boolean }) {
  const { snapshot, readAt, refresh } = useSnapshot(read);
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);
  // Merged and killed sessions are counted, not listed, and the cursor never
  // lands on one: this view is for the work a person can still change, and
  // part 3's actions all act on a session that is still running.
  const live = snapshot.sessions.filter((session) => !isTerminal(session.state));
  const rowCount = live.length + snapshot.backlog.length;
  // Clamped at render rather than on every keypress: a merge or a launch can
  // shorten the list under a cursor that was in range when it was last moved.
  const cursor = Math.min(selected, Math.max(rowCount - 1, 0));
  useInput((input, key) => {
    if (input === 'q') exit();
    else if (input === 'r') refresh();
    else if (key.downArrow || input === 'j') setSelected(Math.min(cursor + 1, rowCount - 1));
    else if (key.upArrow || input === 'k') setSelected(Math.max(cursor - 1, 0));
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Header snapshot={snapshot} showAttach={showAttach} />
      <Box marginTop={1} flexDirection="column">
        <Debt overdueDebt={snapshot.overdueDebt} openDebtCount={snapshot.openDebtCount} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Sessions
          sessions={live}
          finishedCount={snapshot.sessions.length - live.length}
          selectedIndex={cursor}
        />
        <Backlog backlog={snapshot.backlog} selectedIndex={cursor - live.length} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Radar overlaps={snapshot.overlaps} radarStale={snapshot.radarStale} />
      </Box>
      <Box marginTop={1}>
        <Footer refreshedAt={readAt.toISOString().slice(11, 19)} />
      </Box>
    </Box>
  );
}
