import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux boundary only — the box read, the paste and the submit — with the
// store and the events files real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  conductorPane: vi.fn(() => undefined),
  deadTurnError: vi.fn(() => undefined),
  steerPane: vi.fn(),
  readInputBox: vi.fn(() => 'empty'),
  pasteIntoPane: vi.fn(() => true),
  submitPane: vi.fn(),
}));

import { tempDir } from '@test/helpers/temp-dir.mock.js';
import {
  deadTurnError,
  pasteIntoPane,
  readInputBox,
  steerPane,
  submitPane,
} from '../claude/session-runtime.service.js';
import {
  CACHE_HOLD_AFTER_MS,
  CACHE_HOLD_EVENTS_TAIL_BYTES,
  CACHE_HOLD_LIMIT,
  CACHE_HOLD_MESSAGE,
  CACHE_HOLD_UNTIL_MS,
  holdIdleCaches,
} from './cache-hold.service.js';
import { openStore, type SessionState } from './db.client.js';
import { projectId, projectPaths } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  insertSession,
  insertTask,
  listEvents,
  openQuestion,
  saveProjectDormantAt,
  transitionSession,
} from './session.repository.js';
import { sweepDeadTurns } from './turn-watchdog.service.js';

const HOLD_AGE_MS = CACHE_HOLD_AFTER_MS + 2 * 60_000;
const STOP = { hook_event_name: 'Stop' };
const TOOL = { hook_event_name: 'PostToolUse', tool_name: 'Bash' };
const IDLE_PROMPT = { hook_event_name: 'Notification', notification_type: 'idle_prompt' };

/** A session in `state`, with the pane its launch recorded. */
function seedSession(db: Database, repo: string, id: string, state: SessionState): void {
  ensureProject(db, projectId(repo), repo);
  insertTask(db, {
    id: `t-${id}`,
    projectId: projectId(repo),
    spec: JSON.stringify({ id: `t-${id}`, goal: `goal for ${id}` }),
  });
  insertSession(db, {
    id,
    taskId: `t-${id}`,
    worktreePath: join(repo, '.worktrees', id),
    branch: `pup/${id}`,
    profileHash: 'hash',
    tmuxTarget: '%7',
  });
  transitionSession(db, id, 'running');
  if (state === 'awaiting-review' || state === 'blocked') transitionSession(db, id, state);
}

/** The session's hook events on disk, the file's mtime aged by `ageMs`. */
function seedEventsFile(repo: string, id: string, ageMs: number, events = [TOOL, STOP]): void {
  const paths = projectPaths(repo);
  mkdirSync(paths.sessionDir(id), { recursive: true });
  writeFileSync(paths.eventsFile(id), events.map((event) => `${JSON.stringify(event)}\n`).join(''));
  const at = new Date(Date.now() - ageMs);
  utimesSync(paths.eventsFile(id), at, at);
}

function holdsOf(db: Database, id: string): unknown[] {
  return listEvents(db, id)
    .filter((event) => event.type === 'cache_hold')
    .map((event) => JSON.parse(event.payload));
}

describe('holdIdleCaches (decision 179)', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    // projectPaths resolves the sessions directory under homedir().
    vi.stubEnv('HOME', tempDir('pup-cache-hold-home-'));
    db = openStore(':memory:');
    repo = tempDir('pup-cache-hold-');
    vi.clearAllMocks();
    vi.mocked(deadTurnError).mockReturnValue(undefined);
    vi.mocked(readInputBox).mockReturnValue('empty');
    vi.mocked(pasteIntoPane).mockReturnValue(true);
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
  });

  it('holds a worker awaiting review once its idle nears the hour, and records no steer', () => {
    seedSession(db, repo, 's1', 'awaiting-review');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);

    expect(holdIdleCaches(db, repo, Date.now())).toEqual(['s1']);

    const pane = { sessionId: 's1', paneId: '%7' };
    expect(pasteIntoPane).toHaveBeenCalledWith(pane, CACHE_HOLD_MESSAGE);
    expect(submitPane).toHaveBeenCalledWith(pane);
    const [hold] = holdsOf(db, 's1') as { idleMs: number; eventsBytes: number }[];
    expect(hold?.idleMs).toBeGreaterThanOrEqual(CACHE_HOLD_AFTER_MS);
    // Where the hold's turn starts writing: the file as it stood when it was typed.
    expect(hold?.eventsBytes).toBe(statSync(projectPaths(repo).eventsFile('s1')).size);
    expect(listEvents(db, 's1').filter((event) => event.type === 'steer')).toEqual([]);
  });

  it('never gives a blocked worker a turn, even with a question open', () => {
    seedSession(db, repo, 's1', 'blocked');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);
    appendEvent(db, 's1', 'question', { text: 'which ADR number?' });

    expect(holdIdleCaches(db, repo, Date.now())).toEqual([]);
    expect(readInputBox).not.toHaveBeenCalled();
    expect(submitPane).not.toHaveBeenCalled();
  });

  it('holds nothing before the hold window, and nothing once the cache may have gone', () => {
    seedSession(db, repo, 'early', 'awaiting-review');
    seedEventsFile(repo, 'early', CACHE_HOLD_AFTER_MS - 60_000);
    seedSession(db, repo, 'late', 'awaiting-review');
    seedEventsFile(repo, 'late', CACHE_HOLD_UNTIL_MS + 60_000);

    expect(holdIdleCaches(db, repo, Date.now())).toEqual([]);
    expect(readInputBox).not.toHaveBeenCalled();
  });

  describe('a running worker', () => {
    beforeEach(() => {
      seedSession(db, repo, 's1', 'running');
      seedEventsFile(repo, 's1', HOLD_AGE_MS);
    });

    it('is held while its question is open, and the hold leaves the question open', () => {
      appendEvent(db, 's1', 'question', { text: 'which ADR number?' });

      expect(holdIdleCaches(db, repo, Date.now())).toEqual(['s1']);
      expect(openQuestion(db, 's1')?.text).toBe('which ADR number?');
    });

    it('is not held with no question open: it waits on nobody pup can name', () => {
      expect(holdIdleCaches(db, repo, Date.now())).toEqual([]);
    });

    it('is not held once a steer answered its question', () => {
      appendEvent(db, 's1', 'question', { text: 'which ADR number?' });
      appendEvent(db, 's1', 'steer', { kind: 'manual', by: 'operator' });

      expect(holdIdleCaches(db, repo, Date.now())).toEqual([]);
    });
  });

  it('is not held while its turn is still at work', () => {
    seedSession(db, repo, 's1', 'awaiting-review');
    seedEventsFile(repo, 's1', HOLD_AGE_MS, [STOP, TOOL]);

    expect(holdIdleCaches(db, repo, Date.now())).toEqual([]);
    expect(readInputBox).not.toHaveBeenCalled();
  });

  it('types nothing into a box that holds a draft, and records nothing', () => {
    seedSession(db, repo, 's1', 'awaiting-review');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);
    vi.mocked(readInputBox).mockReturnValue('holds');

    expect(holdIdleCaches(db, repo, Date.now())).toEqual([]);
    expect(pasteIntoPane).not.toHaveBeenCalled();
    expect(holdsOf(db, 's1')).toEqual([]);
  });

  it('records nothing when the paste never landed, so the next sweep tries again', () => {
    seedSession(db, repo, 's1', 'awaiting-review');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);
    vi.mocked(pasteIntoPane).mockReturnValue(false);

    expect(holdIdleCaches(db, repo, Date.now())).toEqual([]);
    expect(submitPane).not.toHaveBeenCalled();
    expect(holdsOf(db, 's1')).toEqual([]);
  });

  it('presses Enter once more when the first left the hold in the box, and records the hold it sent', () => {
    seedSession(db, repo, 's1', 'awaiting-review');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);
    vi.mocked(readInputBox).mockReturnValueOnce('empty').mockReturnValueOnce('holds');

    expect(holdIdleCaches(db, repo, Date.now())).toEqual(['s1']);
    expect(submitPane).toHaveBeenCalledTimes(2);
    expect(holdsOf(db, 's1')).toHaveLength(1);
  });

  it('records no hold still in the box after its second Enter, so the next sweep holds again', () => {
    seedSession(db, repo, 's1', 'awaiting-review');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);
    vi.mocked(readInputBox)
      .mockReturnValueOnce('empty')
      .mockReturnValueOnce('holds')
      .mockReturnValueOnce('holds');

    expect(holdIdleCaches(db, repo, Date.now())).toEqual([]);
    expect(submitPane).toHaveBeenCalledTimes(2);
    expect(holdsOf(db, 's1')).toEqual([]);

    expect(holdIdleCaches(db, repo, Date.now())).toEqual(['s1']);
  });

  it('presses no second Enter into a box gone from the screen', () => {
    seedSession(db, repo, 's1', 'awaiting-review');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);
    vi.mocked(readInputBox).mockReturnValueOnce('empty').mockReturnValueOnce('absent');

    expect(holdIdleCaches(db, repo, Date.now())).toEqual(['s1']);
    expect(submitPane).toHaveBeenCalledTimes(1);
  });

  it(`lets a window lapse after ${CACHE_HOLD_LIMIT} holds in a row, until something else is recorded`, () => {
    seedSession(db, repo, 's1', 'awaiting-review');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);
    for (let hold = 0; hold < CACHE_HOLD_LIMIT; hold++) {
      appendEvent(db, 's1', 'cache_hold', { idleMs: HOLD_AGE_MS, eventsBytes: 0 });
    }
    // Each hold's turn moved the events file after it.
    db.prepare("UPDATE events SET created_at = datetime('now', '-2 hours')").run();

    expect(holdIdleCaches(db, repo, Date.now())).toEqual([]);

    transitionSession(db, 's1', 'rejected');
    transitionSession(db, 's1', 'running');
    transitionSession(db, 's1', 'awaiting-review');
    expect(holdIdleCaches(db, repo, Date.now())).toEqual(['s1']);
  });

  it('holds a window once until the turn it started moves the events file', () => {
    seedSession(db, repo, 's1', 'awaiting-review');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);

    expect(holdIdleCaches(db, repo, Date.now())).toEqual(['s1']);
    // The hold's turn has fired no hook yet, or died without one.
    expect(holdIdleCaches(db, repo, Date.now() + 60_000)).toEqual([]);
    expect(pasteIntoPane).toHaveBeenCalledTimes(1);

    // Its Stop moves the file, and the next quiet stretch is held again.
    const stop = new Date(Date.now() + 2_000);
    utimesSync(projectPaths(repo).eventsFile('s1'), stop, stop);
    expect(holdIdleCaches(db, repo, stop.getTime() + HOLD_AGE_MS)).toEqual(['s1']);
  });

  it('types nothing into a turn a prompt started that no hook has shown yet', () => {
    for (const id of ['steered', 'respawned', 'earlier']) {
      seedSession(db, repo, id, 'awaiting-review');
      seedEventsFile(repo, id, HOLD_AGE_MS);
    }
    appendEvent(db, 'steered', 'steer', { kind: 'message', by: 'pup-t-peer' });
    appendEvent(db, 'respawned', 'respawn', { delivered: true });
    // A steer whose turn moved the events file after it.
    appendEvent(db, 'earlier', 'steer', { kind: 'message', by: 'pup-t-peer' });
    db.prepare(
      "UPDATE events SET created_at = datetime('now', '-2 hours') WHERE session_id = 'earlier'",
    ).run();

    expect(holdIdleCaches(db, repo, Date.now())).toEqual(['earlier']);
    expect(pasteIntoPane).toHaveBeenCalledTimes(1);
  });

  it('is not held by the sweep that resumed its dead turn', () => {
    const deadTurn = '⏺ API Error: Connection lost while your computer was asleep';
    seedSession(db, repo, 's1', 'running');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);
    appendEvent(db, 's1', 'question', { text: 'which ADR number?' });
    vi.mocked(deadTurnError).mockReturnValue(deadTurn);

    expect(sweepDeadTurns(db, repo, Date.now())).toEqual([{ id: 's1', reason: deadTurn }]);
    expect(steerPane).toHaveBeenCalledTimes(1);
    expect(pasteIntoPane).not.toHaveBeenCalled();
    expect(holdsOf(db, 's1')).toEqual([]);
  });

  // A dead turn fires no Stop, but Claude Code sends its idle prompt a minute
  // later all the same, so the stall is stamped after the hold.
  it("leaves the hold's dead turn to the operator, though its idle prompt moved the events file", () => {
    seedSession(db, repo, 's1', 'running');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);
    appendEvent(db, 's1', 'question', { text: 'which ADR number?' });
    expect(holdIdleCaches(db, repo, Date.now())).toEqual(['s1']);
    db.prepare("UPDATE events SET created_at = datetime('now', '-12 minutes')").run();
    const eventsFile = projectPaths(repo).eventsFile('s1');
    appendFileSync(eventsFile, `${JSON.stringify(IDLE_PROMPT)}\n`);
    const idle = new Date(Date.now() - 11 * 60_000);
    utimesSync(eventsFile, idle, idle);
    vi.mocked(deadTurnError).mockReturnValue('⏺ API Error: Connection lost');

    expect(sweepDeadTurns(db, repo, Date.now())).toEqual([]);
    expect(steerPane).not.toHaveBeenCalled();
    expect(openQuestion(db, 's1')?.text).toBe('which ADR number?');
  });

  it('runs on the watcher sweep, and never in a dormant project', () => {
    seedSession(db, repo, 's1', 'awaiting-review');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);
    saveProjectDormantAt(db, projectId(repo), new Date().toISOString());

    expect(sweepDeadTurns(db, repo, Date.now())).toEqual([]);
    expect(holdsOf(db, 's1')).toEqual([]);

    saveProjectDormantAt(db, projectId(repo), null);
    expect(sweepDeadTurns(db, repo, Date.now())).toEqual([]);
    expect(holdsOf(db, 's1')).toHaveLength(1);
  });

  describe('an events file the session replaced', () => {
    /** `bad` waits with its events file replaced by `plant`; `good` waits with a real one. */
    function seedPair(plant: (eventsFile: string) => void): void {
      seedSession(db, repo, 'bad', 'awaiting-review');
      seedEventsFile(repo, 'bad', HOLD_AGE_MS);
      const eventsFile = projectPaths(repo).eventsFile('bad');
      plant(eventsFile);
      const at = new Date(Date.now() - HOLD_AGE_MS);
      utimesSync(eventsFile, at, at);
      seedSession(db, repo, 'good', 'awaiting-review');
      seedEventsFile(repo, 'good', HOLD_AGE_MS);
    }

    it('skips a directory, and holds the next session', () => {
      seedPair((eventsFile) => {
        rmSync(eventsFile);
        mkdirSync(eventsFile);
      });

      expect(holdIdleCaches(db, repo, Date.now())).toEqual(['good']);
      expect(pasteIntoPane).toHaveBeenCalledTimes(1);
    });

    it('never follows a link, even to a file that would be held', () => {
      seedPair((eventsFile) => {
        const target = `${eventsFile}.real`;
        renameSync(eventsFile, target);
        symlinkSync(target, eventsFile);
      });

      expect(holdIdleCaches(db, repo, Date.now())).toEqual(['good']);
      expect(pasteIntoPane).toHaveBeenCalledTimes(1);
    });

    it('never blocks on a fifo', () => {
      seedPair((eventsFile) => {
        rmSync(eventsFile);
        execFileSync('mkfifo', [eventsFile]);
      });

      expect(holdIdleCaches(db, repo, Date.now())).toEqual(['good']);
      expect(pasteIntoPane).toHaveBeenCalledTimes(1);
    });
  });

  describe(`an events file past ${CACHE_HOLD_EVENTS_TAIL_BYTES} bytes`, () => {
    const oversized = (event: { hook_event_name: string }) => ({
      ...event,
      padding: 'x'.repeat(CACHE_HOLD_EVENTS_TAIL_BYTES),
    });

    it('is held from its tail', () => {
      seedSession(db, repo, 's1', 'awaiting-review');
      seedEventsFile(repo, 's1', HOLD_AGE_MS, [oversized(TOOL), TOOL, STOP]);

      expect(holdIdleCaches(db, repo, Date.now())).toEqual(['s1']);
    });

    it('is read no further back than its tail: a turn end larger than it is never seen', () => {
      seedSession(db, repo, 's1', 'awaiting-review');
      // Read whole, the two turn ends are an ended turn, and the window is held.
      seedEventsFile(repo, 's1', HOLD_AGE_MS, [TOOL, STOP, oversized(STOP)]);

      expect(holdIdleCaches(db, repo, Date.now())).toEqual([]);
      expect(readInputBox).not.toHaveBeenCalled();
    });
  });

  it('skips a window whose pane fails, and holds the next one', () => {
    seedSession(db, repo, 's1', 'awaiting-review');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);
    seedSession(db, repo, 's2', 'awaiting-review');
    seedEventsFile(repo, 's2', HOLD_AGE_MS);
    vi.mocked(readInputBox).mockImplementationOnce(() => {
      throw new Error('tmux: no server running');
    });

    expect(holdIdleCaches(db, repo, Date.now())).toEqual(['s2']);
    expect(holdsOf(db, 's1')).toEqual([]);
  });
});
