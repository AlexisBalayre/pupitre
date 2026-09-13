import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux boundary only: the store, the events files and the transcripts all
// run for real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  hasConductorWindow: vi.fn(() => false),
}));

import { hasConductorWindow } from '../claude/session-runtime.service.js';
import { buildDashboardSnapshot, findStalledSessions, goalHeadline } from './dashboard.service.js';
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

const NOW = Date.parse('2026-09-13T12:00:00Z');

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
): void {
  ensureProject(db, projectId(repo), repo);
  insertTask(db, {
    id: taskId,
    projectId: projectId(repo),
    spec: JSON.stringify({ id: taskId, goal, scopeIn: ['src/**'], acceptance: ['done'] }),
    origin,
  });
}

function seedSession(
  db: Database,
  repo: string,
  sessionId: string,
  options: { goal?: string; origin?: string; transcriptPath?: string } = {},
): void {
  const taskId = `t-${sessionId}`;
  seedTask(db, repo, taskId, options.goal ?? `goal for ${sessionId}`, options.origin);
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
        rejectCount: 1,
        needsHuman: false,
      });
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
    it('lists unclaimed tasks with their goal, scope and origin', () => {
      seedTask(db, repo, 't-plan', 'wire the snapshot into `pup ui`', 'conductor');

      expect(buildDashboardSnapshot(db, repo, NOW).backlog).toEqual([
        {
          id: 't-plan',
          goal: 'wire the snapshot into `pup ui`',
          scope: ['src/**'],
          origin: 'conductor',
        },
      ]);
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
        { id: overdue, description: 'skipped the coverage bar', reviewBy: '2026-09-01' },
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
      { id: 's-stalled', ageMs: STALLED_AFTER_MS + 5_000 },
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
