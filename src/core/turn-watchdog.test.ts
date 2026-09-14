import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux boundary only — the pane reads and the paste — with the store and
// the events files real, per docs/conventions/testing.md. The pane capture
// itself is proven against the fake tmux in session-runtime.test.ts.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  conductorPane: vi.fn(() => undefined),
  deadTurnError: vi.fn(() => undefined),
  steerPane: vi.fn(),
}));

import {
  conductorPane,
  deadTurnError,
  type SessionPane,
  SteerNotDeliveredError,
  steerPane,
} from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { projectId, projectPaths } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  insertSession,
  insertTask,
  listEvents,
  transitionSession,
} from './session.repository.js';
import { STALLED_AFTER_MS } from './session-activity.constants.js';
import {
  CONDUCTOR_NUDGE,
  CONDUCTOR_TARGET,
  lastDeadTurn,
  RESUME_MESSAGE,
  sweepDeadTurns,
} from './turn-watchdog.service.js';

const API_ERROR = '⏺ API Error: Connection lost while your computer was asleep';
const STALL_AGE_MS = STALLED_AFTER_MS + 60_000;

/**
 * Wall-clock time, not a fixed instant: the conductor's cooldown compares the
 * store's own `created_at` against `now`, so a frozen `now` would read every
 * nudge as either ancient or in the future.
 */
function now(): number {
  return Date.now();
}

/** A running session with a pane recorded at launch, the way `launchSession` leaves it. */
function seedRunningSession(
  db: Database,
  repo: string,
  sessionId: string,
  options: { pane?: string | null } = {},
): void {
  const taskId = `t-${sessionId}`;
  ensureProject(db, projectId(repo), repo);
  insertTask(db, {
    id: taskId,
    projectId: projectId(repo),
    spec: JSON.stringify({ id: taskId, goal: `goal for ${sessionId}` }),
  });
  insertSession(db, {
    id: sessionId,
    taskId,
    worktreePath: join(repo, '.worktrees', sessionId),
    branch: `pup/${sessionId}`,
    profileHash: 'hash',
    ...(options.pane === null ? {} : { tmuxTarget: options.pane ?? '%7' }),
  });
  transitionSession(db, sessionId, 'running');
}

/** One hook event on disk, with the file's mtime aged by `ageMs` (decision 35). */
function seedEventsFile(repo: string, sessionId: string, ageMs: number): void {
  const paths = projectPaths(repo);
  mkdirSync(paths.sessionDir(sessionId), { recursive: true });
  writeFileSync(paths.eventsFile(sessionId), `${JSON.stringify({ hook_event_name: 'Stop' })}\n`);
  const at = new Date(now() - ageMs);
  utimesSync(paths.eventsFile(sessionId), at, at);
}

/** The stall stamp the watchdog files a dead turn under: the events file's mtime. */
function stallStampOf(repo: string, sessionId: string): string {
  return new Date(statSync(projectPaths(repo).eventsFile(sessionId)).mtimeMs).toISOString();
}

function eventsOfType(db: Database, sessionId: string, type: string) {
  return listEvents(db, sessionId)
    .filter((event) => event.type === type)
    .map((event) => JSON.parse(event.payload));
}

describe('sweepDeadTurns', () => {
  let db: Database;
  let repo: string;
  let home: string;

  beforeEach(() => {
    // projectPaths resolves the sessions directory under homedir() — point it
    // at a throwaway HOME, or the run writes into the developer's real
    // ~/.pupitre, which the merge gate's sandbox refuses outright.
    home = realpathSync(mkdtempSync(join(tmpdir(), 'pup-watchdog-home-')));
    vi.stubEnv('HOME', home);
    db = openStore(':memory:');
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-watchdog-')));
    vi.clearAllMocks();
    vi.mocked(conductorPane).mockReturnValue(undefined);
    vi.mocked(deadTurnError).mockReturnValue(undefined);
    vi.mocked(steerPane).mockReset();
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  describe('a session whose turn died', () => {
    beforeEach(() => {
      seedRunningSession(db, repo, 's1');
      seedEventsFile(repo, 's1', STALL_AGE_MS);
      vi.mocked(deadTurnError).mockReturnValue(API_ERROR);
    });

    it('is resumed once, with a turn_died event and a resume steer by watch', () => {
      const resumed = sweepDeadTurns(db, repo, now());

      expect(resumed).toEqual([{ id: 's1', reason: API_ERROR }]);
      // Read off the pane the launch recorded, and typed into the same one.
      expect(deadTurnError).toHaveBeenCalledWith({ sessionId: 's1', paneId: '%7' });
      expect(steerPane).toHaveBeenCalledTimes(1);
      expect(steerPane).toHaveBeenCalledWith({ sessionId: 's1', paneId: '%7' }, RESUME_MESSAGE);
      expect(eventsOfType(db, 's1', 'turn_died')).toEqual([
        { reason: API_ERROR, stalledAt: stallStampOf(repo, 's1') },
      ]);
      expect(eventsOfType(db, 's1', 'steer')).toEqual([{ kind: 'resume', by: 'watch' }]);
    });

    it('is left alone by every later sweep of the same stall', () => {
      sweepDeadTurns(db, repo, now());
      const again = sweepDeadTurns(db, repo, now() + 15_000);

      expect(again).toEqual([]);
      expect(steerPane).toHaveBeenCalledTimes(1);
      expect(eventsOfType(db, 's1', 'turn_died')).toHaveLength(1);
      expect(eventsOfType(db, 's1', 'steer')).toHaveLength(1);
    });

    // The DNS-outage case: the resumed turn dies again at once, no hook fires
    // and the stamp never moves. A stamp alone would leave the session dead
    // after the network came back, so the skip is bounded by the stall
    // window — past it, the same error over the same empty box is the next
    // dead turn of the same stall.
    it('is resumed again past the stall window while the pane still shows the error', () => {
      sweepDeadTurns(db, repo, now());
      expect(sweepDeadTurns(db, repo, now() + STALLED_AFTER_MS - 60_000)).toEqual([]);

      const resumed = sweepDeadTurns(db, repo, now() + STALLED_AFTER_MS + 5_000);

      expect(resumed).toEqual([{ id: 's1', reason: API_ERROR }]);
      expect(steerPane).toHaveBeenCalledTimes(2);
      const stamps = eventsOfType(db, 's1', 'turn_died').map((event) => event.stalledAt);
      expect(stamps).toEqual([stallStampOf(repo, 's1'), stallStampOf(repo, 's1')]);
      expect(eventsOfType(db, 's1', 'steer')).toHaveLength(2);
    });

    // A session that recovered, worked and died again is a new stall: its
    // events file moved when the resumed turn fired its hooks.
    it('is resumed again when it stalls again later', () => {
      sweepDeadTurns(db, repo, now());
      seedEventsFile(repo, 's1', STALL_AGE_MS - 30_000);

      const resumed = sweepDeadTurns(db, repo, now());

      expect(resumed).toEqual([{ id: 's1', reason: API_ERROR }]);
      expect(steerPane).toHaveBeenCalledTimes(2);
      const stamps = eventsOfType(db, 's1', 'turn_died').map((event) => event.stalledAt);
      expect(stamps).toHaveLength(2);
      expect(new Set(stamps).size).toBe(2);
      expect(stamps[1]).toBe(stallStampOf(repo, 's1'));
    });

    it('records a refused steer on the event and leaves the resume to a human', () => {
      vi.mocked(steerPane).mockImplementation(() => {
        throw new SteerNotDeliveredError('s1', RESUME_MESSAGE.length);
      });

      const resumed = sweepDeadTurns(db, repo, now());

      expect(resumed).toEqual([
        { id: 's1', reason: API_ERROR, refusal: expect.stringContaining('did not land') },
      ]);
      expect(eventsOfType(db, 's1', 'turn_died')).toEqual([
        {
          reason: API_ERROR,
          stalledAt: stallStampOf(repo, 's1'),
          refusal: expect.stringContaining('did not land'),
        },
      ]);
      expect(eventsOfType(db, 's1', 'steer')).toEqual([]);
      // The refusal is on record, so the next sweep does not type again.
      expect(sweepDeadTurns(db, repo, now())).toEqual([]);
      expect(steerPane).toHaveBeenCalledTimes(1);
    });

    it('sanitizes the error line before recording it', () => {
      const esc = String.fromCharCode(27);
      vi.mocked(deadTurnError).mockReturnValue(`⏺ API Error: ${esc}[31mgone${esc}[0m`);

      const [resumed] = sweepDeadTurns(db, repo, now());

      expect(resumed?.reason).not.toContain(esc);
      expect(eventsOfType(db, 's1', 'turn_died')[0].reason).not.toContain(esc);
    });
  });

  it('leaves a stalled session whose pane shows no dead turn untouched', () => {
    seedRunningSession(db, repo, 's1');
    seedEventsFile(repo, 's1', STALL_AGE_MS);

    expect(sweepDeadTurns(db, repo, now())).toEqual([]);

    expect(deadTurnError).toHaveBeenCalledTimes(1);
    expect(steerPane).not.toHaveBeenCalled();
    expect(eventsOfType(db, 's1', 'turn_died')).toEqual([]);
  });

  it('does not read the pane of a running session that is not stalled', () => {
    seedRunningSession(db, repo, 's1');
    seedEventsFile(repo, 's1', 0);
    vi.mocked(deadTurnError).mockReturnValue(API_ERROR);

    expect(sweepDeadTurns(db, repo, now())).toEqual([]);

    expect(deadTurnError).not.toHaveBeenCalled();
    expect(steerPane).not.toHaveBeenCalled();
  });

  // A launch that failed before recording its pane, or a window already gone:
  // there is nothing to read and nothing to type into, so nothing to record.
  it('skips a stalled session with no pane recorded at launch', () => {
    seedRunningSession(db, repo, 's1', { pane: null });
    seedEventsFile(repo, 's1', STALL_AGE_MS);
    vi.mocked(deadTurnError).mockReturnValue(API_ERROR);

    expect(sweepDeadTurns(db, repo, now())).toEqual([]);

    expect(deadTurnError).not.toHaveBeenCalled();
    expect(eventsOfType(db, 's1', 'turn_died')).toEqual([]);
  });

  describe('the conductor', () => {
    const pane: SessionPane = {
      sessionId: 'conductor-p1',
      paneId: '%0',
      socket: 'pup-conductor-p1',
    };

    beforeEach(() => {
      vi.mocked(conductorPane).mockReturnValue(pane);
    });

    it('is nudged on its own socket when its turn died, after the sessions', () => {
      seedRunningSession(db, repo, 's1');
      seedEventsFile(repo, 's1', STALL_AGE_MS);
      vi.mocked(deadTurnError).mockReturnValue(API_ERROR);

      const resumed = sweepDeadTurns(db, repo, now());

      expect(resumed.map((turn) => turn.id)).toEqual(['s1', CONDUCTOR_TARGET]);
      expect(conductorPane).toHaveBeenCalledWith(projectId(repo));
      expect(deadTurnError).toHaveBeenCalledWith(pane);
      expect(steerPane).toHaveBeenLastCalledWith(pane, CONDUCTOR_NUDGE);
      // Filed against no session: the conductor has no row of its own.
      expect(
        db
          .prepare("SELECT payload FROM events WHERE session_id IS NULL AND type = 'turn_died'")
          .all(),
      ).toEqual([{ payload: JSON.stringify({ target: CONDUCTOR_TARGET, reason: API_ERROR }) }]);
    });

    it('is not nudged twice inside the stall window', () => {
      vi.mocked(deadTurnError).mockReturnValue(API_ERROR);

      const first = sweepDeadTurns(db, repo, now());
      const second = sweepDeadTurns(db, repo, now() + 15_000);
      const later = sweepDeadTurns(db, repo, now() + STALLED_AFTER_MS + 1_000);

      expect(first).toEqual([{ id: CONDUCTOR_TARGET, reason: API_ERROR }]);
      expect(second).toEqual([]);
      expect(later).toEqual([{ id: CONDUCTOR_TARGET, reason: API_ERROR }]);
      expect(steerPane).toHaveBeenCalledTimes(2);
    });

    it('is left alone when its window shows no dead turn', () => {
      expect(sweepDeadTurns(db, repo, now())).toEqual([]);

      expect(deadTurnError).toHaveBeenCalledWith(pane);
      expect(steerPane).not.toHaveBeenCalled();
    });

    it('is left alone when there is no conductor window', () => {
      vi.mocked(conductorPane).mockReturnValue(undefined);
      vi.mocked(deadTurnError).mockReturnValue(API_ERROR);

      expect(sweepDeadTurns(db, repo, now())).toEqual([]);

      expect(deadTurnError).not.toHaveBeenCalled();
      expect(steerPane).not.toHaveBeenCalled();
    });

    it('records a refused nudge against no session', () => {
      vi.mocked(deadTurnError).mockReturnValue(API_ERROR);
      vi.mocked(steerPane).mockImplementation(() => {
        throw new SteerNotDeliveredError('conductor-p1', CONDUCTOR_NUDGE.length);
      });

      const resumed = sweepDeadTurns(db, repo, now());

      expect(resumed).toEqual([
        {
          id: CONDUCTOR_TARGET,
          reason: API_ERROR,
          refusal: expect.stringContaining('did not land'),
        },
      ]);
      const [row] = db
        .prepare("SELECT payload FROM events WHERE session_id IS NULL AND type = 'turn_died'")
        .all() as Array<{ payload: string }>;
      expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({
        target: CONDUCTOR_TARGET,
        reason: API_ERROR,
        refusal: expect.stringContaining('did not land'),
      });
    });
  });
});

describe('lastDeadTurn', () => {
  let db: Database;
  let repo: string;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'pup-watchdog-home-')));
    vi.stubEnv('HOME', home);
    db = openStore(':memory:');
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-watchdog-')));
    seedRunningSession(db, repo, 's1');
    seedEventsFile(repo, 's1', STALL_AGE_MS);
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('is the dead turn recorded for the stall the session is in now', () => {
    appendEvent(db, 's1', 'turn_died', { reason: API_ERROR, stalledAt: stallStampOf(repo, 's1') });

    const died = lastDeadTurn(db, repo, 's1');

    expect(died).toMatchObject({ reason: API_ERROR });
    expect(died?.refusal).toBeUndefined();
    expect(Math.abs(now() - (died?.at.getTime() ?? 0))).toBeLessThan(5_000);
  });

  it('carries the refusal when the resume was refused', () => {
    appendEvent(db, 's1', 'turn_died', {
      reason: API_ERROR,
      stalledAt: stallStampOf(repo, 's1'),
      refusal: 'did not land',
    });

    expect(lastDeadTurn(db, repo, 's1')).toMatchObject({
      reason: API_ERROR,
      refusal: 'did not land',
    });
  });

  // An hour-old resume stays off the row of a session that has since worked
  // and stalled again for some other reason.
  it('is undefined when the recorded dead turn belongs to an earlier stall', () => {
    appendEvent(db, 's1', 'turn_died', { reason: API_ERROR, stalledAt: stallStampOf(repo, 's1') });
    seedEventsFile(repo, 's1', STALL_AGE_MS - 30_000);

    expect(lastDeadTurn(db, repo, 's1')).toBeUndefined();
  });

  it('is the newest of several resumes of the same stall', () => {
    const stalledAt = stallStampOf(repo, 's1');
    appendEvent(db, 's1', 'turn_died', { reason: API_ERROR, stalledAt, refusal: 'did not land' });
    appendEvent(db, 's1', 'turn_died', { reason: '⏺ API Error: ENOTFOUND', stalledAt });

    const died = lastDeadTurn(db, repo, 's1');

    expect(died?.reason).toBe('⏺ API Error: ENOTFOUND');
    expect(died?.refusal).toBeUndefined();
  });

  it('is undefined when nothing was recorded', () => {
    expect(lastDeadTurn(db, repo, 's1')).toBeUndefined();
  });

  it('is undefined when the events file is gone', () => {
    appendEvent(db, 's1', 'turn_died', { reason: API_ERROR, stalledAt: stallStampOf(repo, 's1') });
    rmSync(projectPaths(repo).eventsFile('s1'));

    expect(lastDeadTurn(db, repo, 's1')).toBeUndefined();
  });
});
