import { cleanup, render } from 'ink-testing-library';
import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardSession, DashboardSnapshot } from '../../core/types/dashboard.types.js';
import type { ActionDeps } from './actions.service.js';
import { App } from './app.component.js';
import { Backlog } from './backlog.component.js';
import { Debt } from './debt.component.js';
import { Detail } from './detail.component.js';
import { Footer } from './footer.component.js';
import { Header } from './header.component.js';
import { MergeLogPane } from './merge-log.component.js';
import { Prompt } from './prompt.component.js';
import { Radar } from './radar.component.js';
import { Sessions } from './sessions.component.js';
import type { DashboardReading } from './use-snapshot.hook.js';

/**
 * Every component renders one fixture snapshot and is asserted on the frame
 * text, which is the whole contract: a component that showed a value the
 * snapshot does not carry could not be written against this fixture at all
 * (decision 52). Colour is deliberately unasserted — the testing library's
 * stdout is not a terminal, so chalk writes none, and a test that pinned ANSI
 * codes would be testing chalk's TTY detection rather than the dashboard.
 */
/**
 * The App's controls take a store to write through; every case in this file is
 * about what is drawn, and none of them presses a key that reaches it.
 */
const DEPS = { db: {}, repoPath: '/repo/pupitre', pupBin: '/abs/pup.js' } as unknown as ActionDeps;

function snapshotFixture(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    projectId: 'ab12cd34ef56',
    repoPath: '/repo/pupitre',
    conductor: {
      running: false,
      name: 'pup-conductor-ab12cd34ef56',
      attachCommand: 'tmux -L pup-conductor-ab12cd34ef56 attach -t pup-conductor-ab12cd34ef56',
    },
    sessions: [],
    backlog: [],
    overdueDebt: [],
    openDebtCount: 0,
    overlaps: [],
    radarStale: false,
    ...overrides,
  };
}

/** One project's reading, as `pup ui` in a repo reads it. */
function readingOf(snapshot: DashboardSnapshot): DashboardReading {
  return { projects: [{ deps: DEPS, snapshot }], unreadable: [] };
}

function sessionFixture(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: 's-mtzmobsi-1',
    state: 'running',
    branch: 'pup/t-mtzmobsi',
    taskId: 't-mtzmobsi',
    goal: 'a live Ink dashboard',
    origin: 'human',
    scope: ['src/**'],
    acceptance: ['it works'],
    rejectCount: 0,
    needsHuman: false,
    recentEvents: [],
    ...overrides,
  };
}

const DOWN = '\u001b[B';
const UP = '\u001b[A';

/** The frame a component settles on, unmounted before the next one renders. */
function frameOf(element: ReactElement): string {
  const instance = render(element);
  const frame = instance.lastFrame() ?? '';
  instance.unmount();
  return frame;
}

afterEach(cleanup);

describe('dashboard components', () => {
  describe('header', () => {
    it('names the project and reports a conductor that is down', () => {
      const frame = frameOf(
        createElement(Header, { snapshot: snapshotFixture(), showAttach: true }),
      );

      expect(frame).toContain('ab12cd34ef56');
      expect(frame).toContain('/repo/pupitre');
      expect(frame).toContain('conductor down');
    });

    // The attach command carries the socket the conductor's window lives on,
    // and pup is not the thing that hands a session the way in (decision 47).
    it.each([
      [true, true],
      [false, false],
    ])('shows the attach command only when the caller may see it (%s)', (showAttach, visible) => {
      const snapshot = snapshotFixture({
        conductor: { ...snapshotFixture().conductor, running: true },
      });

      const frame = frameOf(createElement(Header, { snapshot, showAttach }));

      expect(frame).toContain('conductor running');
      expect(frame.includes('tmux -L pup-conductor-ab12cd34ef56')).toBe(visible);
    });

    it('prints the baseline figures it was given and skips the ones it was not', () => {
      const snapshot = snapshotFixture({
        baseline: { capturedAt: '2026-09-01T09:00:00.000Z', coverageRatio: 0.82, deadExports: 3 },
      });

      const frame = frameOf(createElement(Header, { snapshot, showAttach: true }));

      expect(frame).toContain('2026-09-01T09:00:00.000Z');
      expect(frame).toContain('coverage 82%');
      expect(frame).toContain('dead exports 3');
      expect(frame).not.toContain('dup');
    });
  });

  describe('sessions', () => {
    it('says so rather than drawing an empty table', () => {
      expect(
        frameOf(createElement(Sessions, { sessions: [], finishedCount: 0, selectedIndex: 0 })),
      ).toContain('no live sessions');
    });

    it('renders the state, the goal and the rejections a blocked session carries', () => {
      const frame = frameOf(
        createElement(Sessions, {
          finishedCount: 0,
          sessions: [sessionFixture({ state: 'blocked', rejectCount: 3, needsHuman: true })],
          selectedIndex: -1,
        }),
      );

      expect(frame).toContain('blocked');
      expect(frame).toContain('s-mtzmobsi-1');
      expect(frame).toContain('3 rej');
      expect(frame).toContain('a live Ink dashboard');
    });

    // Decision 35: staleness wins over the activity kind, whatever the last
    // classified event was.
    it('marks a stalled session STALLED over its activity kind', () => {
      const frame = frameOf(
        createElement(Sessions, {
          finishedCount: 0,
          sessions: [
            sessionFixture({
              activity: { kind: 'working' },
              stalledAgeMs: 12 * 60 * 1000,
              needsHuman: true,
            }),
          ],
          selectedIndex: 0,
        }),
      );

      expect(frame).toContain('STALLED (12m)');
    });

    // The same sentence `pup status` prints, off the same snapshot field: the
    // always-visible row must not differ between the two surfaces (decision 52,
    // addendum to decision 35).
    it("reads the watchdog's dead turn in place of the STALLED age", () => {
      const frame = frameOf(
        createElement(Sessions, {
          finishedCount: 0,
          sessions: [
            sessionFixture({
              activity: { kind: 'working' },
              stalledAgeMs: 12 * 60 * 1000,
              needsHuman: true,
              deadTurn: { reason: '⏺ API Error: Connection lost', at: '2026-09-13T10:02:00.000Z' },
            }),
          ],
          selectedIndex: 0,
        }),
      );

      expect(frame).toMatch(/TURN DIED \(API error\) — resumed by watch at \d{2}:\d{2}/);
      expect(frame).not.toContain('STALLED');
    });

    it('says a refused resume needs a human', () => {
      const frame = frameOf(
        createElement(Sessions, {
          finishedCount: 0,
          sessions: [
            sessionFixture({
              activity: { kind: 'working' },
              stalledAgeMs: 12 * 60 * 1000,
              needsHuman: true,
              deadTurn: {
                reason: '⏺ API Error: Connection lost',
                at: '2026-09-13T10:02:00.000Z',
                refusal: 'did not land',
              },
            }),
          ],
          selectedIndex: 0,
        }),
      );

      // The `needs a human` tail falls off the 100-column frame behind the id
      // column, as it does on a narrow terminal: `refused` is the word the row
      // has to carry, and the red, bold row is what draws the eye to it.
      expect(frame).toMatch(/TURN DIED \(API error\) — resume refused at \d{2}:\d{2}/);
    });

    it('marks a session waiting on input with what it is waiting for', () => {
      const frame = frameOf(
        createElement(Sessions, {
          finishedCount: 0,
          sessions: [
            sessionFixture({ activity: { kind: 'awaiting-input', detail: 'Bash permission' } }),
          ],
          selectedIndex: 0,
        }),
      );

      expect(frame).toContain('WAITING ON INPUT (Bash permission)');
    });

    it('shows the context reading, the last gate and the last steer', () => {
      const frame = frameOf(
        createElement(Sessions, {
          finishedCount: 0,
          sessions: [
            sessionFixture({
              contextTokens: 45_000,
              lastGate: {
                passed: false,
                failedStage: 'tests',
                stages: [{ stage: 'tests', status: 'fail' }],
                at: '2026-09-13T10:00:00.000Z',
              },
              lastSteer: { kind: 'manual', by: 'operator', at: '2026-09-13T10:01:00.000Z' },
            }),
          ],
          selectedIndex: 0,
        }),
      );

      expect(frame).toContain('ctx ~45k');
      expect(frame).toContain('gate fail: tests');
      expect(frame).toContain('steer manual (operator)');
    });

    it('marks only the selected row', () => {
      const frame = frameOf(
        createElement(Sessions, {
          finishedCount: 0,
          sessions: [sessionFixture(), sessionFixture({ id: 's-second-1' })],
          selectedIndex: 1,
        }),
      );

      const [first, second] = frame.split('\n');
      expect(first?.startsWith('  ')).toBe(true);
      expect(second?.startsWith('> ')).toBe(true);
    });
    // 27 merged sessions pushed the header, the radar and the footer off a
    // 40-row screen the first time this rendered against pupitre's own store.
    it('counts the finished sessions the caller kept back instead of listing them', () => {
      const frame = frameOf(
        createElement(Sessions, { sessions: [], finishedCount: 27, selectedIndex: 0 }),
      );

      expect(frame).toContain('no live sessions');
      expect(frame).toContain('27 finished');
      expect(frame).toContain('`pup status` lists them');
    });
  });

  describe('backlog', () => {
    it('lists a planned task under `planned`, naming a non-human origin', () => {
      const frame = frameOf(
        createElement(Backlog, {
          backlog: [
            {
              id: 't-one',
              goal: 'extract the gh exec options',
              scope: ['src/**'],
              acceptance: [],
              origin: 'human',
            },
            {
              id: 't-two',
              goal: 'index the worktree',
              scope: ['src/**'],
              acceptance: [],
              origin: 'conductor',
            },
          ],
          selectedIndex: 1,
        }),
      );

      expect(frame).toContain('planned');
      expect(frame).toContain('extract the gh exec options');
      expect(frame).toContain('(from conductor)');
      // The operator's own tasks carry no marker: the marker exists to say a
      // spec was authored by something that is not the operator.
      expect(frame.split('\n')[0]).not.toContain('(from');
    });

    it('renders nothing at all when nothing is planned', () => {
      expect(frameOf(createElement(Backlog, { backlog: [], selectedIndex: 0 }))).toBe('');
    });
  });

  describe('debt', () => {
    it('shows every overdue entry with its review-by condition, and the open count', () => {
      const frame = frameOf(
        createElement(Debt, {
          overdueDebt: [
            { id: 8, description: 'shortcut taken', reviewBy: 'before the next release' },
          ],
          openDebtCount: 3,
        }),
      );

      expect(frame).toContain('OVERDUE DEBT #8');
      expect(frame).toContain('shortcut taken');
      expect(frame).toContain('(review by: before the next release)');
      expect(frame).toContain('3 open debt entries');
    });

    it('renders nothing when the ledger is clean', () => {
      expect(frameOf(createElement(Debt, { overdueDebt: [], openDebtCount: 0 }))).toBe('');
    });
  });

  describe('radar', () => {
    it('names the pair, counts the files behind the first, and flags a dead radar', () => {
      const frame = frameOf(
        createElement(Radar, {
          overlaps: [{ sessionA: 's-a-1', sessionB: 's-b-1', files: ['src/a.ts', 'src/b.ts'] }],
          radarStale: true,
        }),
      );

      expect(frame).toContain('OVERLAP  s-a-1 <-> s-b-1  src/a.ts (+1 more)  (stale)');
      expect(frame).toContain('conflict radar off');
    });

    it('renders nothing when the radar is live and finds no overlap', () => {
      expect(frameOf(createElement(Radar, { overlaps: [], radarStale: false }))).toBe('');
    });
  });

  describe('footer', () => {
    it('lists every key, and what the last one did', () => {
      const frame = frameOf(
        createElement(Footer, {
          refreshedAt: '10:00:00',
          status: { message: 'Launched s-new-1.', failed: false },
        }),
      );

      expect(frame).toContain('Launched s-new-1.');
      expect(frame).toContain('↑/↓ select');
      expect(frame).toContain('Enter/Esc detail');
      expect(frame).toContain('k kill');
      expect(frame).toContain('m merge');
      expect(frame).toContain('q quit');
      expect(frame).toContain('10:00:00');
    });

    // A menu of keys that answer nothing is worse than no menu: a caller that
    // may not drive the fleet is told so and shown only what still works
    // (decision 47).
    it('drops the mutating keys and gives the reason when the view is read-only', () => {
      const frame = frameOf(
        createElement(Footer, {
          refreshedAt: '10:00:00',
          readOnlyReason: 'read-only: sessions do not drive sessions.',
        }),
      );

      expect(frame).toContain('read-only: sessions do not drive sessions.');
      expect(frame).not.toContain('k kill');
      expect(frame).not.toContain('m merge');
      expect(frame).toContain('↑/↓ select');
      expect(frame).toContain('Enter/Esc detail');
      expect(frame).toContain('q quit');
    });
  });

  describe('detail', () => {
    it("draws a session's goal, scope, acceptance, gate stages and last events", () => {
      const frame = frameOf(
        createElement(Detail, {
          row: {
            kind: 'session',
            session: sessionFixture({
              state: 'awaiting-review',
              origin: 'conductor',
              scope: ['src/core/**', 'docs/02-cli.md'],
              acceptance: ['the snapshot carries it', 'Enter opens the pane'],
              lastGate: {
                passed: false,
                failedStage: 'coverage',
                stages: [
                  { stage: 'worktree-clean', status: 'pass' },
                  { stage: 'coverage', status: 'fail', detail: '71% < 80%' },
                ],
                at: '2026-09-13T10:00:00.000Z',
              },
              recentEvents: [
                { type: 'steer', at: '2026-09-13T09:00:00.000Z', detail: 'kickoff' },
                { type: 'session_done', at: '2026-09-13T09:58:00.000Z', detail: 'pane is in' },
              ],
            }),
          },
        }),
      );

      expect(frame).toContain('awaiting-review s-mtzmobsi-1 pup/t-mtzmobsi (from conductor)');
      expect(frame).toContain('Esc closes');
      expect(frame).toContain('a live Ink dashboard');
      expect(frame).toContain('src/core/**');
      expect(frame).toContain('docs/02-cli.md');
      expect(frame).toContain('- the snapshot carries it');
      expect(frame).toContain('- Enter opens the pane');
      expect(frame).toContain('last gate — failed 2026-09-13T10:00:00.000Z');
      expect(frame).toMatch(/worktree-clean\s+pass/);
      expect(frame).toMatch(/coverage\s+fail {2}71% < 80%/);
      expect(frame).toMatch(/2026-09-13T09:00:00.000Z steer\s+kickoff/);
      expect(frame).toMatch(/2026-09-13T09:58:00.000Z session_done\s+pane is in/);
    });

    it('says what a session does not have yet rather than drawing empty sections', () => {
      const frame = frameOf(
        createElement(Detail, {
          row: { kind: 'session', session: sessionFixture({ scope: [], acceptance: [] }) },
        }),
      );

      expect(frame).toContain('none declared');
      expect(frame).toContain('no gate run yet');
      expect(frame).toContain('no events yet');
    });

    // The snapshot carries no gate and no events for a task nobody has
    // launched, so the pane has none to draw — and says why.
    it('draws a planned task with its intent and no history', () => {
      const frame = frameOf(
        createElement(Detail, {
          row: {
            kind: 'task',
            task: {
              id: 't-planned',
              goal: 'index the worktree',
              scope: ['src/core/**'],
              acceptance: ['the index is current'],
              origin: 'human',
            },
          },
        }),
      );

      expect(frame).toContain('planned t-planned');
      expect(frame).toContain('index the worktree');
      expect(frame).toContain('src/core/**');
      expect(frame).toContain('- the index is current');
      expect(frame).toContain('not launched: no gate run and no events yet');
      expect(frame).not.toContain('last gate');
    });
  });

  describe('prompt', () => {
    it('asks a confirmation with both answers on it', () => {
      const frame = frameOf(
        createElement(Prompt, { prompt: { kind: 'confirm', question: 'Kill s-run-1?' } }),
      );

      expect(frame).toContain('Kill s-run-1?');
      expect(frame).toContain('(y/n, Esc cancels)');
    });

    it('shows what has been typed into a field so far', () => {
      const frame = frameOf(
        createElement(Prompt, { prompt: { kind: 'input', label: 'steer s-run-1', value: 'read' } }),
      );

      expect(frame).toContain('steer s-run-1: read');
      expect(frame).toContain('Enter sends');
    });
  });

  describe('merge log', () => {
    it('names the command it is running and says it has nothing yet', () => {
      const frame = frameOf(
        createElement(MergeLogPane, {
          log: { sessionId: 's-run-1', lines: [], firstLine: 0, running: true },
        }),
      );

      expect(frame).toContain('pup merge s-run-1 --pr');
      expect(frame).toContain('(running)');
      expect(frame).toContain('waiting for the first stage');
    });

    it('draws the stages the child has printed, and how to close the pane', () => {
      const frame = frameOf(
        createElement(MergeLogPane, {
          log: {
            sessionId: 's-run-1',
            lines: ['  tests           PASS', '  dead-code       FAIL'],
            firstLine: 0,
            running: false,
          },
        }),
      );

      expect(frame).toContain('tests           PASS');
      expect(frame).toContain('dead-code       FAIL');
      expect(frame).toContain('Enter or Esc closes');
    });
  });

  describe('app', () => {
    const populated = snapshotFixture({
      sessions: [
        sessionFixture({ state: 'blocked', rejectCount: 2, needsHuman: true }),
        sessionFixture({ id: 's-done-1', state: 'merged', goal: 'already landed' }),
      ],
      backlog: [
        {
          id: 't-two',
          goal: 'index the worktree',
          scope: ['src/**'],
          acceptance: [],
          origin: 'conductor',
        },
      ],
      overdueDebt: [{ id: 8, description: 'shortcut taken', reviewBy: 'next release' }],
      openDebtCount: 1,
      overlaps: [{ sessionA: 's-a-1', sessionB: 's-b-1', files: ['src/a.ts'] }],
      radarStale: true,
    });

    it('lays out every section from one reading', () => {
      const frame = frameOf(
        createElement(App, { read: () => readingOf(populated), showAttach: true }),
      );

      expect(frame).toContain('ab12cd34ef56');
      expect(frame).toContain('OVERDUE DEBT #8');
      expect(frame).toContain('blocked');
      expect(frame).toContain('planned');
      expect(frame).toContain('OVERLAP');
      expect(frame).toContain('q quit');
      // A merged session is behind the count, and the cursor cannot reach it.
      expect(frame).not.toContain('already landed');
      expect(frame).toContain('1 finished');
    });

    // The cursor spans the session rows and the planned rows beneath them: on
    // screen they are one list, and every action acts on whichever row it sits
    // on. Arrows only — `k` is the kill now, and a key that sometimes moves the
    // cursor and sometimes proposes killing a session is neither.
    it('moves one cursor down from the last session onto the backlog', async () => {
      const instance = render(
        createElement(App, { read: () => readingOf(populated), showAttach: true }),
      );
      expect(instance.lastFrame()).toMatch(/^\s*> blocked/m);

      instance.stdin.write(DOWN);
      await Promise.resolve();

      expect(instance.lastFrame()).toMatch(/^\s*> planned/m);
      expect(instance.lastFrame()).toMatch(/^\s+blocked/m);
      instance.unmount();
    });

    it('holds the cursor at the ends of the list', async () => {
      const instance = render(
        createElement(App, { read: () => readingOf(populated), showAttach: true }),
      );

      instance.stdin.write(UP);
      await Promise.resolve();
      expect(instance.lastFrame()).toMatch(/^\s*> blocked/m);

      instance.stdin.write(DOWN);
      instance.stdin.write(DOWN);
      await Promise.resolve();
      expect(instance.lastFrame()).toMatch(/^\s*> planned/m);
      instance.unmount();
    });

    // Decision 61: `pup ui --all` puts several stores' rows in one table, and
    // the project column that tells them apart is drawn only when there is
    // more than one project to tell apart.
    describe('across projects', () => {
      const other = snapshotFixture({
        projectId: 'bbbbbbbbbbbb',
        repoPath: '/repo/other',
        conductor: { running: true, name: 'pup-conductor-bbbbbbbbbbbb', attachCommand: 'tmux …' },
        // The same session id as the first project's: ids are unique per store.
        sessions: [sessionFixture()],
        backlog: [
          { id: 't-other', goal: 'the other plan', scope: [], acceptance: [], origin: 'human' },
        ],
        overdueDebt: [{ id: 8, description: 'the other shortcut', reviewBy: 'soon' }],
        openDebtCount: 1,
        overlaps: [{ sessionA: 's-x-1', sessionB: 's-y-1', files: ['src/x.ts'] }],
      });

      function fleetFrame(
        reading: Omit<DashboardReading, 'projects'> & { snapshots: DashboardSnapshot[] },
      ) {
        return frameOf(
          createElement(App, {
            read: () => ({
              projects: reading.snapshots.map((snapshot) => ({ deps: DEPS, snapshot })),
              unreadable: reading.unreadable,
            }),
            showAttach: true,
          }),
        );
      }

      it('leads every row with its project when two are live', () => {
        const frame = fleetFrame({ snapshots: [populated, other], unreadable: [] });

        expect(frame).toMatch(/^\s*> ab12cd34ef56 {2}blocked +s-mtzmobsi-1/m);
        expect(frame).toMatch(/^ {3}bbbbbbbbbbbb {2}running +s-mtzmobsi-1/m);
        expect(frame).toMatch(/^ {3}ab12cd34ef56 {2}planned +t-two/m);
        expect(frame).toMatch(/^ {3}bbbbbbbbbbbb {2}planned +t-other/m);
        // One line per project in the header, as the fleet `pup status` heads its blocks.
        expect(frame).toMatch(/^ ab12cd34ef56 {2}\/repo\/pupitre {2}conductor down$/m);
        expect(frame).toMatch(/^ bbbbbbbbbbbb {2}\/repo\/other {2}conductor running$/m);
        expect(frame).not.toContain('attach:');
        // Ledger numbers and radars are per store, so each line says whose.
        expect(frame).toContain('ab12cd34ef56  OVERDUE DEBT #8  shortcut taken');
        expect(frame).toContain('bbbbbbbbbbbb  OVERDUE DEBT #8  the other shortcut');
        expect(frame).toContain('bbbbbbbbbbbb  OVERLAP  s-x-1 <-> s-y-1');
        expect(frame).toContain('ab12cd34ef56  conflict radar off');
        expect(frame).toContain('1 finished');
      });

      // A foreign store's `projects` row is session-writable (decision 29).
      it('strips what a terminal would obey out of a project’s repo path', () => {
        const hostile = { ...other, repoPath: '/repo/\u001b[2Jother' };

        const frame = fleetFrame({ snapshots: [populated, hostile], unreadable: [] });

        expect(frame).toContain('bbbbbbbbbbbb  /repo/ [2Jother  conductor running');
        expect(frame).not.toContain('\u001b[2J');
      });

      it('draws no column for a single project, whatever the flag', () => {
        const frame = fleetFrame({ snapshots: [populated], unreadable: [] });

        expect(frame).toMatch(/^\s*> blocked +s-mtzmobsi-1/m);
        expect(frame).toMatch(/^ {3}planned +t-two/m);
        expect(frame).toContain('pupitre ab12cd34ef56 /repo/pupitre');
        expect(frame).toMatch(/^ OVERDUE DEBT #8/m);
      });

      it('says which projects it could not read, beside the ones it could', () => {
        const unreadable = ['cccccccccccc  /gone  missing: the repo no longer exists'];

        const one = fleetFrame({ snapshots: [populated], unreadable });
        const none = fleetFrame({ snapshots: [], unreadable });

        expect(one).toContain(unreadable[0]);
        expect(one).toMatch(/^\s*> blocked +s-mtzmobsi-1/m);
        expect(none).toContain(unreadable[0]);
        expect(none).toContain('no live sessions');
      });
    });

    it('re-reads the store on `r`, without waiting for the interval', async () => {
      let reads = 0;
      const instance = render(
        createElement(App, {
          read: () => {
            reads += 1;
            return readingOf(
              snapshotFixture({
                backlog: [
                  {
                    id: `t-read-${reads}`,
                    goal: 'a fresh reading',
                    scope: [],
                    acceptance: [],
                    origin: 'human',
                  },
                ],
              }),
            );
          },
          showAttach: true,
        }),
      );
      expect(instance.lastFrame()).toContain('t-read-1');

      instance.stdin.write('r');
      await Promise.resolve();

      expect(instance.lastFrame()).toContain('t-read-2');
      instance.unmount();
    });
  });
});
