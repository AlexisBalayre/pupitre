import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStore } from './db.client.js';
import {
  appendEvent,
  claimingSession,
  deleteTask,
  ensureProject,
  findSessionByWorktree,
  getSession,
  getTask,
  InvalidTransitionError,
  incrementRejectCount,
  insertSession,
  insertTask,
  isProjectDormant,
  listBacklogTasks,
  listEvents,
  listSessions,
  listTasks,
  saveProjectDormantAt,
  transitionSession,
  updateTaskSpec,
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

describe('project dormancy', () => {
  it('puts a project to sleep and wakes it, and a project with no row is active', () => {
    const db = openStore(':memory:');
    ensureProject(db, 'proj-1', '/repo');

    expect(isProjectDormant(db, 'proj-1')).toBe(false);
    saveProjectDormantAt(db, 'proj-1', '2026-09-21T10:00:00.000Z');
    expect(isProjectDormant(db, 'proj-1')).toBe(true);
    saveProjectDormantAt(db, 'proj-1', null);
    expect(isProjectDormant(db, 'proj-1')).toBe(false);
    expect(isProjectDormant(db, 'no-such-project')).toBe(false);
  });
});

describe('the backlog', () => {
  let db: Database;
  const planned = (id: string) => {
    ensureProject(db, 'proj-1', '/repo');
    insertTask(db, { id, projectId: 'proj-1', spec: JSON.stringify({ goal: id }) });
  };

  beforeEach(() => {
    db = openStore(':memory:');
  });

  it('holds a task no session has claimed', () => {
    planned('t-1');

    expect(listBacklogTasks(db, 'proj-1').map((t) => t.id)).toEqual(['t-1']);
  });

  it('scopes to one project', () => {
    planned('t-1');
    ensureProject(db, 'proj-2', '/other');
    insertTask(db, { id: 't-2', projectId: 'proj-2', spec: '{}' });

    expect(listBacklogTasks(db, 'proj-1').map((t) => t.id)).toEqual(['t-1']);
  });

  // Every state a session can reach means the task is spoken for, except
  // `killed` — abandoned work is worth relaunching (decision 40).
  it.each(['queued', 'running', 'awaiting-review', 'rejected', 'blocked', 'merged'] as const)(
    'drops a task whose session is %s',
    (state) => {
      planned('t-1');
      insertSession(db, {
        id: 's1',
        taskId: 't-1',
        worktreePath: '/repo/.worktrees/s1',
        branch: 'pup/s1',
        profileHash: 'hash',
      });
      db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(state, 's1');

      expect(listBacklogTasks(db, 'proj-1')).toEqual([]);
    },
  );

  it('returns a task to the backlog when its session is killed', () => {
    planned('t-1');
    insertSession(db, {
      id: 's1',
      taskId: 't-1',
      worktreePath: '/repo/.worktrees/s1',
      branch: 'pup/s1',
      profileHash: 'hash',
    });
    transitionSession(db, 's1', 'running');
    expect(listBacklogTasks(db, 'proj-1')).toEqual([]);

    transitionSession(db, 's1', 'killed');

    expect(listBacklogTasks(db, 'proj-1').map((t) => t.id)).toEqual(['t-1']);
  });

  it('drops a planned task and reports when there was none to drop', () => {
    planned('t-1');

    expect(deleteTask(db, 't-1')).toBe(true);
    expect(deleteTask(db, 't-1')).toBe(false);
    expect(listBacklogTasks(db, 'proj-1')).toEqual([]);
  });

  it("rewrites a planned task's spec", () => {
    planned('t-1');

    expect(updateTaskSpec(db, 't-1', JSON.stringify({ goal: 'sharper' }))).toBe(true);
    expect(JSON.parse(getTask(db, 't-1')?.spec ?? '{}')).toEqual({ goal: 'sharper' });
  });

  // The spec is compiled into the session's context.md at launch, so editing or
  // deleting it afterwards would leave the store disagreeing with what the
  // agent was actually told.
  // `sessions.task_id` is a NOT NULL foreign key, so a task with history cannot
  // be deleted at all — the guard must refuse rather than let SQLite abort the
  // statement and surface a raw constraint error to the operator.
  it('refuses to drop a task whose killed session returned it to the backlog', () => {
    planned('t-1');
    insertSession(db, {
      id: 's1',
      taskId: 't-1',
      worktreePath: '/repo/.worktrees/s1',
      branch: 'pup/s1',
      profileHash: 'hash',
    });
    transitionSession(db, 's1', 'killed');
    expect(listBacklogTasks(db, 'proj-1').map((t) => t.id)).toEqual(['t-1']);

    expect(() => deleteTask(db, 't-1')).not.toThrow();
    expect(deleteTask(db, 't-1')).toBe(false);
    expect(getTask(db, 't-1')).toBeDefined();
  });

  it('names the session that claimed a task, and nothing for a planned one', () => {
    planned('t-1');
    expect(claimingSession(db, 't-1')).toBeUndefined();

    insertSession(db, {
      id: 's1',
      taskId: 't-1',
      worktreePath: '/repo/.worktrees/s1',
      branch: 'pup/s1',
      profileHash: 'hash',
    });
    transitionSession(db, 's1', 'running');

    expect(claimingSession(db, 't-1')).toBe('s1');
  });

  it('refuses to drop or edit a task a session has claimed', () => {
    planned('t-1');
    insertSession(db, {
      id: 's1',
      taskId: 't-1',
      worktreePath: '/repo/.worktrees/s1',
      branch: 'pup/s1',
      profileHash: 'hash',
    });
    transitionSession(db, 's1', 'running');

    expect(deleteTask(db, 't-1')).toBe(false);
    expect(updateTaskSpec(db, 't-1', '{}')).toBe(false);
    expect(getTask(db, 't-1')?.spec).toBe(JSON.stringify({ goal: 't-1' }));
  });
});
