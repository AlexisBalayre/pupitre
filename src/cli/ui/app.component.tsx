import { Box } from 'ink';
import { isTerminal } from '../../core/session-state.utils.js';
import type { DashboardSnapshot } from '../../core/types/dashboard.types.js';
import type { ActionDeps } from './actions.service.js';
import { Backlog } from './backlog.component.js';
import { Debt } from './debt.component.js';
import { Footer } from './footer.component.js';
import { Header } from './header.component.js';
import { MergeLogPane } from './merge-log.component.js';
import { Prompt } from './prompt.component.js';
import { Radar } from './radar.component.js';
import { Sessions } from './sessions.component.js';
import { useControls } from './use-controls.hook.js';
import { useSnapshot } from './use-snapshot.hook.js';

/**
 * `pup ui`'s whole layout. The two hooks below hold everything that changes:
 * `useSnapshot` decides when to look at the store, `useControls` decides what
 * a keypress does to it. This component reads both and draws; it holds no
 * state of its own and takes no decision, which is the rule that keeps every
 * value on screen a field of one reading (decision 52).
 */
export function App({
  read,
  showAttach,
  deps,
  readOnlyReason,
}: {
  read: () => DashboardSnapshot;
  showAttach: boolean;
  /** What the controls write through — the caller's open store and its repo. */
  deps: ActionDeps;
  /** Set for a session or the conductor: the dashboard, and no controls. */
  readOnlyReason?: string;
}) {
  const { snapshot, readAt, refresh } = useSnapshot(read);
  // Merged and killed sessions are counted, not listed, and the cursor never
  // lands on one: this view is for the work a person can still change, and
  // every action here acts on a session that is still running.
  const live = snapshot.sessions.filter((session) => !isTerminal(session.state));
  const { cursor, prompt, mergeLog, status } = useControls({
    deps,
    snapshot,
    live,
    refresh,
    readOnly: Boolean(readOnlyReason),
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
