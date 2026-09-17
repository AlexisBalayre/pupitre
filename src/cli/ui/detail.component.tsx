import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { DashboardSession } from '../../core/types/dashboard.types.js';
import { STATE_COLOURS } from './dashboard.constants.js';
import { originMarker } from './dashboard-text.utils.js';
import type { DetailRow } from './use-controls.hook.js';

/**
 * Everything behind one row: what the task is for, where it may write, what
 * finishing means, how its last gate went stage by stage, and the last things
 * that happened to it. A row answers "what needs me"; this answers "what am I
 * looking at" before the operator steers, kills or merges it. Every line is a
 * field of the row the controls handed over — a planned task has no gate and
 * no events because the snapshot carries none for it, not because this pane
 * decided to leave them out.
 */
export function Detail({ row }: { row: DetailRow }) {
  const item = row.kind === 'session' ? row.session : row.task;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan">
      <Text wrap="truncate-end">
        {row.kind === 'session' ? (
          <Text color={STATE_COLOURS[row.session.state]} bold>
            {row.session.state}{' '}
          </Text>
        ) : (
          <Text dimColor>planned </Text>
        )}
        <Text bold>{item.id}</Text>
        {row.kind === 'session' ? <Text> {row.session.branch}</Text> : null}
        <Text color="magenta"> {originMarker(item.origin)}</Text>
        <Text dimColor> (Esc closes)</Text>
      </Text>
      <Section title="goal">
        <Text>{item.goal}</Text>
      </Section>
      <Section title="scope">
        {item.scope.length === 0 ? <Text dimColor>none declared</Text> : null}
        {item.scope.map((glob, index) => (
          // The spec is session-writable, so a glob can repeat; its position cannot.
          // biome-ignore lint/suspicious/noArrayIndexKey: the index is the identity
          <Text key={index} wrap="truncate-end">
            {glob}
          </Text>
        ))}
      </Section>
      <Section title="acceptance">
        {item.acceptance.length === 0 ? <Text dimColor>none declared</Text> : null}
        {item.acceptance.map((criterion, index) => (
          // Two criteria can read the same; where each sits in the spec cannot.
          // biome-ignore lint/suspicious/noArrayIndexKey: the index is the identity
          <Text key={index}>- {criterion}</Text>
        ))}
      </Section>
      {row.kind === 'session' ? (
        <>
          <LastGate session={row.session} />
          <RecentEvents session={row.session} />
        </>
      ) : (
        <Section title="history">
          <Text dimColor>not launched: no gate run and no events yet</Text>
        </Section>
      )}
    </Box>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      <Box flexDirection="column" paddingLeft={2}>
        {children}
      </Box>
    </Box>
  );
}

function LastGate({ session }: { session: DashboardSession }) {
  const gate = session.lastGate;
  if (!gate) {
    return (
      <Section title="last gate">
        <Text dimColor>no gate run yet</Text>
      </Section>
    );
  }
  return (
    <Section title={`last gate — ${gate.passed ? 'passed' : 'failed'} ${gate.at}`}>
      {gate.stages.length === 0 ? <Text dimColor>the report listed no stages</Text> : null}
      {gate.stages.map((stage, index) => (
        // Stage names are the gate's own and do not repeat, but a report is a
        // payload a session can write; the position is what cannot collide.
        // biome-ignore lint/suspicious/noArrayIndexKey: the index is the identity
        <Text key={index} wrap="truncate-end">
          <Text>{stage.stage.padEnd(STAGE_COLUMN_CHARS)}</Text>
          <Text color={STAGE_COLOURS[stage.status]}>{stage.status}</Text>
          <Text dimColor>{stage.detail ? `  ${stage.detail}` : ''}</Text>
        </Text>
      ))}
    </Section>
  );
}

function RecentEvents({ session }: { session: DashboardSession }) {
  return (
    <Section title="last events">
      {session.recentEvents.length === 0 ? <Text dimColor>no events yet</Text> : null}
      {session.recentEvents.map((event, index) => (
        // Two events can share a type and a second; their order cannot.
        // biome-ignore lint/suspicious/noArrayIndexKey: the index is the identity
        <Text key={index} wrap="truncate-end">
          <Text dimColor>{event.at} </Text>
          <Text>{event.type.padEnd(EVENT_COLUMN_CHARS)}</Text>
          <Text dimColor>{event.detail ?? ''}</Text>
        </Text>
      ))}
    </Section>
  );
}

/** Wide enough for the gate's longest stage name, `worktree-clean`, and a gap. */
const STAGE_COLUMN_CHARS = 16;

/** Wide enough for the longest event type, `scope_violation`, and a gap. */
const EVENT_COLUMN_CHARS = 16;

/**
 * A stage's verdict in the colours the session table spends on the same news:
 * red stops the merge, yellow is a person's call, and a skip is not news.
 */
const STAGE_COLOURS: Record<string, string | undefined> = {
  pass: 'green',
  fail: 'red',
  flagged: 'yellow',
};
