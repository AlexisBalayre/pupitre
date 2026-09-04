import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStore } from './db.client.js';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { projectId } from './paths.utils.js';
import { InvalidProfileError } from './profile.errors.js';
import {
  getTask,
  insertSession,
  listBacklogTasks,
  transitionSession,
} from './session.repository.js';
import { TaskAlreadyClaimedError, UnknownTaskError } from './session-lifecycle.errors.js';
import { launchTask, planTask } from './session-lifecycle.service.js';
import type { TaskId, TaskSpec } from './types/profile.types.js';

const REPO = '/repo';

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: 't-1' as TaskId,
    goal: 'extract the gh exec options',
    scopeIn: ['src/core/github.client.ts'],
    acceptance: ['goal met and committed'],
    ...overrides,
  };
}

describe('planTask', () => {
  let db: Database;
  beforeEach(() => {
    db = openStore(':memory:');
  });

  it('records intent without creating a session', () => {
    planTask(db, { repoPath: REPO, task: spec() });

    expect(listBacklogTasks(db, projectId(REPO)).map((t) => t.id)).toEqual(['t-1']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('registers the project so a plan is the first thing a repo can do', () => {
    planTask(db, { repoPath: REPO, task: spec() });

    expect(db.prepare('SELECT id FROM projects').all()).toEqual([{ id: projectId(REPO) }]);
  });

  // The code map moves on between planning a task and launching it, so a slice
  // captured with the intent would describe a repo that no longer exists.
  it('stores no knowledge slice, which is a launch-time concern', () => {
    planTask(db, { repoPath: REPO, task: spec() });

    const stored = JSON.parse(getTask(db, 't-1')?.spec ?? '{}') as TaskSpec;
    expect(stored.knowledgeSlice).toBeUndefined();
  });
});

describe('launchTask', () => {
  let db: Database;
  beforeEach(() => {
    db = openStore(':memory:');
  });

  // Checked before any git or filesystem work, so a typo'd id costs nothing.
  it('refuses a task the store does not hold, naming the backlog', () => {
    expect(() =>
      launchTask(db, {
        repoPath: REPO,
        base: DEFAULT_BASE_PROFILE,
        taskId: 't-nope',
        claudeUserDir: '/home/.claude',
      }),
    ).toThrow(UnknownTaskError);
  });

  it('leaves the backlog untouched when it refuses', () => {
    planTask(db, { repoPath: REPO, task: spec() });

    expect(() =>
      launchTask(db, {
        repoPath: REPO,
        base: DEFAULT_BASE_PROFILE,
        taskId: 't-nope',
        claudeUserDir: '/home/.claude',
      }),
    ).toThrow(UnknownTaskError);
    expect(listBacklogTasks(db, projectId(REPO)).map((t) => t.id)).toEqual(['t-1']);
  });
});

describe('planTask validation', () => {
  let db: Database;
  beforeEach(() => {
    db = openStore(':memory:');
  });

  // A backlog row is written by one act and launched by another, days later, so
  // a spec that cannot compile must fail at the command that wrote it — not
  // after `pup launch` has already created a worktree and branch.
  it('refuses a spec with no usable scope', () => {
    expect(() => planTask(db, { repoPath: REPO, task: spec({ scopeIn: ['  '] }) })).toThrow(
      InvalidProfileError,
    );
    expect(listBacklogTasks(db, projectId(REPO))).toEqual([]);
  });

  // A newline survives into `scope-in.pat`, where a blank line is a pattern
  // `grep -qE -f` matches everything against, so the Edit/Write hook would
  // silently become allow-all.
  it.each(['src/**\nsecrets/**', 'src/**\r', 'src/**\u0000'])(
    'refuses a scope glob carrying a control character (%j)',
    (glob) => {
      expect(() => planTask(db, { repoPath: REPO, task: spec({ scopeIn: [glob] }) })).toThrow(
        InvalidProfileError,
      );
    },
  );

  it('refuses a control character in scope-out too', () => {
    expect(() =>
      planTask(db, { repoPath: REPO, task: spec({ scopeOut: ['dist/**\nsrc/**'] }) }),
    ).toThrow(InvalidProfileError);
  });
});

describe('launchTask claim guard', () => {
  let db: Database;
  beforeEach(() => {
    db = openStore(':memory:');
  });

  const launch = () =>
    launchTask(db, {
      repoPath: REPO,
      base: DEFAULT_BASE_PROFILE,
      taskId: 't-1',
      claudeUserDir: '/home/.claude',
    });

  // Relaunching a claimed task mints a second session with a fresh
  // reject_count, stepping over the cap that parked the first one (decision 7).
  it.each(['running', 'awaiting-review', 'blocked', 'merged'] as const)(
    'refuses a task whose session is %s',
    (state) => {
      planTask(db, { repoPath: REPO, task: spec() });
      insertSession(db, {
        id: 's1',
        taskId: 't-1',
        worktreePath: '/repo/.worktrees/s1',
        branch: 'pup/s1',
        profileHash: 'hash',
      });
      db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(state, 's1');

      expect(launch).toThrow(TaskAlreadyClaimedError);
    },
  );

  it('names the claiming session so the operator knows what to kill', () => {
    planTask(db, { repoPath: REPO, task: spec() });
    insertSession(db, {
      id: 's1',
      taskId: 't-1',
      worktreePath: '/repo/.worktrees/s1',
      branch: 'pup/s1',
      profileHash: 'hash',
    });
    transitionSession(db, 's1', 'running');

    expect(launch).toThrow(/session s1/);
  });
});
