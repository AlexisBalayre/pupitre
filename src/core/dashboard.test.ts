import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux boundary only: the store, the events files and the transcripts all
// run for real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  hasConductorWindow: vi.fn(() => false),
}));

import { hasConductorWindow } from '../claude/session-runtime.service.js';
import {
  blockedReason,
  buildDashboardSnapshot,
  findStalledSessions,
  fleetSummary,
  goalHeadline,
} from './dashboard.service.js';
import type { SessionState } from './db.client.js';
import { openStore } from './db.client.js';
import { insertLedgerEntry } from './ledger.repository.js';
import { recordWatcherBeat, replaceOverlaps } from './overlap.repository.js';
import { WATCH_STALE_AFTER_MS } from './overlap.service.js';
import { projectId, projectPaths } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  incrementRejectCount,
  insertSession,
  insertTask,
  saveProjectBaseline,
  transitionSession,
} from './session.repository.js';
import { STALLED_AFTER_MS } from './session-activity.constants.js';
import type { ProjectBaseline } from './types/init.types.js';
import type { TaskSpec } from './types/profile.types.js';

const NOW = Date.parse('2026-09-13T12:00:00Z');
const API_ERROR = '⏺ API Error: Connection lost while your computer was asleep';

/**
 * A repo path and nothing more: the snapshot reads the store and the events
 * files, and never shells out to git, so the directory is only what the project
 * id and the sessions directory are keyed on.
 */
function tempRepo(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'pup-dash-')));
}

function seedTask(
  db: Database,
  repo: string,
  taskId: string,
  goal: string,
  origin = 'human',
  spec: Partial<TaskSpec> = {},
): void {
  ensureProject(db, projectId(repo), repo);
  insertTask(db, {
    id: taskId,
    projectId: projectId(repo),
    spec: JSON.stringify({ id: taskId, goal, scopeIn: ['src/**'], acceptance: ['done'], ...spec }),
    origin,
  });
}

function seedSession(
  db: Database,
  repo: string,
  sessionId: string,
  options: {
    goal?: string;
    origin?: string;
    transcriptPath?: string;
    spec?: Partial<TaskSpec>;
  } = {},
): void {
  const taskId = `t-${sessionId}`;
  seedTask(db, repo, taskId, options.goal ?? `goal for ${sessionId}`, options.origin, options.spec);
  insertSession(db, {
    id: sessionId,
    taskId,
    worktreePath: join(repo, '.worktrees', sessionId),
    branch: `pup/${sessionId}`,
    profileHash: 'hash',
    ...(options.transcriptPath ? { transcriptPath: options.transcriptPath } : {}),
  });
}

/** One hook event on disk, with the file's mtime aged by `ageMs` (decision 35). */
function seedEventsFile(repo: string, sessionId: string, event: object, ageMs = 0): void {
  const paths = projectPaths(repo);
  mkdirSync(paths.sessionDir(sessionId), { recursive: true });
  writeFileSync(paths.eventsFile(sessionId), `${JSON.stringify(event)}\n`);
  const at = new Date(NOW - ageMs);
  utimesSync(paths.eventsFile(sessionId), at, at);
}

/**
 * A session id that is a relative path, and the events file it would reach if
 * anything joined it into `<store>/sessions/<id>` — two levels up, beside the
 * project directories rather than inside this project's sessions (decision 66).
 */
const ESCAPING_ID = '../../marker';

/**
 * Plant a marker events file where `ESCAPING_ID` would land: aged past the
 * stall bar and carrying a hook event that classifies, so a reader that opens
 * or stats it says so in the snapshot it returns.
 */
function seedEscapedMarker(repo: string): string {
  const escaped = join(projectPaths(repo).sessionsDir, ESCAPING_ID, 'events.jsonl');
  mkdirSync(dirname(escaped), { recursive: true });
  writeFileSync(escaped, `${JSON.stringify({ hook_event_name: 'PostToolUse' })}\n`);
  const at = new Date(NOW - STALLED_AFTER_MS - 60_000);
  utimesSync(escaped, at, at);
  return escaped;
}

/** A transcript directory whose newest assistant entry carries `tokens`. */
function seedTranscript(tokens: number): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-dash-tx-')));
  writeFileSync(
    join(dir, 'session.jsonl'),
    `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: tokens } } })}\n`,
  );
  return dir;
}

describe('buildDashboardSnapshot', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    // projectPaths resolves the sessions directory under homedir() — point it
    // at a throwaway HOME, or the run writes into the developer's real
    // ~/.pupitre, which the merge gate's sandbox refuses outright.
    vi.stubEnv('HOME', realpathSync(mkdtempSync(join(tmpdir(), 'pup-dashboard-home-'))));
    db = openStore(':memory:');
    repo = tempRepo();
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
  });

  it('names the project it was taken from', () => {
    ensureProject(db, projectId(repo), repo);

    const snapshot = buildDashboardSnapshot(db, repo, NOW);

    expect(snapshot).toMatchObject({ projectId: projectId(repo), repoPath: repo });
  });

  describe('baseline', () => {
    it('reports the debt figures the last capture measured', () => {
      ensureProject(db, projectId(repo), repo);
      const baseline: ProjectBaseline = {
        capturedAt: '2026-09-01T09:00:00Z',
        adapters: ['typescript'],
        stages: [],
        debt: {
          coverageRatio: 0.82,
          duplicatedLines: 140,
          deadExports: [
            { file: 'src/a.ts', exportName: 'unused' },
            { file: 'src/b.ts', exportName: 'alsoUnused' },
          ],
        },
      };
      saveProjectBaseline(db, projectId(repo), ['typescript'], JSON.stringify(baseline));

      const snapshot = buildDashboardSnapshot(db, repo, NOW);

      expect(snapshot.baseline).toEqual({
        capturedAt: '2026-09-01T09:00:00Z',
        coverageRatio: 0.82,
        duplicatedLines: 140,
        deadExports: 2,
      });
    });

    it('has no baseline before `pup init` has captured one', () => {
      ensureProject(db, projectId(repo), repo);

      expect(buildDashboardSnapshot(db, repo, NOW).baseline).toBeUndefined();
    });
  });

  describe('conductor', () => {
    it('reports the window and the socket-pinned command that attaches to it', () => {
      vi.mocked(hasConductorWindow).mockReturnValue(true);

      const { conductor } = buildDashboardSnapshot(db, repo, NOW);

      expect(conductor.running).toBe(true);
      expect(conductor.attachCommand).toBe(
        `tmux -L pup-conductor-${projectId(repo)} attach -t ${conductor.name}`,
      );
    });

    it('still names the window when the conductor is down', () => {
      vi.mocked(hasConductorWindow).mockReturnValue(false);

      const { conductor } = buildDashboardSnapshot(db, repo, NOW);

      expect(conductor).toMatchObject({ running: false, name: `pup-conductor-${projectId(repo)}` });
    });
  });

  describe('sessions', () => {
    it('carries the row, its task intent and who asked for the work', () => {
      seedSession(db, repo, 's1', {
        goal: 'move the stall rule\ninto the service',
        origin: 'conductor',
      });
      transitionSession(db, 's1', 'running');
      incrementRejectCount(db, 's1');

      const [session] = buildDashboardSnapshot(db, repo, NOW).sessions;

      expect(session).toMatchObject({
        id: 's1',
        state: 'running',
        branch: 'pup/s1',
        taskId: 't-s1',
        goal: 'move the stall rule',
        origin: 'conductor',
        scope: ['src/**'],
        acceptance: ['done'],
        rejectCount: 1,
        needsHuman: false,
      });
    });

    // The detail pane prints both whole, so both are terminal text (decision 29).
    it("carries the task's scope and acceptance, stripped of what a terminal would obey", () => {
      seedSession(db, repo, 's1', {
        spec: {
          scopeIn: ['src/core/**', '\u001b[2Jdocs/**'],
          acceptance: ['the snapshot carries it', 'Enter opens\nthe pane'],
        },
      });

      const [session] = buildDashboardSnapshot(db, repo, NOW).sessions;

      expect(session?.scope).toEqual(['src/core/**', '[2Jdocs/**']);
      expect(session?.acceptance).toEqual(['the snapshot carries it', 'Enter opens the pane']);
    });

    it('classifies a running session from its hook events, detail included', () => {
      seedSession(db, repo, 's1');
      transitionSession(db, 's1', 'running');
      seedEventsFile(repo, 's1', {
        hook_event_name: 'Notification',
        message: 'Claude needs your permission to use Bash',
      });

      const [session] = buildDashboardSnapshot(db, repo, NOW).sessions;

      expect(session?.activity).toEqual({
        kind: 'awaiting-input',
        detail: 'Claude needs your permission to use Bash',
      });
      expect(session?.needsHuman).toBe(true);
    });

    it('leaves activity unread for a session that is no longer running', () => {
      seedSession(db, repo, 's1');
      transitionSession(db, 's1', 'running');
      transitionSession(db, 's1', 'awaiting-review');
      seedEventsFile(repo, 's1', { hook_event_name: 'Stop' });

      expect(buildDashboardSnapshot(db, repo, NOW).sessions[0]?.activity).toBeUndefined();
    });

    it('ages a running session whose events file has gone quiet (decision 35)', () => {
      seedSession(db, repo, 's1');
      transitionSession(db, 's1', 'running');
      seedEventsFile(repo, 's1', { hook_event_name: 'PostToolUse' }, STALLED_AFTER_MS + 60_000);

      const [session] = buildDashboardSnapshot(db, repo, NOW).sessions;

      expect(session?.stalledAgeMs).toBe(STALLED_AFTER_MS + 60_000);
      expect(session?.needsHuman).toBe(true);
    });

    it('never reads outside the sessions dir for a row whose id is a path (decision 66)', () => {
      // The fleet views read every registered project's store (decisions
      // 60-62), and a session can write its own store: an id like `../../x`
      // would otherwise have `pup status` and `pup ui` stat and read a file
      // two levels above this project's sessions directory.
      seedSession(db, repo, ESCAPING_ID);
      transitionSession(db, ESCAPING_ID, 'running');
      const marker = seedEscapedMarker(repo);

      const [session] = buildDashboardSnapshot(db, repo, NOW).sessions;

      // The row is still there for the operator who has to clean it up, id
      // printed through decision 61's sanitizing.
      expect(session?.id).toBe(ESCAPING_ID);
      // Nothing was opened: the marker would classify as `working`.
      expect(session?.activity).toBeUndefined();
      // Nothing was stat'ed: the marker's mtime is an hour past the stall bar.
      expect(session?.stalledAgeMs).toBeUndefined();
      expect(session?.needsHuman).toBe(false);
      // And the file the reader must not have touched is still where it was.
      expect(existsSync(marker)).toBe(true);
    });

    // The watchdog's record, read back off the store — not off the pane it
    // captured, which it deliberately did not keep (addendum to decision 35).
    describe('dead turn', () => {
      /** A running session gone quiet past the stall bar, and the stall's name. */
      function seedStalled(sessionId: string, ageMs = STALLED_AFTER_MS + 60_000): string {
        seedSession(db, repo, sessionId);
        transitionSession(db, sessionId, 'running');
        seedEventsFile(repo, sessionId, { hook_event_name: 'PostToolUse' }, ageMs);
        return new Date(NOW - ageMs).toISOString();
      }

      it('carries what the watchdog recorded against the stall the session is in', () => {
        const stalledAt = seedStalled('s1');
        appendEvent(db, 's1', 'turn_died', { reason: API_ERROR, stalledAt });

        const [session] = buildDashboardSnapshot(db, repo, NOW).sessions;

        expect(session?.deadTurn).toMatchObject({ reason: API_ERROR });
        expect(session?.deadTurn?.refusal).toBeUndefined();
        expect(Date.parse(session?.deadTurn?.at ?? '')).toBeGreaterThan(0);
      });

      it('carries the refusal that left the resume for a human', () => {
        const stalledAt = seedStalled('s1');
        appendEvent(db, 's1', 'turn_died', {
          reason: API_ERROR,
          stalledAt,
          refusal: 'did not land',
        });

        expect(buildDashboardSnapshot(db, repo, NOW).sessions[0]?.deadTurn).toMatchObject({
          refusal: 'did not land',
        });
      });

      it('is the newest of several resumes of the same stall', () => {
        const stalledAt = seedStalled('s1');
        appendEvent(db, 's1', 'turn_died', {
          reason: API_ERROR,
          stalledAt,
          refusal: 'did not land',
        });
        appendEvent(db, 's1', 'turn_died', { reason: '⏺ API Error: ENOTFOUND', stalledAt });

        const { deadTurn } = buildDashboardSnapshot(db, repo, NOW).sessions[0] ?? {};

        expect(deadTurn?.reason).toBe('⏺ API Error: ENOTFOUND');
        expect(deadTurn?.refusal).toBeUndefined();
      });

      // An hour-old resume stays off the row of a session that has since
      // worked and stalled again for some other reason.
      it('is absent when the record belongs to an earlier stall', () => {
        seedStalled('s1');
        appendEvent(db, 's1', 'turn_died', {
          reason: API_ERROR,
          stalledAt: new Date(NOW - STALLED_AFTER_MS * 5).toISOString(),
        });

        expect(buildDashboardSnapshot(db, repo, NOW).sessions[0]?.deadTurn).toBeUndefined();
      });

      it('is absent for a session that is stalled with nothing recorded, and for a fresh one', () => {
        seedStalled('s-stalled');
        seedSession(db, repo, 's-fresh');
        transitionSession(db, 's-fresh', 'running');
        seedEventsFile(repo, 's-fresh', { hook_event_name: 'PostToolUse' });
        appendEvent(db, 's-fresh', 'turn_died', {
          reason: API_ERROR,
          stalledAt: new Date(NOW).toISOString(),
        });

        const sessions = buildDashboardSnapshot(db, repo, NOW).sessions;

        expect(sessions.find((s) => s.id === 's-stalled')?.deadTurn).toBeUndefined();
        expect(sessions.find((s) => s.id === 's-fresh')?.deadTurn).toBeUndefined();
      });

      it("strips what a terminal would obey out of the pane's own error line", () => {
        const stalledAt = seedStalled('s1');
        appendEvent(db, 's1', 'turn_died', {
          reason: '\u001b[2JAPI Error',
          stalledAt,
          refusal: '\u001b[2Jdid not land',
        });

        expect(buildDashboardSnapshot(db, repo, NOW).sessions[0]?.deadTurn).toMatchObject({
          reason: '[2JAPI Error',
          refusal: '[2Jdid not land',
        });
      });
    });

    it('reads the context a running session carried into its last turn', () => {
      seedSession(db, repo, 's1', { transcriptPath: seedTranscript(90_000) });
      transitionSession(db, 's1', 'running');

      expect(buildDashboardSnapshot(db, repo, NOW).sessions[0]?.contextTokens).toBe(90_000);
    });

    it('reports the newest steer with its kind and its sender', () => {
      seedSession(db, repo, 's1');
      transitionSession(db, 's1', 'running');
      appendEvent(db, 's1', 'steer', { kind: 'kickoff', delivered: true });
      appendEvent(db, 's1', 'steer', { kind: 'message', by: 'conductor' });

      expect(buildDashboardSnapshot(db, repo, NOW).sessions[0]?.lastSteer).toMatchObject({
        kind: 'message',
        by: 'conductor',
      });
    });

    it('reports the newest real gate run and the stage that failed it', () => {
      seedSession(db, repo, 's1');
      transitionSession(db, 's1', 'running');
      appendEvent(db, 's1', 'gate_result', {
        report: {
          sessionId: 's1',
          passed: false,
          sandbox: 'none',
          stages: [
            { stage: 'lint', status: 'pass' },
            { stage: 'tests', status: 'fail', detail: '2 failing' },
          ],
        },
      });
      // A plain transition logs a gate_result too; with no report it says
      // nothing about passing, so it must not shadow the run above.
      transitionSession(db, 's1', 'awaiting-review');

      expect(buildDashboardSnapshot(db, repo, NOW).sessions[0]?.lastGate).toMatchObject({
        passed: false,
        failedStage: 'tests',
        stages: [
          { stage: 'lint', status: 'pass' },
          { stage: 'tests', status: 'fail', detail: '2 failing' },
        ],
      });
    });

    // A stage detail is a failing test's own output, and the report is a
    // payload a session can write: a torn member drops out, the rest is one
    // terminal-safe line each.
    it("lists the last gate's stages, dropping a malformed one and sanitizing the rest", () => {
      seedSession(db, repo, 's1');
      transitionSession(db, 's1', 'running');
      appendEvent(db, 's1', 'gate_result', {
        report: {
          sessionId: 's1',
          passed: false,
          sandbox: 'none',
          stages: [
            null,
            { stage: 'build' },
            { stage: 'tests', status: 'fail', detail: '\u001b[31mFAIL\u001b[0m\n  at a.test.ts' },
          ],
        },
      });

      expect(buildDashboardSnapshot(db, repo, NOW).sessions[0]?.lastGate?.stages).toEqual([
        { stage: 'tests', status: 'fail', detail: '\uFFFD[31mFAIL\uFFFD[0m at a.test.ts' },
      ]);
    });

    describe('recent events', () => {
      it('carries the newest five, oldest of them first, each with what its payload says', () => {
        seedSession(db, repo, 's1');
        transitionSession(db, 's1', 'running');
        appendEvent(db, 's1', 'steer', { kind: 'kickoff', delivered: true });
        appendEvent(db, 's1', 'steer', { kind: 'message', by: 'conductor' });
        appendEvent(db, 's1', 'interrupt', { steered: false });
        appendEvent(db, 's1', 'gate_result', {
          outcome: 'refused',
          report: {
            sessionId: 's1',
            passed: false,
            sandbox: 'none',
            stages: [{ stage: 'tests', status: 'fail' }],
          },
        });
        appendEvent(db, 's1', 'session_done', { summary: 'the pane is in' });
        transitionSession(db, 's1', 'awaiting-review');

        const { recentEvents } = buildDashboardSnapshot(db, repo, NOW).sessions[0] ?? {};

        // The `queued → running` transition and the kickoff are the two that
        // fell off the front.
        expect(recentEvents?.map(({ type, detail }) => ({ type, detail }))).toEqual([
          { type: 'steer', detail: 'message · by conductor' },
          { type: 'interrupt', detail: undefined },
          { type: 'gate_result', detail: 'gate failed at tests · refused' },
          { type: 'session_done', detail: 'the pane is in' },
          { type: 'gate_result', detail: 'running → awaiting-review' },
        ]);
        expect(recentEvents?.every((event) => Date.parse(event.at) > 0)).toBe(true);
      });

      // A planted store under ~/.pupitre authors every id `pup ui --all` draws
      // (decision 61): the backlog's, the ledger's and the radar's too. The
      // ledger table is planted before `openStore` runs, as a session would
      // plant it, so its id column has no INTEGER affinity to lean on.
      it('strips what a terminal would obey out of task, ledger and overlap ids', () => {
        const file = join(tempRepo(), 'state.db');
        const planted = new BetterSqlite3(file);
        planted.exec(
          'CREATE TABLE ledger_entries (id TEXT, project_id TEXT, description TEXT, ' +
            "files TEXT DEFAULT '[]', reason TEXT, accepted_by TEXT, review_by TEXT, " +
            "status TEXT DEFAULT 'open', created_at TEXT)",
        );
        planted.close();
        const store = openStore(file);
        const pid = projectId(repo);
        try {
          ensureProject(store, pid, repo);
          insertTask(store, { id: 't-\u001b[2Jplan', projectId: pid, spec: '{}' });
          store
            .prepare(
              'INSERT INTO ledger_entries (id, project_id, description, reason, accepted_by, review_by) ' +
                "VALUES (?, ?, 'd', 'r', 'human', '2020-01-01')",
            )
            .run('8\u001b[2J', pid);
          replaceOverlaps(store, [
            { sessionA: 's-\u001b[2Ja', sessionB: 's-\u001b[2Jb', files: [] },
          ]);

          const snapshot = buildDashboardSnapshot(store, repo, NOW);

          expect(snapshot.backlog.map((task) => task.id)).toEqual(['t- [2Jplan']);
          expect(snapshot.overdueDebt.map((entry) => entry.id)).toEqual(['8 [2J']);
          expect(snapshot.overlaps[0]).toMatchObject({ sessionA: 's- [2Ja', sessionB: 's- [2Jb' });
        } finally {
          store.close();
        }
      });

      it("strips what a terminal would obey out of the row's id, state and branch", () => {
        seedSession(db, repo, 's1');
        db.prepare('UPDATE sessions SET branch = ?, state = ? WHERE id = ?').run(
          'pup/\u001b[2Js1',
          'running\u001b[2J',
          's1',
        );

        expect(buildDashboardSnapshot(db, repo, NOW).sessions[0]).toMatchObject({
          id: 's1',
          state: 'running [2J',
          branch: 'pup/ [2Js1',
        });
      });

      it("strips what a terminal would obey out of the session's own words", () => {
        seedSession(db, repo, 's1');
        transitionSession(db, 's1', 'running');
        appendEvent(db, 's1', 'session_done', { summary: '\u001b[2Jdone\nfor real' });

        expect(
          buildDashboardSnapshot(db, repo, NOW).sessions[0]?.recentEvents.at(-1),
        ).toMatchObject({
          type: 'session_done',
          detail: '[2Jdone for real',
        });
      });

      it('is empty for a session nothing has happened to yet', () => {
        seedSession(db, repo, 's1');

        expect(buildDashboardSnapshot(db, repo, NOW).sessions[0]?.recentEvents).toEqual([]);
      });
    });

    it('flags a blocked session as needing a human', () => {
      seedSession(db, repo, 's1');
      transitionSession(db, 's1', 'running');
      transitionSession(db, 's1', 'blocked');

      expect(buildDashboardSnapshot(db, repo, NOW).sessions[0]?.needsHuman).toBe(true);
    });

    it('sorts blocked and stalled sessions first, then oldest first', () => {
      for (const id of ['s-first', 's-second', 's-stalled', 's-blocked']) {
        seedSession(db, repo, id);
        transitionSession(db, id, 'running');
      }
      transitionSession(db, 's-blocked', 'blocked');
      seedEventsFile(repo, 's-stalled', { hook_event_name: 'Stop' }, STALLED_AFTER_MS + 1000);

      const ids = buildDashboardSnapshot(db, repo, NOW).sessions.map((s) => s.id);

      expect(ids).toEqual(['s-stalled', 's-blocked', 's-first', 's-second']);
    });
  });

  describe('backlog', () => {
    it('lists unclaimed tasks with their goal, scope, acceptance and origin', () => {
      seedTask(db, repo, 't-plan', 'wire the snapshot into `pup ui`', 'conductor');

      expect(buildDashboardSnapshot(db, repo, NOW).backlog).toEqual([
        {
          id: 't-plan',
          goal: 'wire the snapshot into `pup ui`',
          scope: ['src/**'],
          acceptance: ['done'],
          origin: 'conductor',
        },
      ]);
    });

    it('strips what a terminal would obey out of the acceptance criteria', () => {
      seedTask(db, repo, 't-plan', 'a goal', 'human', {
        acceptance: ['\u001b[31mred\u001b[0m', 42 as unknown as string],
      });

      expect(buildDashboardSnapshot(db, repo, NOW).backlog[0]?.acceptance).toEqual(['[31mred [0m']);
    });

    it('drops a task once a session claims it', () => {
      seedSession(db, repo, 's1');

      expect(buildDashboardSnapshot(db, repo, NOW).backlog).toEqual([]);
    });
  });

  describe('debt', () => {
    it('separates the overdue entries from the open count', () => {
      ensureProject(db, projectId(repo), repo);
      const overdue = insertLedgerEntry(db, {
        projectId: projectId(repo),
        description: 'skipped the coverage bar',
        files: ['src/a.ts'],
        reason: 'ship the demo',
        acceptedBy: 'human',
        reviewBy: '2026-09-01',
      });
      insertLedgerEntry(db, {
        projectId: projectId(repo),
        description: 'still has time',
        files: ['src/b.ts'],
        reason: 'ship the demo',
        acceptedBy: 'human',
        reviewBy: '2027-01-01',
      });

      const snapshot = buildDashboardSnapshot(db, repo, NOW);

      expect(snapshot.overdueDebt).toEqual([
        { id: String(overdue), description: 'skipped the coverage bar', reviewBy: '2026-09-01' },
      ]);
      expect(snapshot.openDebtCount).toBe(2);
    });
  });

  describe('overlaps', () => {
    it('reports the radar pairs as fresh while its heartbeat is recent', () => {
      replaceOverlaps(db, [{ sessionA: 's1', sessionB: 's2', files: ['src/a.ts'] }]);
      recordWatcherBeat(db, projectId(repo), new Date(NOW - 1000));

      const snapshot = buildDashboardSnapshot(db, repo, NOW);

      expect(snapshot.overlaps).toEqual([{ sessionA: 's1', sessionB: 's2', files: ['src/a.ts'] }]);
      expect(snapshot.radarStale).toBe(false);
    });

    it('calls the pairs stale once the radar stops beating', () => {
      replaceOverlaps(db, [{ sessionA: 's1', sessionB: 's2', files: ['src/a.ts'] }]);
      recordWatcherBeat(db, projectId(repo), new Date(NOW - WATCH_STALE_AFTER_MS - 1000));

      expect(buildDashboardSnapshot(db, repo, NOW).radarStale).toBe(true);
    });

    it('calls them stale when the radar has never run', () => {
      expect(buildDashboardSnapshot(db, repo, NOW).radarStale).toBe(true);
    });
  });

  // The fleet view's fold of one project (decision 60), read off this snapshot.
  describe('fleetSummary', () => {
    function seedIn(sessionId: string, path: SessionState[]): void {
      seedSession(db, repo, sessionId);
      for (const state of path) transitionSession(db, sessionId, state);
    }

    it('keeps blocked, stalled and awaiting-review rows and counts the rest', () => {
      seedIn('s-busy', ['running']);
      seedIn('s-asking', ['running']);
      seedEventsFile(repo, 's-asking', { hook_event_name: 'Notification' });
      seedIn('s-stalled', ['running']);
      seedEventsFile(repo, 's-stalled', { hook_event_name: 'PostToolUse' }, STALLED_AFTER_MS + 1);
      seedIn('s-review', ['running', 'awaiting-review']);
      seedIn('s-blocked', ['running', 'blocked']);
      seedIn('s-merged', ['running', 'awaiting-review', 'merged']);
      seedIn('s-killed', ['killed']);
      seedTask(db, repo, 't-plan', 'planned');

      const summary = fleetSummary(buildDashboardSnapshot(db, repo, NOW));

      expect(summary.needsYou.map((session) => session.id)).toEqual([
        's-stalled',
        's-blocked',
        's-review',
      ]);
      // A killed session's task is planned again, beside the one never claimed.
      expect(summary).toMatchObject({ running: 3, planned: 2, merged: 1 });
    });

    it('is all zeros for a project with nothing in it', () => {
      ensureProject(db, projectId(repo), repo);

      expect(fleetSummary(buildDashboardSnapshot(db, repo, NOW))).toEqual({
        needsYou: [],
        running: 0,
        planned: 0,
        merged: 0,
      });
    });
  });
});

describe('findStalledSessions', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    // A throwaway HOME, for the reason the suite above gives.
    vi.stubEnv('HOME', realpathSync(mkdtempSync(join(tmpdir(), 'pup-dashboard-home-'))));
    db = openStore(':memory:');
    repo = tempRepo();
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
  });

  it('ages every running session whose events file has gone quiet', () => {
    seedSession(db, repo, 's-stalled');
    transitionSession(db, 's-stalled', 'running');
    seedEventsFile(repo, 's-stalled', { hook_event_name: 'Stop' }, STALLED_AFTER_MS + 5_000);

    expect(findStalledSessions(db, repo, NOW)).toEqual([
      {
        id: 's-stalled',
        ageMs: STALLED_AFTER_MS + 5_000,
        // The stall's name: the mtime the age was measured from.
        stalledAt: new Date(NOW - STALLED_AFTER_MS - 5_000).toISOString(),
      },
    ]);
  });

  it('leaves a fresh events file alone', () => {
    seedSession(db, repo, 's-fresh');
    transitionSession(db, 's-fresh', 'running');
    seedEventsFile(repo, 's-fresh', { hook_event_name: 'PostToolUse' });

    expect(findStalledSessions(db, repo, NOW)).toEqual([]);
  });

  it('skips a running session that has yet to fire a hook', () => {
    seedSession(db, repo, 's-silent');
    transitionSession(db, 's-silent', 'running');

    expect(findStalledSessions(db, repo, NOW)).toEqual([]);
  });

  it('skips a running row whose id is a path, marker and all (decision 66)', () => {
    seedSession(db, repo, ESCAPING_ID);
    transitionSession(db, ESCAPING_ID, 'running');
    seedEscapedMarker(repo);

    // The marker is an hour past the stall bar: a sweep that stat'ed it would
    // report the row as stalled, and the watchdog would type into its pane.
    expect(findStalledSessions(db, repo, NOW)).toEqual([]);
  });

  it('ignores a session that is no longer running, however old its events', () => {
    seedSession(db, repo, 's-done');
    transitionSession(db, 's-done', 'running');
    transitionSession(db, 's-done', 'awaiting-review');
    seedEventsFile(repo, 's-done', { hook_event_name: 'Stop' }, STALLED_AFTER_MS * 10);

    expect(findStalledSessions(db, repo, NOW)).toEqual([]);
  });
});

describe('goalHeadline', () => {
  it('takes the first line and strips what a terminal would obey', () => {
    expect(goalHeadline('rewrite [31mstatus[0m\nfrom the snapshot')).toBe('rewrite [31mstatus [0m');
  });

  it('is empty for a task with no goal', () => {
    expect(goalHeadline(undefined)).toBe('');
  });
});

/**
 * Not on the snapshot: it is read when someone asks to lift a block, not on
 * every redraw. `pup unblock` and the dashboard's `u` both ask through this, so
 * neither can describe a parking the other would describe differently.
 */
describe('blockedReason', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = tempRepo();
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  function blockSession(sessionId: string, payload: Record<string, unknown>): void {
    seedSession(db, repo, sessionId);
    transitionSession(db, sessionId, 'running');
    transitionSession(db, sessionId, 'blocked', payload);
  }

  it('reads the reason off the gate result that parked the session', () => {
    blockSession('s-parked', { reason: '3 rejections: the gate stopped steering' });

    expect(blockedReason(db, 's-parked')).toBe('3 rejections: the gate stopped steering');
  });

  // A session parked twice is described by the parking that is current.
  it('takes the newest block, never an older one', () => {
    blockSession('s-twice', { reason: 'the first parking' });
    transitionSession(db, 's-twice', 'running', { kind: 'operator-unblock' });
    transitionSession(db, 's-twice', 'blocked', { reason: 'the second parking' });

    expect(blockedReason(db, 's-twice')).toBe('the second parking');
  });

  // The reason quotes a steer refusal, and the report that refused to land is
  // the session's own output (decision 29).
  it("strips what a terminal would obey out of the session's own words", () => {
    blockSession('s-ansi', { reason: 'refused: \u001b[31mFAIL\u001b[0m' });

    expect(blockedReason(db, 's-ansi')).toBe('refused: [31mFAIL [0m');
  });

  it('is undefined for a block that carried no reason, and for no block at all', () => {
    blockSession('s-bare', {});
    seedSession(db, repo, 's-running');
    transitionSession(db, 's-running', 'running');

    expect(blockedReason(db, 's-bare')).toBeUndefined();
    expect(blockedReason(db, 's-running')).toBeUndefined();
  });
});
