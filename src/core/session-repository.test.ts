import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStore } from './db.client.js';
import {
  appendEvent,
  ensureProject,
  findSessionByWorktree,
  getSession,
  InvalidTransitionError,
  incrementRejectCount,
  insertSession,
  insertTask,
  listEvents,
  listSessions,
  listTasks,
  transitionSession,
} from './session.repository.js';

function seedSession(db: Database, id: string): void {
  ensureProject(db, 'proj-1', '/repo');
  insertTask(db, { id: `task-${id}`, projectId: 'proj-1', spec: '{}' });
  insertSession(db, {
    id,
    taskId: `task-${id}`,
    worktreePath: `/repo/.worktrees/${id}`,
    branch: `feature/${id}`,
    profileHash: 'hash',
  });
}

describe('session repository', () => {
  let db: Database;
  beforeEach(() => {
    db = openStore(':memory:');
  });

  it('creates and reads a session in queued state', () => {
    seedSession(db, 's1');
    expect(getSession(db, 's1')?.state).toBe('queued');
  });

  it('transitions through the happy path and logs each move as an event', () => {
    seedSession(db, 's1');
    transitionSession(db, 's1', 'running');
    transitionSession(db, 's1', 'awaiting-review');
    expect(getSession(db, 's1')?.state).toBe('awaiting-review');
    const events = db
      .prepare("SELECT payload FROM events WHERE session_id = 's1' AND type = 'gate_result'")
      .all() as { payload: string }[];
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1]?.payload ?? '{}')).toMatchObject({
      from: 'running',
      to: 'awaiting-review',
    });
  });

  it('rejects an illegal transition and leaves state unchanged', () => {
    seedSession(db, 's1');
    expect(() => transitionSession(db, 's1', 'merged')).toThrow(InvalidTransitionError);
    expect(getSession(db, 's1')?.state).toBe('queued');
  });

  it('filters listSessions by state', () => {
    seedSession(db, 's1');
    seedSession(db, 's2');
    transitionSession(db, 's1', 'running');
    expect(listSessions(db, ['running']).map((s) => s.id)).toEqual(['s1']);
    expect(listSessions(db)).toHaveLength(2);
  });

  it('increments the reject count', () => {
    seedSession(db, 's1');
    expect(incrementRejectCount(db, 's1')).toBe(1);
    expect(incrementRejectCount(db, 's1')).toBe(2);
  });

  it('finds the session owning a path, including a subdirectory of its worktree', () => {
    seedSession(db, 's1');
    seedSession(db, 's2');

    expect(findSessionByWorktree(db, '/repo/.worktrees/s2')?.id).toBe('s2');
    expect(findSessionByWorktree(db, '/repo/.worktrees/s2/src/core')?.id).toBe('s2');
  });

  it('does not mistake a sibling path that merely shares a prefix for a worktree', () => {
    seedSession(db, 's1');

    expect(findSessionByWorktree(db, '/repo')).toBeUndefined();
    expect(findSessionByWorktree(db, '/repo/.worktrees/s1-backup')).toBeUndefined();
  });

  it('appends a null-session event without a foreign-key error', () => {
    expect(() => appendEvent(db, null, 'utility_call', { note: 'gate reviewer' })).not.toThrow();
  });

  it('lists only the requested project tasks, with the spec as raw JSON', () => {
    seedSession(db, 's1');
    ensureProject(db, 'proj-2', '/other');
    insertTask(db, { id: 'task-other', projectId: 'proj-2', spec: '{}' });

    const rows = listTasks(db, 'proj-1');

    expect(rows.map((t) => t.id)).toEqual(['task-s1']);
    expect(rows[0]?.spec).toBe('{}');
  });

  it('lists a session events oldest first with raw JSON payloads', () => {
    seedSession(db, 's1');
    seedSession(db, 's2');
    appendEvent(db, 's1', 'steer', { kind: 'manual' });
    appendEvent(db, 's2', 'interrupt', {});
    appendEvent(db, 's1', 'session_done', { summary: 'shipped' });

    const rows = listEvents(db, 's1');

    expect(rows.map((e) => e.type)).toEqual(['steer', 'session_done']);
    expect(rows[1]?.payload).toBe(JSON.stringify({ summary: 'shipped' }));
  });
});
