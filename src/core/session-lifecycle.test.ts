import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux/`claude -p` boundary only: everything else (sqlite, the profile
// compiler, git worktrees) runs for real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', () => ({
  kickoff: vi.fn(() => true),
  killSession: vi.fn(),
  launchSession: vi.fn(() => ({ target: 'pup-s:0.0' })),
  transcriptDir: vi.fn(() => '/transcripts'),
}));

import { openStore } from './db.client.js';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { projectId } from './paths.utils.js';
import { InvalidProfileError } from './profile.errors.js';
import {
  ensureProject,
  getTask,
  insertSession,
  insertTask,
  listBacklogTasks,
  listEvents,
  transitionSession,
} from './session.repository.js';
import {
  ScopeConflictError,
  TaskAlreadyClaimedError,
  UnknownTaskError,
} from './session-lifecycle.errors.js';
import { createSession, launchTask, planTask } from './session-lifecycle.service.js';
import type { TaskId, TaskSpec } from './types/profile.types.js';

// Test repos must not inherit the developer's global git config nor GIT_DIR & co.
// — when this suite runs inside a git hook (pre-commit), those would redirect
// every git call at the pupitre repo instead of the temp repo.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

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

describe('launchTask scope-conflict guard', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    // projectPaths writes compiled profiles under $HOME/.pupitre.
    vi.stubEnv('HOME', realpathSync(mkdtempSync(join(tmpdir(), 'pup-launch-home-'))));
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-launch-')));
    gitIn(repo, 'init', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 't@t');
    gitIn(repo, 'config', 'user.name', 't');
    commitIn(repo, 'src/core/github.client.ts', 'export const gh = 1;\n');
    ensureProject(db, projectId(repo), repo);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A running session already holding `src/core/**`. */
  function seedHolder(): void {
    insertTask(db, {
      id: 't-held',
      projectId: projectId(repo),
      spec: JSON.stringify({ id: 't-held', goal: 'hold it', scopeIn: ['src/core/**'] }),
    });
    insertSession(db, {
      id: 's-held',
      taskId: 't-held',
      worktreePath: join(repo, '.worktrees', 's-held'),
      branch: 'pup/s-held',
      profileHash: 'hash',
    });
    transitionSession(db, 's-held', 'running');
  }

  const launch = (allowOverlap?: boolean) =>
    launchTask(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      taskId: 't-1',
      claudeUserDir: join(repo, '.claude'),
      allowOverlap,
    });

  it('refuses a task whose scope a live session already holds', () => {
    planTask(db, { repoPath: repo, task: spec() });
    seedHolder();

    expect(launch).toThrow(ScopeConflictError);
  });

  it('names the session and the shared file so the operator can act', () => {
    planTask(db, { repoPath: repo, task: spec() });
    seedHolder();

    expect(launch).toThrow(/s-held.*src\/core\/github\.client\.ts/);
  });

  // Refused before `git worktree add`, so a retry after narrowing the scope is
  // not blocked by an orphan branch of the same name (decision 40's trap).
  it('leaves no session, worktree or branch behind when it refuses', () => {
    planTask(db, { repoPath: repo, task: spec() });
    seedHolder();

    expect(launch).toThrow(ScopeConflictError);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE task_id = 't-1'").get()).toEqual({
      n: 0,
    });
    expect(gitIn(repo, 'branch', '--list', 'pup/t-1')).toBe('');
    expect(listBacklogTasks(db, projectId(repo)).map((t) => t.id)).toEqual(['t-1']);
  });

  it('launches when nothing live holds the scope', () => {
    planTask(db, { repoPath: repo, task: spec() });

    expect(launch()).toBe('t-1');
  });

  it('launches over the conflict when the operator allows the overlap', () => {
    planTask(db, { repoPath: repo, task: spec() });
    seedHolder();

    expect(launch(true)).toBe('t-1');
  });

  // The override is a considered one, so it leaves the same kind of trace
  // `--accept-debt` does: what was waved through, and against whom.
  it('records what an allowed overlap waved through', () => {
    planTask(db, { repoPath: repo, task: spec() });
    seedHolder();

    const overlap = listEvents(db, launch(true)).find((e) => e.type === 'scope_overlap');

    expect(JSON.parse(overlap?.payload ?? '{}')).toEqual({
      via: 'operator',
      accepted: [{ session: 's-held', files: ['src/core/github.client.ts'] }],
    });
  });

  // `pup launch` refusing costs nothing — the task was already in the backlog.
  // `pup new` refusing after `planTask` would leave the spec the operator just
  // abandoned in the backlog, attributed to them and launchable by any session.
  it('writes no task row when `pup new` is refused for a conflict', () => {
    seedHolder();

    expect(() =>
      createSession(db, {
        repoPath: repo,
        base: DEFAULT_BASE_PROFILE,
        task: spec(),
        claudeUserDir: join(repo, '.claude'),
      }),
    ).toThrow(ScopeConflictError);
    expect(getTask(db, 't-1')).toBeUndefined();
    expect(listBacklogTasks(db, projectId(repo))).toEqual([]);
  });

  it('still plans and launches through `pup new` when the operator allows the overlap', () => {
    seedHolder();

    const sessionId = createSession(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      task: spec(),
      claudeUserDir: join(repo, '.claude'),
      allowOverlap: true,
    });

    expect(getTask(db, 't-1')).toBeDefined();
    expect(listEvents(db, sessionId).some((e) => e.type === 'scope_overlap')).toBe(true);
  });

  // The conflict check is the first consumer of a stored spec's globs, so a row
  // written before `pup plan add` validated them must still fail legibly.
  it('refuses a stored spec with no usable scope before reading its globs', () => {
    planTask(db, { repoPath: repo, task: spec() });
    db.prepare('UPDATE tasks SET spec = ? WHERE id = ?').run(
      JSON.stringify({ id: 't-1', goal: 'legacy row', acceptance: [] }),
      't-1',
    );
    seedHolder();

    expect(launch).toThrow(InvalidProfileError);
  });

  // `createSession` admits before the row exists and cannot refuse after, so a
  // holder that appears between its read and `launchTask`'s is recorded — but
  // as raced, not as something the operator accepted (decision 41).
  it('records a holder that raced in as raced, not as operator-accepted', () => {
    planTask(db, { repoPath: repo, task: spec() });
    seedHolder();

    const sessionId = launchTask(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      taskId: 't-1',
      claudeUserDir: join(repo, '.claude'),
      allowOverlap: true,
      overlapVia: 'raced',
    });

    const overlap = listEvents(db, sessionId).find((e) => e.type === 'scope_overlap');
    expect(JSON.parse(overlap?.payload ?? '{}').via).toBe('raced');
  });

  it('records the operator as the one who waved an overlap through `pup new`', () => {
    seedHolder();

    const sessionId = createSession(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      task: spec(),
      claudeUserDir: join(repo, '.claude'),
      allowOverlap: true,
    });

    const overlap = listEvents(db, sessionId).find((e) => e.type === 'scope_overlap');
    expect(JSON.parse(overlap?.payload ?? '{}').via).toBe('operator');
  });

  it('records nothing when there was no conflict to allow', () => {
    planTask(db, { repoPath: repo, task: spec() });

    expect(listEvents(db, launch(true)).some((e) => e.type === 'scope_overlap')).toBe(false);
  });
});

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

function commitIn(dir: string, file: string, content: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-qm', `add ${file}`);
}
