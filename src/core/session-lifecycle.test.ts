import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux/`claude -p` boundary only: everything else (sqlite, the profile
// compiler, git worktrees) runs for real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  interruptPane: vi.fn(),
  kickoff: vi.fn(() => true),
  killSession: vi.fn(),
  launchSession: vi.fn(({ sessionId }: { sessionId: string }) => ({ sessionId, paneId: '%7' })),
  steerPane: vi.fn(),
  transcriptDir: vi.fn(() => '/transcripts'),
}));

import {
  interruptPane,
  kickoff,
  killSession as killTmux,
  launchSession,
  SessionPaneMissingError,
  SteerNotDeliveredError,
  steerPane,
} from '../claude/session-runtime.service.js';
import { briefPath } from './brief.service.js';
import { openStore } from './db.client.js';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { ArmedGitDriverError } from './git-diff.client.js';
import { projectId } from './paths.utils.js';
import { InvalidProfileError } from './profile.errors.js';
import {
  ensureProject,
  getSession,
  getTask,
  insertSession,
  insertTask,
  listBacklogTasks,
  listEvents,
  type SessionRow,
  transitionSession,
} from './session.repository.js';
import {
  LaunchRolledBackError,
  ScopeConflictError,
  TaskAlreadyClaimedError,
  TerminalSessionError,
  UnknownSessionError,
  UnknownTaskError,
} from './session-lifecycle.errors.js';
import {
  createSession,
  interruptSession,
  killSession,
  launchTask,
  markSessionQuestion,
  planTask,
  recordSteerMessage,
  sessionPane,
  steerSession,
} from './session-lifecycle.service.js';
import type { TaskId, TaskSpec } from './types/profile.types.js';

// Test repos must not inherit the developer's global git config nor GIT_DIR & co.
// — when this suite runs inside a git hook (pre-commit), those would redirect
// every git call at the pupitre repo instead of the temp repo.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/**
 * A PATH with no `codegraph` on it, so a launch's code graph is a property of
 * the test rather than of the machine running it (decision 51). `git` is still
 * reachable — these suites drive a real repo.
 */
const NO_CODEGRAPH_PATH = '/usr/bin:/bin';

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
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
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

  // The pane id, not the session name: a session target resolves to whichever
  // pane is active, and the agent can split (decision 46). Stored before the
  // kickoff types into it, and the kickoff goes to the same pane.
  it('stores the launch pane and kicks off into it', () => {
    planTask(db, { repoPath: repo, task: spec() });

    const sessionId = launch();

    expect(getSession(db, sessionId)?.tmux_target).toBe('%7');
    expect(vi.mocked(kickoff).mock.calls[0]?.[0]).toEqual({ sessionId, paneId: '%7' });
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

  it('refuses a stored spec that is not JSON, naming the task, rather than a SyntaxError', () => {
    planTask(db, { repoPath: repo, task: spec() });
    db.prepare("UPDATE tasks SET spec = 'not json {' WHERE id = 't-1'").run();

    expect(launch).toThrow(InvalidProfileError);
    expect(launch).toThrow('Task t-1 has an unusable spec: it is not valid JSON.');
    expect(getTask(db, 't-1')).toBeDefined();
  });

  // `createSession` admits before the row exists and cannot refuse after, so a
  // holder that appears between its read and `launchTask`'s is recorded — but
  // as raced, not as something the operator accepted (decision 41). The race
  // is staged in the store: a trigger seeds the holder the moment the
  // candidate's own task row lands, i.e. after the first read, before the second.
  it('records a holder that raced in as raced, not as operator-accepted', () => {
    insertTask(db, {
      id: 't-held',
      projectId: projectId(repo),
      spec: JSON.stringify({ id: 't-held', goal: 'hold it', scopeIn: ['src/core/**'] }),
    });
    db.exec(`CREATE TRIGGER race AFTER INSERT ON tasks WHEN NEW.id = 't-1' BEGIN
      INSERT INTO sessions (id, task_id, worktree_path, branch, profile_hash)
      VALUES ('s-held', 't-held', '${join(repo, '.worktrees', 's-held')}', 'pup/s-held', 'h');
    END`);

    const sessionId = createSession(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      task: spec(),
      claudeUserDir: join(repo, '.claude'),
    });

    const overlap = listEvents(db, sessionId).find((e) => e.type === 'scope_overlap');
    expect(JSON.parse(overlap?.payload ?? '{}')).toMatchObject({
      via: 'raced',
      accepted: [{ session: 's-held' }],
    });
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

// `git worktree add` checks out every file in HEAD, and a smudge filter armed
// through the shared config runs on each one with the operator's environment
// — before the compiled profile, the hooks, or the sandbox exist. The driver
// name is chosen by whoever wrote it, so there is no `-c` disarm and the only
// answer is to refuse (decision 50).
describe('launchTask armed-driver guard', () => {
  let db: Database;
  let repo: string;
  /** Written by the smudge filter if it ever runs; nothing else creates it. */
  let fired: string;

  beforeEach(() => {
    db = openStore(':memory:');
    vi.stubEnv('HOME', realpathSync(mkdtempSync(join(tmpdir(), 'pup-armed-home-'))));
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-armed-')));
    gitIn(repo, 'init', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 't@t');
    gitIn(repo, 'config', 'user.name', 't');
    commitIn(repo, 'src/core/github.client.ts', 'export const gh = 1;\n');
    ensureProject(db, projectId(repo), repo);
    fired = join(realpathSync(mkdtempSync(join(tmpdir(), 'pup-armed-fired-'))), 'fired');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** What a session can write from its worktree: both live under `.git/`. */
  function armSmudge(): void {
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* filter=pwn\n');
    gitIn(repo, 'config', 'filter.pwn.smudge', `sh -c 'echo pwned >> ${fired}; cat'`);
  }

  const launch = () =>
    launchTask(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      taskId: 't-1',
      claudeUserDir: join(repo, '.claude'),
    });

  it('refuses, and the smudge script never runs', () => {
    planTask(db, { repoPath: repo, task: spec() });
    armSmudge();

    expect(launch).toThrow(ArmedGitDriverError);
    expect(existsSync(fired)).toBe(false);
  });

  it('names both surfaces so the operator knows what to clear', () => {
    planTask(db, { repoPath: repo, task: spec() });
    armSmudge();

    expect(launch).toThrow(/info\/attributes.*filter\.pwn\.smudge/);
  });

  // Refused before `git worktree add`, so a retry after disarming is not
  // blocked by an orphan branch of the same name (decision 40's trap).
  it('leaves no session, worktree or branch behind', () => {
    planTask(db, { repoPath: repo, task: spec() });
    armSmudge();

    expect(launch).toThrow(ArmedGitDriverError);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE task_id = 't-1'").get()).toEqual({
      n: 0,
    });
    expect(gitIn(repo, 'branch', '--list', 'pup/t-1')).toBe('');
  });

  // A refusal inside `launchTask` alone would leave the spec the operator just
  // abandoned in the backlog, unclaimed and attributed to them (decision 41).
  it('writes no task row when `pup new` is refused', () => {
    armSmudge();

    expect(() =>
      createSession(db, {
        repoPath: repo,
        base: DEFAULT_BASE_PROFILE,
        task: spec(),
        claudeUserDir: join(repo, '.claude'),
      }),
    ).toThrow(ArmedGitDriverError);
    expect(getTask(db, 't-1')).toBeUndefined();
    expect(listBacklogTasks(db, projectId(repo))).toEqual([]);
    expect(existsSync(fired)).toBe(false);
  });

  it('launches normally once the driver is cleared', () => {
    planTask(db, { repoPath: repo, task: spec() });

    expect(launch()).toBe('t-1');
    expect(existsSync(fired)).toBe(false);
  });
});

/** What `act` threw, for the assertions a `toThrow` matcher cannot make. */
function caught(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function commitIn(dir: string, file: string, content: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-qm', `add ${file}`);
}

/**
 * A kickoff the new window refuses is the one failure that lands after the
 * launch has already claimed the task, inserted the row as `running` and
 * opened the window. Undone here rather than at each front end, so `pup
 * launch` and the dashboard's `l` leave the same nothing behind (decision 40).
 */
describe('launchTask rollback', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    vi.stubEnv('HOME', realpathSync(mkdtempSync(join(tmpdir(), 'pup-rollback-home-'))));
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-rollback-')));
    gitIn(repo, 'init', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 't@t');
    gitIn(repo, 'config', 'user.name', 't');
    commitIn(repo, 'src/core/github.client.ts', 'export const gh = 1;\n');
    ensureProject(db, projectId(repo), repo);
    planTask(db, { repoPath: repo, task: spec() });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const launch = () =>
    launchTask(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      taskId: 't-1',
      claudeUserDir: join(repo, '.claude'),
    });

  // Both ways a kickoff is refused with nothing typed: the paste never landed
  // whole (decision 45), or the pane pinned at launch was gone before it could
  // be typed into (decision 46).
  it.each([
    ['the paste never landed whole', () => new SteerNotDeliveredError('t-1', 3000)],
    ['the pane was gone', () => new SessionPaneMissingError('t-1', '%7', 'gone')],
  ])('kills the session and hands back both halves when %s', (_case, refusal) => {
    const thrown = refusal();
    vi.mocked(kickoff).mockImplementationOnce(() => {
      throw thrown;
    });

    const error = caught(launch) as LaunchRolledBackError;

    expect(error).toBeInstanceOf(LaunchRolledBackError);
    expect(error.refusal).toBe(thrown);
    // The clause each front end punctuates its own retry onto.
    expect(error.rolledBack).toBe('Launch rolled back (session t-1 killed)');
    expect(killTmux).toHaveBeenCalledWith('t-1', '%7');
    expect(getSession(db, 't-1')?.state).toBe('killed');
  });

  // The whole point of the kill: a claimed task no relaunch could take, and an
  // empty window, is what a refusal left behind before it.
  it('returns the task to the backlog, so the retry is a fresh launch', () => {
    vi.mocked(kickoff).mockImplementationOnce(() => {
      throw new SteerNotDeliveredError('t-1', 3000);
    });

    expect(launch).toThrow(LaunchRolledBackError);
    expect(listBacklogTasks(db, projectId(repo)).map((task) => task.id)).toEqual(['t-1']);
    // And it launches: a task still claimed would raise TaskAlreadyClaimedError.
    expect(launch()).toBe('t-1-1');
  });

  // The other way a kickoff fails: the window never showed its input box, so
  // nothing was typed and nothing refused it. Reporting that launch as a
  // success left a bypass-permissions agent sitting in a fresh worktree with
  // none of its task read, and the task claimed by it.
  it('kills a session whose window never became ready, and says so in one line', () => {
    vi.mocked(kickoff).mockReturnValueOnce(false);

    const error = caught(launch) as LaunchRolledBackError;

    expect(error).toBeInstanceOf(LaunchRolledBackError);
    // Nothing said anything, so the rollback line is the whole of it.
    expect(error.refusal).toBeUndefined();
    expect(error.rolledBack).toBe(
      "Session t-1's window never became ready, so its context was not delivered and the " +
        'session was killed',
    );
    expect(killTmux).toHaveBeenCalledWith('t-1', '%7');
    expect(getSession(db, 't-1')?.state).toBe('killed');
    expect(listBacklogTasks(db, projectId(repo)).map((task) => task.id)).toEqual(['t-1']);
  });

  // The kickoff event survives the rollback: the session it was written on is
  // killed, not deleted, and it is the only record of why.
  it('leaves the undelivered kickoff on record', () => {
    vi.mocked(kickoff).mockReturnValueOnce(false);

    expect(launch).toThrow(LaunchRolledBackError);
    expect(
      listEvents(db, 't-1')
        .filter((event) => event.type === 'steer')
        .map((event) => JSON.parse(event.payload)),
    ).toEqual([{ kind: 'kickoff', delivered: false }]);
  });

  // A rollback that fails is a bug path and ends in a stack, as it always has.
  // The refusal is why the launch failed and must not be lost behind it.
  it('carries the refusal out as the cause when the kill itself throws', () => {
    vi.mocked(kickoff).mockImplementationOnce(() => {
      throw new SteerNotDeliveredError('t-1', 3000);
    });
    vi.mocked(killTmux).mockImplementationOnce(() => {
      throw new Error('tmux server gone');
    });

    const error = caught(launch) as Error;

    expect(error.message).toBe('tmux server gone');
    expect(error.cause).toBeInstanceOf(SteerNotDeliveredError);
  });

  // Only a refused kickoff is answered for. Anything else is a bug, and a bug
  // that killed the session it crashed in would throw away the evidence.
  it('leaves the session alone when the launch fails some other way', () => {
    vi.mocked(kickoff).mockImplementationOnce(() => {
      throw new TypeError('undefined is not a function');
    });

    expect(launch).toThrow(TypeError);
    expect(killTmux).not.toHaveBeenCalled();
    expect(getSession(db, 't-1')?.state).toBe('running');
  });
});

describe('steer, interrupt and kill by session id', () => {
  let db: Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    ensureProject(db, 'proj-1', REPO);
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: '{}' });
    insertSession(db, {
      id: 's-1',
      taskId: 't-1',
      worktreePath: `${REPO}/.worktrees/s-1`,
      branch: 'pup/s-1',
      profileHash: 'hash',
      tmuxTarget: '%7',
    });
    transitionSession(db, 's-1', 'running');
  });

  it('addresses the pane recorded at launch, never the session', () => {
    steerSession(db, 's-1', 'do X instead', { kind: 'manual' });
    interruptSession(db, 's-1');

    expect(steerPane).toHaveBeenCalledWith({ sessionId: 's-1', paneId: '%7' }, 'do X instead');
    expect(interruptPane).toHaveBeenCalledWith({ sessionId: 's-1', paneId: '%7' });
  });

  // A launch that failed before its update leaves no pane on the row. There
  // is no name to fall back to: a session target would resolve to whichever
  // pane is active, which is the hole the pane pin closes.
  it('refuses a session with no pane recorded, and sends nothing', () => {
    db.prepare("UPDATE sessions SET tmux_target = NULL WHERE id = 's-1'").run();

    expect(() => steerSession(db, 's-1', 'do X')).toThrow(SessionPaneMissingError);
    expect(() => interruptSession(db, 's-1')).toThrow(
      'Session s-1 has no pane recorded at launch; nothing was sent.',
    );
    expect(() => sessionPane(getSession(db, 's-1') as SessionRow)).toThrow(SessionPaneMissingError);
    expect(steerPane).not.toHaveBeenCalled();
    expect(interruptPane).not.toHaveBeenCalled();
  });

  it('names a session the store does not hold', () => {
    expect(() => steerSession(db, 's-9', 'do X')).toThrow(UnknownSessionError);
    expect(() => interruptSession(db, 's-9')).toThrow('No session s-9.');
    expect(() => recordSteerMessage(db, 's-9', 'operator')).toThrow('No session s-9.');
  });

  // A merged session's work is on the branch and a killed one's window is
  // gone; either way there is nothing to correct, and the pane id left on the
  // row belongs to whatever holds it now. Refused in core, so `pup steer` and
  // the dashboard's `s` refuse the same sessions.
  it.each([
    ['merged', ['awaiting-review', 'merged']],
    ['killed', ['killed']],
  ])('refuses a %s session, and sends nothing', (state, steps) => {
    for (const step of steps) transitionSession(db, 's-1', step as 'merged');

    expect(() => steerSession(db, 's-1', 'do X')).toThrow(
      `Session s-1 is ${state}; nothing to steer.`,
    );
    expect(() => interruptSession(db, 's-1')).toThrow(TerminalSessionError);
    expect(() => interruptSession(db, 's-1')).toThrow(
      `Session s-1 is ${state}; nothing to interrupt.`,
    );
    expect(() => recordSteerMessage(db, 's-1', 'operator')).toThrow(TerminalSessionError);
    expect(steerPane).not.toHaveBeenCalled();
    expect(interruptPane).not.toHaveBeenCalled();
    expect(listEvents(db, 's-1').map((event) => event.type)).not.toContain('steer');
  });

  // The record is core's now, not each front end's: a steer nobody recorded is
  // a session the report and the last-steer queries show as corrected by
  // nobody.
  it('records the steer it typed, and records nothing when the paste is refused', () => {
    steerSession(db, 's-1', 'do X instead', { kind: 'manual' });
    vi.mocked(steerPane).mockImplementationOnce(() => {
      throw new SteerNotDeliveredError('s-1', 12);
    });

    expect(() => steerSession(db, 's-1', 'do Y', { kind: 'manual' })).toThrow(
      SteerNotDeliveredError,
    );
    expect(steerEvents()).toEqual([{ kind: 'manual' }]);
  });

  // A typed steer is not the operator's just because it was typed: the
  // conductor and every session can type one too, and a record that named the
  // operator for all three would make the report's account of who corrected a
  // session worthless (decisions 44, 47).
  it('records the sender the caller named, for a typed steer as for a sent one', () => {
    steerSession(db, 's-1', 'do X instead', { kind: 'manual', by: 'conductor' });
    recordSteerMessage(db, 's-1', 'session:s-2');

    expect(steerEvents()).toEqual([
      { kind: 'manual', by: 'conductor' },
      { kind: 'message', by: 'session:s-2' },
    ]);
  });

  // The watchdog's resume and the gate's re-steer record the outcome of a
  // whole sweep or gate run, not the paste alone, so they write their own
  // event once they know it — and must not get a second one from here.
  it('records nothing for a caller that keeps its own event', () => {
    steerSession(db, 's-1', 'resume');

    expect(steerPane).toHaveBeenCalledWith({ sessionId: 's-1', paneId: '%7' }, 'resume');
    expect(steerEvents()).toEqual([]);
  });

  // A message over the peer socket lands whole and never touches the input
  // box, so there is nothing to type — only the record, which names the sender
  // the caller identified (decisions 44, 47).
  it('records a message steer without typing anything', () => {
    recordSteerMessage(db, 's-1', 'session:s-2');

    expect(steerPane).not.toHaveBeenCalled();
    expect(steerEvents()).toEqual([{ kind: 'message', by: 'session:s-2' }]);
  });

  it('records the interrupt it sent, and the steer that rode with it', () => {
    interruptSession(db, 's-1', 'do X instead');

    expect(interruptPane).toHaveBeenCalledWith({ sessionId: 's-1', paneId: '%7' });
    expect(steerPane).toHaveBeenCalledWith({ sessionId: 's-1', paneId: '%7' }, 'do X instead');
    expect(events('interrupt')).toEqual([{ steered: true }]);
    // A real steer, recorded as one too, so last-steer queries see it no
    // matter which path delivered it.
    expect(steerEvents()).toEqual([{ kind: 'interrupt' }]);
  });

  it('names the sender of the steer behind Escape where the caller gives one', () => {
    interruptSession(db, 's-1', 'do X instead', 'session:s-2');

    expect(steerEvents()).toEqual([{ kind: 'interrupt', by: 'session:s-2' }]);
  });

  // Escape landed before the paste was refused, so the interrupt is on record
  // and the steer is not — the one thing the two-call front-end version of
  // this had to remember to do.
  it('records the interrupt alone when the steer behind it is refused', () => {
    vi.mocked(steerPane).mockImplementationOnce(() => {
      throw new SteerNotDeliveredError('s-1', 12);
    });

    expect(() => interruptSession(db, 's-1', 'do X')).toThrow(SteerNotDeliveredError);
    expect(events('interrupt')).toEqual([{ steered: false }]);
    expect(steerEvents()).toEqual([]);
  });

  it('records nothing when the pane is not there to interrupt', () => {
    db.prepare("UPDATE sessions SET tmux_target = NULL WHERE id = 's-1'").run();

    expect(() => interruptSession(db, 's-1', 'do X')).toThrow(SessionPaneMissingError);
    expect(listEvents(db, 's-1').map((event) => event.type)).not.toContain('interrupt');
  });

  const events = (type: string): unknown[] =>
    listEvents(db, 's-1')
      .filter((event) => event.type === type)
      .map((event) => JSON.parse(event.payload));

  const steerEvents = (): unknown[] => events('steer');

  it('kills by the recorded pane as well as the name, then marks the row killed', () => {
    killSession(db, 's-1');

    expect(killTmux).toHaveBeenCalledWith('s-1', '%7');
    expect(getSession(db, 's-1')?.state).toBe('killed');
  });

  // Decision 76: asking is not finishing. The worker ends its turn and the
  // next steer answers, so the row stays where a steer can reach it.
  it('records a question with its text and leaves the session running', () => {
    markSessionQuestion(db, 's-1', 'rebase onto main or merge it?');

    expect(events('question')).toEqual([{ text: 'rebase onto main or merge it?' }]);
    expect(getSession(db, 's-1')?.state).toBe('running');
  });
});

// A session's graph is its own worktree's, built at launch, and the launch
// survives not having one. The binary is faked per docs/conventions/testing.md:
// what is under test is what pup asks codegraph to index and what it then hands
// `claude`, not codegraph's own indexing (decision 51).
describe('launchTask code graph', () => {
  let db: Database;
  let repo: string;
  let cgLog: string;

  /**
   * A `codegraph` that logs its argv and leaves behind what the real one does:
   * a `.codegraph/` whose own `.gitignore` hides the database but not the
   * directory, which is what the exclude line exists to cover.
   */
  function fakeCodegraph(body: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-cg-bin-')));
    cgLog = join(dir, 'calls.log');
    writeFileSync(
      join(dir, 'codegraph'),
      ['#!/bin/sh', `printf '%s\\n' "$*" >> ${cgLog}`, body].join('\n'),
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', `${dir}:${NO_CODEGRAPH_PATH}`);
    return join(dir, 'codegraph');
  }

  const INDEXES = [
    'mkdir -p "$2/.codegraph"',
    'printf \'*\\n!.gitignore\\n\' > "$2/.codegraph/.gitignore"',
    'echo sqlite > "$2/.codegraph/codegraph.db"',
    'exit 0',
  ].join('\n');

  const cgCalls = (): string[] =>
    existsSync(cgLog) ? readFileSync(cgLog, 'utf8').split('\n').filter(Boolean) : [];

  const launch = () =>
    launchTask(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      taskId: 't-1',
      claudeUserDir: join(repo, '.claude'),
    });

  // The module mocks are file-wide and never cleared, so every assertion below
  // reads the call this test made, not the first in the file.
  const launchedWith = () => vi.mocked(launchSession).mock.calls.at(-1)?.[0];
  const kickoffContext = () => vi.mocked(kickoff).mock.calls.at(-1)?.[1];

  beforeEach(() => {
    db = openStore(':memory:');
    vi.stubEnv('HOME', realpathSync(mkdtempSync(join(tmpdir(), 'pup-cg-home-'))));
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-cg-launch-')));
    gitIn(repo, 'init', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 't@t');
    gitIn(repo, 'config', 'user.name', 't');
    commitIn(repo, 'src/core/github.client.ts', 'export const gh = 1;\n');
    ensureProject(db, projectId(repo), repo);
    planTask(db, { repoPath: repo, task: spec() });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Only the console spy: `restoreAllMocks` would strip the implementations
    // off this file's module mocks, and later suites rely on them.
    vi.mocked(console.error).mockRestore();
  });

  // The worktree, never the repo it was cut from — and the index it leaves
  // behind is excluded, because the gate and the overlap radar read a clean tree.
  it('indexes the session worktree and leaves it clean', () => {
    fakeCodegraph(INDEXES);

    const worktree = join(repo, '.worktrees', launch());

    expect(cgCalls()).toEqual([`init ${worktree} --yes`]);
    expect(existsSync(join(worktree, '.codegraph', 'codegraph.db'))).toBe(true);
    expect(gitIn(worktree, 'status', '--porcelain')).toBe('');
  });

  it('launches claude against a compiled mcp.json naming the absolute binary', () => {
    const binary = fakeCodegraph(INDEXES);

    const sessionId = launch();

    const mcpConfigPath = launchedWith()?.mcpConfigPath as string;
    expect(mcpConfigPath).toMatch(/compiled\/mcp\.json$/);
    const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
    expect(config.mcpServers.codegraph.command).toBe(binary);
    expect(config.mcpServers.codegraph.args).toContain(join(repo, '.worktrees', sessionId));
    expect(kickoffContext()).toContain('## Code graph');
  });

  // No graph, never the wrong one: codegraph walks PARENTS for a `.codegraph/`,
  // so a worktree with no index of its own would be served the main checkout's
  // graph — main's code under this branch's name.
  it('withholds the mcp config when the index fails, and still launches', () => {
    fakeCodegraph('echo "out of disk" >&2\nexit 1');

    const sessionId = launch();

    expect(getSession(db, sessionId)?.state).toBe('running');
    expect(launchedWith()?.mcpConfigPath).toBeUndefined();
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('without a code graph');
  });

  it('launches normally, with one line, when the operator has no codegraph', () => {
    const sessionId = launch();

    expect(getSession(db, sessionId)?.state).toBe('running');
    expect(launchedWith()?.mcpConfigPath).toBeUndefined();
    expect(kickoffContext()).not.toContain('## Code graph');
    expect(vi.mocked(console.error).mock.calls).toHaveLength(1);
  });
});

/**
 * The launch is where the brief is read: the compiler locates it from the repo
 * path the launch hands it, so an edit lands in the next session's kickoff and
 * in no window already open (decision 57).
 */
describe('launchTask and the project brief', () => {
  let db: Database;
  let repo: string;

  const kickoffContext = () => vi.mocked(kickoff).mock.calls.at(-1)?.[1];

  const launch = () =>
    launchTask(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      taskId: 't-1',
      claudeUserDir: join(repo, '.claude'),
    });

  function writeBrief(text: string): void {
    const path = briefPath(repo);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  beforeEach(() => {
    db = openStore(':memory:');
    // The brief lives under $HOME/.pupitre beside the compiled profiles.
    vi.stubEnv('HOME', realpathSync(mkdtempSync(join(tmpdir(), 'pup-brief-home-'))));
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-brief-launch-')));
    gitIn(repo, 'init', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 't@t');
    gitIn(repo, 'config', 'user.name', 't');
    commitIn(repo, 'src/core/github.client.ts', 'export const gh = 1;\n');
    ensureProject(db, projectId(repo), repo);
    planTask(db, { repoPath: repo, task: spec() });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("kicks a session off on the brief's Destination and Constraints, never its Priorities", () => {
    writeBrief(
      '## Destination\nA control plane the operator trusts.\n\n' +
        '## Constraints\nNo new dependencies without approval.\n\n' +
        '## Priorities\n1. Close the gate bypasses.\n',
    );

    launch();

    expect(kickoffContext()).toContain('## Project brief');
    expect(kickoffContext()).toContain('### Destination\nA control plane the operator trusts.');
    expect(kickoffContext()).toContain('### Constraints\nNo new dependencies without approval.');
    expect(kickoffContext()).not.toContain('Close the gate bypasses');
  });

  it('kicks off exactly as before when the project has no brief', () => {
    launch();

    expect(kickoffContext()).not.toContain('Project brief');
    expect(kickoffContext()).toContain('## Goal');
  });
});
