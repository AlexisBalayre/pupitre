import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardSession, DashboardSnapshot } from '../../core/types/dashboard.types.js';
import type { ActionDeps } from './actions.service.js';
import { createTerminalStatus } from './terminal-status.utils.js';
import type { DashboardReading } from './use-snapshot.hook.js';
import { useTerminalStatus } from './use-terminal-status.hook.js';

const ESC = '\u001b';
const BEL = '\u0007';
const ITERM = { TERM_PROGRAM: 'iTerm.app' };
const PUSH = `${ESC}[22;0t`;
const POP = `${ESC}[23;0t`;

function session(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: 's-mtzmobsi-1',
    isMintedId: true,
    state: 'running',
    branch: 'pup/t-mtzmobsi',
    taskId: 't-mtzmobsi',
    goal: 'a live dashboard',
    origin: 'human',
    scope: ['src/**'],
    acceptance: ['it works'],
    rejectCount: 0,
    needsHuman: false,
    recentEvents: [],
    ...overrides,
  };
}

function reading(...sessions: DashboardSession[]): DashboardReading {
  const snapshot: DashboardSnapshot = {
    projectId: 'proj',
    repoPath: '/repo',
    conductor: { running: false, name: 'pup-conductor-x', attachCommand: 'tmux -L x attach -t x' },
    sessions,
    backlog: [],
    overdueDebt: [],
    openDebtCount: 0,
    overlaps: [],
    radarStale: false,
  };
  return { projects: [{ deps: {} as ActionDeps, snapshot }], unreadable: [] };
}

function tty(isTTY = true) {
  const writes: string[] = [];
  return { isTTY, write: (chunk: string) => writes.push(chunk), writes };
}

const session21337 = (status: string, indicator: string, detail: string) =>
  `${ESC}]21337;status=${status};indicator=${indicator};status-color=${indicator};detail=${detail}${BEL}`;

describe('createTerminalStatus', () => {
  it('writes the needs-you title and orange status with the top item as detail', () => {
    const out = tty();
    createTerminalStatus(out, ITERM).update(
      reading(session(), session({ id: 's-mtzmobsi-2', state: 'blocked', rejectCount: 3 })),
    );
    expect(out.writes).toEqual([
      `${PUSH}${ESC}]2;pup proj · 1 running · 1 need you${BEL}` +
        session21337('needs you', '#ff9500', 's-mtzmobsi-2: blocked (3 rejections)'),
    ]);
  });

  it('writes working while sessions run and nothing waits', () => {
    const out = tty();
    createTerminalStatus(out, ITERM).update(reading(session()));
    expect(out.writes).toEqual([
      `${PUSH}${ESC}]2;pup proj · 1 running · 0 need you${BEL}` +
        session21337('working', '#0a84ff', ''),
    ]);
  });

  it('writes idle in green over an empty fleet', () => {
    const out = tty();
    createTerminalStatus(out, ITERM).update(reading());
    expect(out.writes).toEqual([
      `${PUSH}${ESC}]2;pup proj · 0 running · 0 need you${BEL}` +
        session21337('idle', '#34c759', ''),
    ]);
  });

  it('writes the title alone outside iTerm2', () => {
    const out = tty();
    createTerminalStatus(out, { TERM_PROGRAM: 'Apple_Terminal' }).update(reading());
    expect(out.writes).toEqual([`${PUSH}${ESC}]2;pup proj · 0 running · 0 need you${BEL}`]);
  });

  it('writes a question holding escapes inert', () => {
    const out = tty();
    const hostile = `${ESC}]0;pwned${BEL} \u009b31m\u007f x;status=idle`;
    createTerminalStatus(out, ITERM).update(reading(session({ question: hostile })));
    const [written] = out.writes;
    // The only ESC and BEL left are the writer's own.
    expect(written?.split(ESC).length).toBe(1 + 3 + 0); // push, title, status
    expect(written).not.toContain('\u009b');
    expect(written).not.toContain('\u007f');
    expect(written?.split(BEL).length).toBe(3);
    expect(written).toContain('detail=s-mtzmobsi-1: question: ]0,pwned 31m x,status=idle');
  });

  it.each([
    ['stdout is not a TTY', false, {}],
    ['TMUX is set', true, { ...ITERM, TMUX: '/tmp/tmux-501/default,1,0' }],
    ['PUP_DISABLE_TERMINAL_TITLE=1', true, { ...ITERM, PUP_DISABLE_TERMINAL_TITLE: '1' }],
  ])('writes nothing when %s', (_name, isTTY, env) => {
    const out = tty(isTTY);
    const writer = createTerminalStatus(out, env);
    writer.update(reading(session()));
    writer.stop();
    expect(out.writes).toEqual([]);
  });

  it('restores the title and clears the status on stop, once', () => {
    const out = tty();
    const writer = createTerminalStatus(out, ITERM);
    writer.update(reading());
    writer.update(reading());
    writer.stop();
    writer.stop();
    expect(out.writes).toHaveLength(3);
    expect(out.writes[1]).not.toContain(PUSH);
    expect(out.writes[2]).toBe(`${POP}${session21337('', '', '')}`);
  });
});

function Probe({ value, out }: { value: DashboardReading; out: ReturnType<typeof tty> }) {
  useTerminalStatus(value, out, ITERM);
  return createElement(Text, null, 'x');
}

describe('useTerminalStatus', () => {
  afterEach(cleanup);

  it('updates on a new reading and restores the tab on unmount', () => {
    const out = tty();
    const view = render(createElement(Probe, { value: reading(), out }));
    view.rerender(createElement(Probe, { value: reading(session()), out }));
    expect(out.writes).toHaveLength(2);
    view.unmount();
    expect(out.writes).toHaveLength(3);
    expect(out.writes[2]).toBe(`${POP}${session21337('', '', '')}`);
  });
});
