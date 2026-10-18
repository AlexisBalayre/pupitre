import { needsYou } from '../../core/dashboard.service.js';
import type { DashboardReading } from './use-snapshot.hook.js';

/**
 * The fleet in the terminal tab while `pup ui` runs (decision 97): an OSC 2
 * title everywhere, plus iTerm2's Session Status (OSC 21337) so the tab gets a
 * coloured dot and a line, as a Claude Code tab does.
 */

const ESC = '\u001b';
const BEL = '\u0007';

/** The xterm title stack: push on start, pop on stop, so the shell's own title comes back. */
const PUSH_TITLE = `${ESC}[22;0t`;
const POP_TITLE = `${ESC}[23;0t`;

const ORANGE = '#ff9500';
const BLUE = '#0a84ff';
const GREEN = '#34c759';

/** The longest value written into a title or a status line. */
const MAX_VALUE_CHARS = 80;

interface SessionStatus {
  status: string;
  indicator: string;
  detail: string;
}

interface TerminalStatus {
  title: string;
  session: SessionStatus;
}

/**
 * A value as one inert run of text. Task goals and reasons come from a store a
 * session can write, and a terminal acts on ESC, BEL, the C0 and C1 controls
 * (`\u009b` is a CSI and `\u009d` an OSC on its own) and DEL; `;` is dropped
 * too, since it would end the status value and open a key of the writer's
 * choosing. Control characters are removed, not spaced, so a split sequence
 * cannot be put back together.
 */
function scrubValue(value: string): string {
  const clean = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/;/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
  return [...clean].slice(0, MAX_VALUE_CHARS).join('');
}

/** What the tab says about one reading: running count, what needs the operator, the top item. */
function readTerminalStatus(reading: DashboardReading): TerminalStatus {
  const { projects } = reading;
  const running = projects.reduce(
    (sum, { snapshot }) =>
      sum + snapshot.sessions.filter((session) => session.state === 'running').length,
    0,
  );
  // An open PR is work waiting to land, not a session that has stopped.
  const needs = projects.flatMap(({ snapshot }) =>
    needsYou(snapshot).filter((need) => need.kind !== 'pr-open'),
  );
  const [only] = projects;
  const name = projects.length === 1 && only ? only.snapshot.projectId : 'fleet';
  const title = `pup ${scrubValue(name)} · ${running} running · ${needs.length} need you`;
  const [top] = needs;
  if (top) {
    const detail = scrubValue(`${top.label}: ${top.reason}`);
    return { title, session: { status: 'needs you', indicator: ORANGE, detail } };
  }
  if (running > 0) {
    return { title, session: { status: 'working', indicator: BLUE, detail: '' } };
  }
  return { title, session: { status: 'idle', indicator: GREEN, detail: '' } };
}

function sessionStatusBytes({ status, indicator, detail }: SessionStatus): string {
  return `${ESC}]21337;status=${status};indicator=${indicator};status-color=${indicator};detail=${detail}${BEL}`;
}

/** Only iTerm2 reads OSC 21337; a terminal that does not may print the payload. */
function isITerm(env: NodeJS.ProcessEnv): boolean {
  return env.TERM_PROGRAM === 'iTerm.app';
}

/**
 * Nothing is written off a terminal, under tmux (which drops these sequences
 * and would print some of them) or when the operator opted out.
 */
function terminalStatusEnabled(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean {
  return stream.isTTY === true && !env.TMUX && env.PUP_DISABLE_TERMINAL_TITLE !== '1';
}

/**
 * The writer: `update` on each snapshot, `stop` on the way out. `stop` pops the
 * title the shell had and clears every status key. Both are no-ops where
 * `terminalStatusEnabled` says no.
 */
export function createTerminalStatus(
  stream: { isTTY?: boolean; write: (chunk: string) => unknown },
  env: NodeJS.ProcessEnv,
): { update: (reading: DashboardReading) => void; stop: () => void } {
  if (!terminalStatusEnabled(stream, env)) return { update: () => {}, stop: () => {} };
  const iterm = isITerm(env);
  let pushed = false;
  return {
    update(reading) {
      const { title, session } = readTerminalStatus(reading);
      let out = pushed ? '' : PUSH_TITLE;
      pushed = true;
      out += `${ESC}]2;${title}${BEL}`;
      if (iterm) out += sessionStatusBytes(session);
      stream.write(out);
    },
    stop() {
      if (!pushed) return;
      pushed = false;
      stream.write(
        POP_TITLE + (iterm ? sessionStatusBytes({ status: '', indicator: '', detail: '' }) : ''),
      );
    },
  };
}
