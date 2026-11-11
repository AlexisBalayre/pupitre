import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux boundary only — the box read, the paste and the submit — with the
// store and the events files real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  conductorPane: vi.fn(() => undefined),
  readInputBox: vi.fn(() => 'empty'),
  pasteIntoPane: vi.fn(() => true),
  submitPane: vi.fn(),
}));

import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { pasteIntoPane, readInputBox, submitPane } from '../claude/session-runtime.service.js';
import {
  CACHE_HOLD_AFTER_MS,
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
    const [hold] = holdsOf(db, 's1') as { idleMs: number }[];
    expect(hold?.idleMs).toBeGreaterThanOrEqual(CACHE_HOLD_AFTER_MS);
    expect(listEvents(db, 's1').filter((event) => event.type === 'steer')).toEqual([]);
  });

  it('holds a blocked worker, which waits on the operator', () => {
    seedSession(db, repo, 's1', 'blocked');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);

    expect(holdIdleCaches(db, repo, Date.now())).toEqual(['s1']);
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

  it(`lets a window lapse after ${CACHE_HOLD_LIMIT} holds in a row, until something else is recorded`, () => {
    seedSession(db, repo, 's1', 'awaiting-review');
    seedEventsFile(repo, 's1', HOLD_AGE_MS);
    for (let hold = 0; hold < CACHE_HOLD_LIMIT; hold++) {
      appendEvent(db, 's1', 'cache_hold', { idleMs: HOLD_AGE_MS });
    }

    expect(holdIdleCaches(db, repo, Date.now())).toEqual([]);

    transitionSession(db, 's1', 'rejected');
    transitionSession(db, 's1', 'running');
    transitionSession(db, 's1', 'awaiting-review');
    expect(holdIdleCaches(db, repo, Date.now())).toEqual(['s1']);
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
});
