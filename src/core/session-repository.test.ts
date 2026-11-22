import { join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { GateStage } from '../adapters/enums/gate-stage.enums.js';
import { Tier } from '../claude/enums/tier.enums.js';
import { openStore } from './db.client.js';
import { ClimbReason } from './enums/climb-reason.enums.js';
import { EventType } from './enums/event-type.enums.js';
import { GateStageStatus } from './enums/gate-stage-status.enums.js';
import { MergeStatus } from './enums/merge-status.enums.js';
import { SessionState } from './enums/session-state.enums.js';
import { InvalidProfileError } from './errors/profile.errors.js';
import { InvalidTransitionError, MalformedTaskSpecError } from './errors/session.errors.js';
import {
  appendEvent,
  claimingSession,
  decodeEvent,
  dropTask,
  editTaskSpec,
  ensureProject,
  findSessionByWorktree,
  getSession,
  getTask,
  incrementRejectCount,
  insertSession,
  insertTask,
  isProjectDormant,
  listBacklogTasks,
  listEvents,
  listSessions,
  listTaskSessions,
  listTasks,
  readTaskSpec,
  recordSessionRoute,
  rescopeTaskSpec,
  saveProjectDormantAt,
  taskSpecForDisplay,
  transitionSession,
  updateTaskSpec,
  workingSession,
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
    expect(getSession(db, 's1')?.state).toBe(SessionState.Queued);
  });

  it('transitions through the happy path and logs each move as an event', () => {
    seedSession(db, 's1');
    transitionSession(db, 's1', SessionState.Running);
    transitionSession(db, 's1', SessionState.AwaitingReview);
    expect(getSession(db, 's1')?.state).toBe(SessionState.AwaitingReview);
    const events = db
      .prepare(
        `SELECT payload FROM events WHERE session_id = 's1' AND type = '${EventType.GateResult}'`,
      )
      .all() as { payload: string }[];
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1]?.payload ?? '{}')).toMatchObject({
      from: SessionState.Running,
      to: SessionState.AwaitingReview,
    });
  });

  it('rejects an illegal transition and leaves state unchanged', () => {
    seedSession(db, 's1');
    expect(() => transitionSession(db, 's1', SessionState.Merged)).toThrow(InvalidTransitionError);
    expect(getSession(db, 's1')?.state).toBe(SessionState.Queued);
  });

  it('filters listSessions by state', () => {
    seedSession(db, 's1');
    seedSession(db, 's2');
    transitionSession(db, 's1', SessionState.Running);
    expect(listSessions(db, [SessionState.Running]).map((s) => s.id)).toEqual(['s1']);
    expect(listSessions(db)).toHaveLength(2);
  });

  // The `sessions.state` column holds the members' values, so this pins the
  // wire strings in SQL text: renaming a value would strand every stored row.
  it('stores each state as the string the sessions table has always held', () => {
    for (const state of Object.values(SessionState)) {
      seedSession(db, state);
      db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(state, state);
    }
    const stored = db
      .prepare(
        `SELECT state FROM sessions WHERE state = id AND state IN
           ('queued', 'running', 'awaiting-review', 'merged', 'killed', 'rejected', 'blocked')`,
      )
      .pluck()
      .all();
    expect(stored.sort()).toEqual(Object.values(SessionState).sort());
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
    expect(() =>
      appendEvent(db, null, EventType.UtilityCall, { kind: 'gate-reviewer', ok: true }),
    ).not.toThrow();
  });

  it('lists only the requested project tasks, with the spec as raw JSON', () => {
    seedSession(db, 's1');
    ensureProject(db, 'proj-2', '/other');
    insertTask(db, { id: 'task-other', projectId: 'proj-2', spec: '{}' });

    const rows = listTasks(db, 'proj-1');

    expect(rows.map((t) => t.id)).toEqual(['task-s1']);
    expect(rows[0]?.spec).toBe('{}');
  });

  // The fix round's edge is `pup fix`'s alone (decision 90).
  it('refuses merged -> running, and stores the fix round event pup fix writes', () => {
    seedSession(db, 's1');
    transitionSession(db, 's1', SessionState.Running);
    transitionSession(db, 's1', SessionState.AwaitingReview);
    transitionSession(db, 's1', SessionState.Merged);

    expect(() => transitionSession(db, 's1', SessionState.Running)).toThrow(InvalidTransitionError);
    expect(getSession(db, 's1')?.state).toBe(SessionState.Merged);

    const round = {
      prUrl: 'https://github.com/o/r/pull/1',
      head: 'abc',
      threads: ['PRRT_1'],
      rejectBase: 0,
    };
    appendEvent(db, 's1', EventType.FixRound, round);
    expect(listEvents(db, 's1').at(-1)).toMatchObject({
      type: EventType.FixRound,
      payload: JSON.stringify(round),
    });
  });

  it('lists a session events oldest first with raw JSON payloads', () => {
    seedSession(db, 's1');
    seedSession(db, 's2');
    appendEvent(db, 's1', EventType.Steer, { kind: 'manual' });
    appendEvent(db, 's2', EventType.Interrupt, { steered: false });
    appendEvent(db, 's1', EventType.SessionDone, { summary: 'shipped' });

    const rows = listEvents(db, 's1');

    expect(rows.map((e) => e.type)).toEqual([EventType.Steer, EventType.SessionDone]);
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
  it.each([
    SessionState.Queued,
    SessionState.Running,
    SessionState.AwaitingReview,
    SessionState.Rejected,
    SessionState.Blocked,
    SessionState.Merged,
  ] as const)('drops a task whose session is %s', (state) => {
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
  });

  it('returns a task to the backlog when its session is killed', () => {
    planned('t-1');
    insertSession(db, {
      id: 's1',
      taskId: 't-1',
      worktreePath: '/repo/.worktrees/s1',
      branch: 'pup/s1',
      profileHash: 'hash',
    });
    transitionSession(db, 's1', SessionState.Running);
    expect(listBacklogTasks(db, 'proj-1')).toEqual([]);

    transitionSession(db, 's1', SessionState.Killed);

    expect(listBacklogTasks(db, 'proj-1').map((t) => t.id)).toEqual(['t-1']);
  });

  it('drops a planned task and reports when there was none to drop', () => {
    planned('t-1');

    expect(dropTask(db, 't-1')).toEqual({ kind: 'dropped' });
    expect(dropTask(db, 't-1')).toEqual({ kind: 'unknown' });
    expect(listBacklogTasks(db, 'proj-1')).toEqual([]);
    // No session ever ran for it, so there is no history to keep.
    expect(getTask(db, 't-1')).toBeUndefined();
  });

  it("rewrites a planned task's spec", () => {
    planned('t-1');

    expect(updateTaskSpec(db, 't-1', JSON.stringify({ goal: 'sharper' }))).toBe(true);
    expect(JSON.parse(getTask(db, 't-1')?.spec ?? '{}')).toEqual({ goal: 'sharper' });
  });

  // `sessions.task_id` is a NOT NULL foreign key, so a task with history
  // cannot be deleted: it is marked dropped, and its sessions stay
  // (decision 147).
  it('drops a task whose sessions were all killed, keeping their history', () => {
    planned('t-1');
    for (const id of ['s1', 's2']) {
      insertSession(db, {
        id,
        taskId: 't-1',
        worktreePath: `/repo/.worktrees/${id}`,
        branch: `pup/${id}`,
        profileHash: 'hash',
      });
      transitionSession(db, id, SessionState.Killed);
    }
    expect(listBacklogTasks(db, 'proj-1').map((t) => t.id)).toEqual(['t-1']);

    expect(dropTask(db, 't-1')).toEqual({ kind: 'dropped' });

    expect(listBacklogTasks(db, 'proj-1')).toEqual([]);
    expect(getTask(db, 't-1')?.dropped_at).not.toBeNull();
    expect(listTaskSessions(db, 't-1').map((s) => s.id)).toEqual(['s1', 's2']);
    expect(dropTask(db, 't-1')).toEqual({ kind: 'unknown' });
    expect(editTaskSpec(db, 't-1', { goal: 'revived' })).toBe('unknown');
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
    transitionSession(db, 's1', SessionState.Running);

    expect(claimingSession(db, 't-1')).toBe('s1');
  });

  // The spec is compiled into the session's context.md at launch, so editing or
  // dropping it afterwards would leave the store disagreeing with what the
  // agent was actually told.
  it('refuses to drop or edit a task a session has claimed, naming it', () => {
    planned('t-1');
    insertSession(db, {
      id: 's1',
      taskId: 't-1',
      worktreePath: '/repo/.worktrees/s1',
      branch: 'pup/s1',
      profileHash: 'hash',
    });
    transitionSession(db, 's1', SessionState.Running);

    expect(dropTask(db, 't-1')).toEqual({ kind: 'claimed', sessionId: 's1' });
    expect(getTask(db, 't-1')?.dropped_at).toBeNull();
    expect(updateTaskSpec(db, 't-1', '{}')).toBe(false);
    expect(getTask(db, 't-1')?.spec).toBe(JSON.stringify({ goal: 't-1' }));
  });

  // Decision 115: a claimed spec moves only once no session is at work on it,
  // and the guard sits in the statement, so a launch after the check still wins.
  it.each([
    [SessionState.Queued, false],
    [SessionState.Running, false],
    [SessionState.Rejected, false],
    [SessionState.Blocked, false],
    [SessionState.AwaitingReview, true],
    [SessionState.Merged, true],
    [SessionState.Killed, true],
  ] as const)('rescopes a claimed task whose session is %s: %s', (state, rescoped) => {
    planned('t-1');
    insertSession(db, {
      id: 's1',
      taskId: 't-1',
      worktreePath: '/repo/.worktrees/s1',
      branch: 'pup/s1',
      profileHash: 'hash',
    });
    db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(state, 's1');

    expect(workingSession(db, 't-1')).toBe(rescoped ? undefined : 's1');
    expect(rescopeTaskSpec(db, 't-1', '{"goal":"wider"}')).toBe(rescoped);
    expect(getTask(db, 't-1')?.spec).toBe(
      rescoped ? '{"goal":"wider"}' : JSON.stringify({ goal: 't-1' }),
    );
  });
});

describe('dropped_at (decision 147)', () => {
  // Immediate: the lock comes before the claim is read, so a launch cannot
  // slip a session in between. Seen from a second connection: while another
  // writer holds the lock, even a drop that would only read cannot start.
  it('takes the write lock before it reads the claim', () => {
    const dbPath = join(tempDir('pup-store-'), 'pup.db');
    const writer = openStore(dbPath);
    ensureProject(writer, 'proj-1', '/repo');
    insertTask(writer, { id: 't-1', projectId: 'proj-1', spec: '{}' });
    const dropper = openStore(dbPath);
    dropper.pragma('busy_timeout = 0');

    writer.exec('BEGIN IMMEDIATE');
    try {
      expect(() => dropTask(dropper, 'no-such-task')).toThrow(/locked|busy/i);
    } finally {
      writer.exec('ROLLBACK');
    }
    const outcome = dropTask(dropper, 't-1');
    writer.close();
    dropper.close();

    expect(outcome).toEqual({ kind: 'dropped' });
  });

  it('is added to a store created before it, its tasks still live', () => {
    const dbPath = join(tempDir('pup-store-'), 'pup.db');
    const old = openStore(dbPath);
    old.exec(`
      ALTER TABLE tasks DROP COLUMN dropped_at;
      INSERT INTO projects (id, repo_path) VALUES ('proj-1', '/repo');
      INSERT INTO tasks (id, project_id, spec) VALUES ('t-1', 'proj-1', '{}');
    `);
    old.close();

    const reopened = openStore(dbPath);
    const task = getTask(reopened, 't-1');
    const backlog = listBacklogTasks(reopened, 'proj-1').map((t) => t.id);
    reopened.close();

    expect(task?.dropped_at).toBeNull();
    expect(backlog).toEqual(['t-1']);
  });
});

describe('task tier and session route (decision 92)', () => {
  let db: Database;
  const SPEC = {
    goal: 'g',
    scopeIn: ['src/cli/ui/**'],
    scopeOut: [],
    acceptance: ['a'],
  };
  const routeOf = (id: string) =>
    db
      .prepare(
        'SELECT tier, rung, model, effort, rung_reason, route_override FROM sessions WHERE id = ?',
      )
      .get(id);
  const session = (id: string, route?: Parameters<typeof insertSession>[1]['route']) =>
    insertSession(db, {
      id,
      taskId: 't-1',
      worktreePath: `/repo/.worktrees/${id}`,
      branch: `pup/${id}`,
      profileHash: 'hash',
      route,
    });

  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, 'proj-1', '/repo');
  });

  it('stores the tier a task is planned with, and none when the scope decides it', () => {
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: '{}', tier: Tier.Critical });
    insertTask(db, { id: 't-2', projectId: 'proj-1', spec: '{}' });

    expect(getTask(db, 't-1')?.tier).toBe(Tier.Critical);
    expect(getTask(db, 't-2')?.tier).toBeNull();
  });

  it('sets the tier on edit, and keeps it when an edit does not name one', () => {
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: JSON.stringify(SPEC) });

    expect(editTaskSpec(db, 't-1', { tier: Tier.Critical })).toBe('updated');
    expect(editTaskSpec(db, 't-1', { goal: 'sharper' })).toBe('updated');

    expect(getTask(db, 't-1')?.tier).toBe(Tier.Critical);
    expect(readTaskSpec(db, 't-1').goal).toBe('sharper');
  });

  it('refuses to re-tier a task a session has claimed', () => {
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: JSON.stringify(SPEC) });
    session('s1');
    transitionSession(db, 's1', SessionState.Running);

    expect(editTaskSpec(db, 't-1', { tier: Tier.Critical })).toBe('claimed');
    expect(getTask(db, 't-1')?.tier).toBeNull();
  });

  it('records the route a session launched on, and a respawn rewrites it', () => {
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: '{}' });
    session('s1', {
      tier: Tier.Standard,
      rung: 0,
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      override: false,
    });
    expect(routeOf('s1')).toEqual({
      tier: Tier.Standard,
      rung: 0,
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      rung_reason: null,
      route_override: 0,
    });

    recordSessionRoute(db, 's1', {
      tier: Tier.Standard,
      rung: 1,
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      reason: ClimbReason.Stall,
      override: true,
    });

    expect(routeOf('s1')).toEqual({
      tier: Tier.Standard,
      rung: 1,
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      rung_reason: ClimbReason.Stall,
      route_override: 1,
    });
  });

  it('leaves a session inserted without a route unrouted', () => {
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: '{}' });
    session('s1');

    expect(routeOf('s1')).toEqual({
      tier: null,
      rung: null,
      model: null,
      effort: null,
      rung_reason: null,
      route_override: 0,
    });
  });

  it("lists a task's sessions oldest first, and only that task's", () => {
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: '{}' });
    insertTask(db, { id: 't-2', projectId: 'proj-1', spec: '{}' });
    session('t-1');
    session('t-1-1');
    insertSession(db, {
      id: 't-2',
      taskId: 't-2',
      worktreePath: '/repo/.worktrees/t-2',
      branch: 'pup/t-2',
      profileHash: 'hash',
    });

    expect(listTaskSessions(db, 't-1').map((row) => row.id)).toEqual(['t-1', 't-1-1']);
  });
});

describe('task spec decoding', () => {
  let db: Database;
  const stored = (spec: string, id = 't-1') => {
    ensureProject(db, 'proj-1', '/repo');
    insertTask(db, { id, projectId: 'proj-1', spec });
  };
  const valid = { id: 't-1', goal: 'g', scopeIn: ['src/**'], acceptance: ['a'] };

  beforeEach(() => {
    db = openStore(':memory:');
  });

  describe('readTaskSpec', () => {
    it('lets the row id win over the blob, and defaults scope-out', () => {
      stored(JSON.stringify({ ...valid, id: 't-other' }));

      expect(readTaskSpec(db, 't-1')).toEqual({ ...valid, id: 't-1', scopeOut: [] });
    });

    // The SyntaxError's message carries the stored bytes, so the refusal names
    // the task and never quotes what it choked on.
    it('refuses a spec that is not JSON with a typed error naming the task', () => {
      stored('{"goal": "\u202e not json');

      const read = () => readTaskSpec(db, 't-1');
      expect(read).toThrow(MalformedTaskSpecError);
      expect(read).toThrow('Task t-1 has an unusable spec: it is not valid JSON.');
    });

    it.each([
      ['null', 'not a JSON object'],
      ['["src/**"]', 'not a JSON object'],
      ['{"scopeIn": "src/**"}', 'scopeIn is not a list of globs'],
      ['{"scopeIn": ["src/**"], "scopeOut": [1]}', 'scopeOut is not a list of globs'],
    ])('refuses the wrong shape %s', (spec, reason) => {
      stored(spec);

      expect(() => readTaskSpec(db, 't-1')).toThrow(reason);
    });

    // A row can predate `pup plan add`'s validation (decision 40); the refusal
    // stays an InvalidProfileError, so every command refusing one refuses it.
    it('runs the plannable checks, naming the task', () => {
      stored(JSON.stringify({ goal: 'g', acceptance: [] }));

      const read = () => readTaskSpec(db, 't-1');
      expect(read).toThrow(InvalidProfileError);
      expect(read).toThrow(/Task t-1 has an unusable spec: Task scope-in is empty/);
    });

    it('refuses a task that is not stored', () => {
      expect(() => readTaskSpec(db, 't-gone')).toThrow(MalformedTaskSpecError);
    });

    describe('a ticket (decision 187)', () => {
      const ticket = {
        ref: '#412',
        type: 'feature',
        labels: ['ready', 'design-approved'],
        triggers: [],
        design: 'Store the ticket on the spec.',
        criteria: ['the kickoff quotes it'],
      };

      it('reads an approved ticket back whole', () => {
        stored(JSON.stringify({ ...valid, ticket }));

        expect(readTaskSpec(db, 't-1').ticket).toEqual(ticket);
      });

      it.each([
        ['null', null],
        ['a list', [ticket]],
        ['no ref', { ...ticket, ref: undefined }],
        ['a type that is not text', { ...ticket, type: 1 }],
        ['labels that are not a list', { ...ticket, labels: 'design-approved' }],
        ['no triggers', { ...ticket, triggers: undefined }],
        ['a criterion that is not text', { ...ticket, criteria: [1] }],
        ['a design note that is not text', { ...ticket, design: ['note'] }],
      ])('refuses a ticket with %s, naming the task', (_, bad) => {
        stored(JSON.stringify({ ...valid, ticket: bad }));

        const read = () => readTaskSpec(db, 't-1');
        expect(read).toThrow(MalformedTaskSpecError);
        expect(read).toThrow('Task t-1 has an unusable spec: its ticket needs a ref, a type,');
      });

      // A row intake wrote before the operator's label, or one whose label a
      // later write dropped: the launch, the gate and the review all refuse it.
      it('refuses a feature ticket without the design-approved label, naming the task', () => {
        stored(JSON.stringify({ ...valid, ticket: { ...ticket, labels: ['ready'] } }));

        expect(() => readTaskSpec(db, 't-1')).toThrow(
          'Task t-1 has an unusable spec: Ticket #412 has no design-approved label',
        );
      });

      it('keeps the ticket through an edit', () => {
        stored(JSON.stringify({ ...valid, ticket }));

        expect(editTaskSpec(db, 't-1', { goal: 'sharper' })).toBe('updated');
        expect(readTaskSpec(db, 't-1').ticket).toEqual(ticket);
      });

      // The edit copies the ticket without touching it, so a stored ticket
      // that fails a check does not block repairing the other fields.
      it('edits the other fields of a task whose stored ticket fails a check', () => {
        const unapproved = { ...ticket, labels: ['ready'] };
        stored(JSON.stringify({ ...valid, ticket: unapproved }));

        expect(editTaskSpec(db, 't-1', { goal: 'sharper' })).toBe('updated');
        expect(JSON.parse(getTask(db, 't-1')?.spec ?? '{}')).toMatchObject({
          goal: 'sharper',
          ticket: unapproved,
        });
        expect(() => readTaskSpec(db, 't-1')).toThrow('has no design-approved label');
      });
    });
  });

  describe('taskSpecForDisplay', () => {
    it('degrades a malformed or missing row to an empty spec', () => {
      expect(taskSpecForDisplay({ spec: 'not json' })).toEqual({});
      expect(taskSpecForDisplay({ spec: '"a string"' })).toEqual({});
      expect(taskSpecForDisplay(undefined)).toEqual({});
    });

    it('passes a well-formed spec through', () => {
      expect(taskSpecForDisplay({ spec: JSON.stringify(valid) })).toEqual(valid);
    });
  });

  describe('editTaskSpec', () => {
    const spec = () => JSON.parse(getTask(db, 't-1')?.spec ?? '{}');

    it('replaces only the fields it is given', () => {
      stored(JSON.stringify({ ...valid, scopeOut: ['src/x.ts'] }));

      expect(editTaskSpec(db, 't-1', { goal: 'sharper' })).toBe('updated');
      expect(spec()).toEqual({ ...valid, goal: 'sharper', scopeOut: ['src/x.ts'] });
    });

    it('replaces every field it is given', () => {
      stored(JSON.stringify(valid));

      editTaskSpec(db, 't-1', {
        goal: 'g2',
        scopeIn: ['lib/**'],
        scopeOut: ['lib/gen/**'],
        acceptance: ['b'],
      });
      expect(spec()).toEqual({
        id: 't-1',
        goal: 'g2',
        scopeIn: ['lib/**'],
        scopeOut: ['lib/gen/**'],
        acceptance: ['b'],
      });
    });

    it('validates the merged spec as `plan add` would, writing nothing on refusal', () => {
      stored(JSON.stringify(valid));

      expect(() => editTaskSpec(db, 't-1', { scopeIn: ['src/\n**'] })).toThrow(InvalidProfileError);
      expect(() => editTaskSpec(db, 't-1', { scopeIn: ['  '] })).toThrow('scope-in is empty');
      expect(spec()).toEqual(valid);
    });

    // Edit is how a row that fails the plannable checks gets repaired, so the
    // stored spec is not held to them — only the result is.
    it('repairs a stored spec with no scope', () => {
      stored(JSON.stringify({ goal: 'g', acceptance: ['a'] }));

      expect(editTaskSpec(db, 't-1', { scopeIn: ['src/**'] })).toBe('updated');
      expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/**']);
    });

    it('refuses a stored spec that is not JSON', () => {
      stored('not json');

      expect(() => editTaskSpec(db, 't-1', { goal: 'g' })).toThrow(MalformedTaskSpecError);
    });

    it('says when the task is unknown', () => {
      expect(editTaskSpec(db, 't-gone', { goal: 'g' })).toBe('unknown');
    });

    it('says when a session has claimed the task, leaving the spec frozen', () => {
      stored(JSON.stringify(valid));
      insertSession(db, {
        id: 's1',
        taskId: 't-1',
        worktreePath: '/repo/.worktrees/s1',
        branch: 'pup/s1',
        profileHash: 'h',
      });

      expect(editTaskSpec(db, 't-1', { goal: 'g2' })).toBe('claimed');
      expect(spec()).toEqual(valid);
    });
  });
});

describe('decodeEvent', () => {
  const gate = (payload: unknown) =>
    decodeEvent({ type: EventType.GateResult, payload: JSON.stringify(payload) });

  it('reads a gate run as its verdict and stages', () => {
    expect(
      gate({
        outcome: MergeStatus.Refused,
        report: {
          sessionId: 's1',
          passed: false,
          sandbox: 'none',
          stages: [
            { stage: GateStage.Lint, status: GateStageStatus.Pass },
            { stage: 'tests', status: GateStageStatus.Fail, detail: '2 failing' },
          ],
        },
      }),
    ).toEqual({
      type: 'gate_result',
      outcome: MergeStatus.Refused,
      report: {
        passed: false,
        stages: [
          { stage: GateStage.Lint, status: GateStageStatus.Pass },
          { stage: 'tests', status: GateStageStatus.Fail, detail: '2 failing' },
        ],
      },
    });
  });

  it('reads a bare transition as a gate result without a report', () => {
    expect(
      gate({ from: SessionState.Running, to: SessionState.Blocked, reason: 'reject cap' }),
    ).toEqual({
      type: 'gate_result',
      from: SessionState.Running,
      to: SessionState.Blocked,
      reason: 'reject cap',
    });
  });

  it('reads a torn payload as a gate result without a report instead of throwing', () => {
    const event = decodeEvent({ type: EventType.GateResult, payload: '{"report":' });

    expect(event).toEqual({ type: 'gate_result' });
  });

  it('reads a top-level array or a non-object report as no report', () => {
    expect(gate([{ report: {} }])).toEqual({ type: 'gate_result' });
    expect(gate({ report: 'passed' })).toEqual({ type: 'gate_result' });
    expect(gate({ report: null })).toEqual({ type: 'gate_result' });
  });

  it('drops stage members of the wrong shape and keeps the rest', () => {
    const event = gate({
      report: {
        passed: 'yes',
        stages: [
          null,
          GateStage.Lint,
          { stage: GateStage.Build },
          { stage: 7, status: GateStageStatus.Pass },
          { stage: 'tests', status: GateStageStatus.Fail, detail: 42 },
          { stage: GateStage.Lint, status: GateStageStatus.Pass },
        ],
      },
    });

    expect(event).toEqual({
      type: 'gate_result',
      report: {
        passed: false,
        stages: [
          { stage: 'tests', status: GateStageStatus.Fail },
          { stage: GateStage.Lint, status: GateStageStatus.Pass },
        ],
      },
    });
  });

  it('reads stages that are not an array as none', () => {
    expect(gate({ report: { passed: true, stages: { stage: GateStage.Lint } } })).toEqual({
      type: 'gate_result',
      report: { passed: true, stages: [] },
    });
  });

  // Decision 68: the decoder hands each renderer the store text as it was.
  it('leaves control characters for the renderer to scrub', () => {
    expect(
      decodeEvent({
        type: EventType.Question,
        payload: JSON.stringify({ text: '\u001b[2Jwhich one?' }),
      }),
    ).toEqual({ type: 'question', text: '\u001b[2Jwhich one?' });
  });

  it('reads a field of the wrong type as absent', () => {
    expect(
      decodeEvent({ type: EventType.Steer, payload: JSON.stringify({ kind: 5, by: 'conductor' }) }),
    ).toEqual({ type: 'steer', by: 'conductor' });
    expect(
      decodeEvent({ type: EventType.SessionDone, payload: JSON.stringify({ summary: ['done'] }) }),
    ).toEqual({ type: 'session_done' });
  });

  it('reads a merge, keeping only the string members of its file list', () => {
    expect(
      decodeEvent({
        type: EventType.Merge,
        payload: JSON.stringify({
          branch: 'pup/s1',
          target: 'main',
          files: ['src/a.ts', null, 3],
          prUrl: 'https://github.com/o/r/pull/1',
        }),
      }),
    ).toEqual({
      type: 'merge',
      target: 'main',
      files: ['src/a.ts'],
      prUrl: 'https://github.com/o/r/pull/1',
    });
    expect(decodeEvent({ type: EventType.Merge, payload: '{}' })).toEqual({
      type: 'merge',
      files: [],
    });
  });

  it('reads a merge with its pinned sha and the commits left behind', () => {
    expect(
      decodeEvent({
        type: EventType.Merge,
        payload: JSON.stringify({
          branch: 'pup/s1',
          sha: 'abc123',
          target: 'main',
          files: ['src/a.ts'],
          leftBehind: 2,
        }),
      }),
    ).toEqual({
      type: 'merge',
      sha: 'abc123',
      target: 'main',
      files: ['src/a.ts'],
      leftBehind: 2,
    });
    expect(
      decodeEvent({ type: EventType.Merge, payload: JSON.stringify({ sha: 7, leftBehind: '2' }) }),
    ).toEqual({ type: 'merge', files: [] });
  });

  it('reads a dead turn and a handoff signal', () => {
    expect(
      decodeEvent({
        type: EventType.TurnDied,
        payload: JSON.stringify({ reason: 'API Error', stalledAt: '2026-10-06T10:00:00Z' }),
      }),
    ).toEqual({ type: 'turn_died', reason: 'API Error', stalledAt: '2026-10-06T10:00:00Z' });
    expect(decodeEvent({ type: EventType.HandoffReady, payload: '{"hash":"abc"}' })).toEqual({
      type: 'handoff_ready',
      hash: 'abc',
    });
  });

  it('keeps the payload of a type nothing reads by field', () => {
    expect(decodeEvent({ type: EventType.Interrupt, payload: '{"steered":false}' })).toEqual({
      type: 'other',
      eventType: EventType.Interrupt,
      fields: { steered: false },
    });
    expect(decodeEvent({ type: EventType.Interrupt, payload: 'not json' })).toEqual({
      type: 'other',
      eventType: EventType.Interrupt,
      fields: {},
    });
  });
});
