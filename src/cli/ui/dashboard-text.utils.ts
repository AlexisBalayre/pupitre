import { sanitizeReason } from '../../adapters/capability.utils.js';
import type { FleetBlock } from '../../core/fleet.service.js';
import { formatStaleAge } from '../../core/session-activity.utils.js';
import { RESPAWN_SUGGEST_TOKENS } from '../../core/session-handoff.service.js';
import type { DashboardSession } from '../../core/types/dashboard.types.js';

/**
 * The words both dashboard renderers print. `pup status` and `pup ui` read one
 * snapshot so they cannot disagree about what is running (decision 52); they
 * share these so they cannot disagree about what to call it either — a session
 * reading `STALLED (12m)` on one screen and `stalled 12 min` on the other is
 * the same split one layer up. Nothing here decides anything: every value is
 * already on the session the caller hands in.
 */

/**
 * Width of the goal column in `pup plan`, `pup status` and `pup ui`. Goals run
 * to a paragraph (decision 41's own backlog entries are 400+ chars), so the
 * column clips rather than pads: an unclipped goal pushed the scope column off
 * the row on the first real backlog this rendered. Private to `goalColumn`:
 * the width is how this file fits a goal, not a number other files measure
 * against — every caller that wanted one wanted the fitted string.
 */
const GOAL_COLUMN_CHARS = 44;

/** A goal headline fitted to the goal column — clipped rather than wrapped. */
export function goalColumn(headline: string): string {
  const chars = [...headline];
  return chars.length > GOAL_COLUMN_CHARS
    ? `${chars.slice(0, GOAL_COLUMN_CHARS - 1).join('')}…`
    : headline.padEnd(GOAL_COLUMN_CHARS);
}

/**
 * Who authored a planned task, where the operator decides what to launch: a
 * spec an agent wrote is one the operator never typed, and the report alone
 * showing `from conductor` left `pup status` and `pup plan` silent on it.
 */
export function originMarker(origin: string): string {
  return origin === 'human' ? '' : `(from ${sanitizeReason(origin)})`;
}

/**
 * Decision 2: hook events, not pane contents, tell what a running session is
 * doing — the snapshot has already read them, and a session with no activity is
 * one there was nothing to read for. Decision 35: staleness wins over activity
 * kind, so a session whose events file has gone quiet too long is STALLED no
 * matter what its last classified event was — and a stall the watchdog has
 * already answered says so in place of its age.
 */
export function activityLabel(session: DashboardSession): string {
  if (!session.activity) return '';
  if (session.stalledAgeMs !== undefined) {
    return deadTurnLabel(session) || `STALLED (${formatStaleAge(session.stalledAgeMs)})`;
  }
  if (session.activity.kind === 'awaiting-input') {
    return `WAITING ON INPUT${session.activity.detail ? ` (${session.activity.detail})` : ''}`;
  }
  if (session.activity.kind === 'idle') return 'idle (turn ended, no done signal)';
  return '';
}

/**
 * What the watchdog found on this stalled session's pane, in place of the bare
 * age: a turn that died on an API error and the resume that was typed into it,
 * or the refusal that left it for a human (addendum to decision 35). Empty for
 * a session stalled for some other reason, which is still the age and nothing
 * more.
 *
 * Inside `activityLabel` rather than beside it, because the two are one
 * decision — which sentence that column carries — and a surface that had to
 * remember to ask for both would be the split decision 52 exists to prevent.
 * The error line itself stays off the row: it is the same sentence every time,
 * and `pup watch` prints it.
 */
function deadTurnLabel(session: DashboardSession): string {
  const died = session.deadTurn;
  if (!died) return '';
  const at = new Date(died.at).toTimeString().slice(0, 5);
  return died.refusal
    ? `TURN DIED (API error) — resume refused at ${at}, needs a human`
    : `TURN DIED (API error) — resumed by watch at ${at}`;
}

/**
 * How full the context window is, rounded to the thousand nobody reads past,
 * and the respawn to type once it is full enough to matter (decision 18).
 */
export function contextLabel(session: DashboardSession): string {
  const tokens = session.contextTokens;
  if (tokens === undefined) return '';
  const suggestion =
    tokens > RESPAWN_SUGGEST_TOKENS ? ` — consider \`pup respawn ${session.id}\`` : '';
  return `ctx ~${Math.round(tokens / 1000)}k${suggestion}`;
}

/** The last gate run that left a report: the verdict, and what failed if it did. */
export function gateLabel(session: DashboardSession): string {
  const gate = session.lastGate;
  if (!gate) return '';
  return gate.passed ? 'gate ok' : `gate fail${gate.failedStage ? `: ${gate.failedStage}` : ''}`;
}

/** The last steer the session took, and who sent it when the event named one. */
export function steerLabel(session: DashboardSession): string {
  const steer = session.lastSteer;
  if (!steer) return '';
  return `steer ${steer.kind ?? 'sent'}${steer.by ? ` (${steer.by})` : ''}`;
}

/**
 * A trailing column on a `pup status` row, behind the two spaces every column
 * there is separated by — or nothing at all, because an empty column that still
 * pays for its separator leaves a row with a ragged, meaningless tail.
 */
export function trailing(label: string): string {
  return label ? `  ${label}` : '';
}

/** One session row, the same in the single-project table and the fleet view. */
export function sessionLine(session: DashboardSession): string {
  const marker =
    session.state === 'blocked'
      ? `  needs a human (${session.rejectCount} rejections) — \`pup unblock ${session.id}\` once addressed`
      : '';
  return (
    `${session.state.padEnd(16)} ${session.id.padEnd(28)} ${session.branch}${marker}` +
    `${trailing(activityLabel(session))}${trailing(contextLabel(session))}`
  );
}

/**
 * `pup status`'s fleet view (decision 60): per project its header, then only
 * what waits on the operator, then counts; a project that was not read is its
 * header and why. Dormant projects shown under `--dormant` say so in their
 * header, and the ones left out are counted on a last line (decision 62).
 */
export function fleetLines({ blocks, hidden }: { blocks: FleetBlock[]; hidden: number }): string[] {
  const lines = blocks.flatMap((block, index) => [
    ...(index > 0 ? [''] : []),
    ...('reason' in block ? [`${block.header}  ${block.reason}`] : fleetBlockLines(block)),
  ]);
  if (hidden > 0) {
    if (blocks.length > 0) lines.push('');
    lines.push(
      `${hidden} dormant ${hidden === 1 ? 'project' : 'projects'} not shown; --dormant shows ${hidden === 1 ? 'it' : 'them'}.`,
    );
  }
  return lines;
}

function fleetBlockLines(block: Exclude<FleetBlock, { reason: string }>): string[] {
  const { header, snapshot, summary, dormantAt } = block;
  const dormant = dormantAt === null ? '' : `  dormant since ${sanitizeReason(dormantAt)}`;
  return [
    `${header}  ${snapshot.conductor.running ? 'conductor running' : 'conductor stopped'}${dormant}`,
    ...snapshot.overdueDebt.map(
      (entry) =>
        `  OVERDUE DEBT #${entry.id}  ${entry.description}  (review by: ${entry.reviewBy})`,
    ),
    ...summary.needsYou.map((session) => `  ${sessionLine(session)}`),
    `  ${summary.running} running, ${summary.planned} planned, ${summary.merged} merged`,
  ];
}
