import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

// The machine's memory reading only: a launch test must not depend on how
// much the machine running it has free (decision 96).
vi.mock('./test-slot.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./test-slot.service.js')>()),
  availableMemoryBytes: vi.fn(() => 64 * 1024 ** 3),
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
import { tempDir } from '../test/temp-dir.mock.js';
import { briefPath } from './brief.service.js';
import { openStore } from './db.client.js';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { ArmedGitDriverError, WorktreeConfigError } from './git-diff.client.js';
import { projectId, projectPaths } from './paths.utils.js';
import { InvalidProfileError } from './profile.errors.js';
import {
  appendEvent,
  editTaskSpec,
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
  TaskAlreadyClaimedError,
  TerminalSessionError,
  TopRungReachedError,
  UnknownSessionError,
  UnknownTaskError,
} from './session-lifecycle.errors.js';
import {
  createSession,
  fixRoundRoute,
  interruptSession,
  killSession,
  LowMemoryError,
  launchTask,
  markSessionQuestion,
  planTask,
  recompileSessionProfile,
  recordSteerMessage,
  SessionCapReachedError,
  sessionPane,
  steerSession,
} from './session-lifecycle.service.js';
import { availableMemoryBytes } from './test-slot.service.js';
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

describe('launchTask scope overlap (decision 99)', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    // projectPaths writes compiled profiles under $HOME/.pupitre.
    vi.stubEnv('HOME', tempDir('pup-launch-home-'));
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    repo = tempDir('pup-launch-');
    gitIn(repo, 'init', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 't@t');
    gitIn(repo, 'config', 'user.name', 't');
    commitIn(repo, 'src/core/github.client.ts', 'export const gh = 1;\n');
    ensureProject(db, projectId(repo), repo);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A running session already holding `scopeIn`, in a pane of its own. */
  function seedHolder(id = 's-held', scopeIn = ['src/core/**'], pane = '%3'): void {
    insertTask(db, {
      id: `t-${id}`,
      projectId: projectId(repo),
      spec: JSON.stringify({ id: `t-${id}`, goal: 'hold it', scopeIn }),
    });
    insertSession(db, {
      id,
      taskId: `t-${id}`,
      worktreePath: join(repo, '.worktrees', id),
      branch: `pup/${id}`,
      profileHash: 'hash',
    });
    db.prepare('UPDATE sessions SET tmux_target = ? WHERE id = ?').run(pane, id);
    transitionSession(db, id, 'running');
  }

  const launch = (overlapVia?: 'operator' | 'conductor') =>
    launchTask(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      taskId: 't-1',
      claudeUserDir: join(repo, '.claude'),
      overlapVia,
    });

  const kickoffText = () => String(vi.mocked(kickoff).mock.calls.at(-1)?.[1]);
  const steersTo = (paneId: string) =>
    vi.mocked(steerPane).mock.calls.filter(([pane]) => pane.paneId === paneId);

  it('launches a task whose scope a live session already holds', () => {
    planTask(db, { repoPath: repo, task: spec() });
    seedHolder();

    expect(launch()).toBe('t-1');
    expect(getSession(db, 't-1')?.state).toBe('running');
  });

  it('writes one scope_overlap event naming both sessions and the shared files', () => {
    planTask(db, { repoPath: repo, task: spec() });
    seedHolder();

    launch();

    // Across every session, not only the newcomer's: one record, not one per side.
    const recorded = db
      .prepare("SELECT session_id, payload FROM events WHERE type = 'scope_overlap'")
      .all() as { session_id: string; payload: string }[];
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.session_id).toBe('t-1');
    expect(JSON.parse(recorded[0]?.payload ?? '{}')).toEqual({
      via: 'operator',
      accepted: [{ session: 's-held', files: ['src/core/github.client.ts'] }],
    });
  });

  it('records the conductor as the launcher of an overlap it made', () => {
    planTask(db, { repoPath: repo, task: spec() });
    seedHolder();

    const overlap = listEvents(db, launch('conductor')).find((e) => e.type === 'scope_overlap');

    expect(JSON.parse(overlap?.payload ?? '{}').via).toBe('conductor');
  });

  it('records nothing and steers no one when nothing live shares the scope', () => {
    planTask(db, { repoPath: repo, task: spec() });
    seedHolder('s-other', ['docs/**']);

    expect(listEvents(db, launch()).some((e) => e.type === 'scope_overlap')).toBe(false);
    expect(steerPane).not.toHaveBeenCalled();
  });

  it("names each overlapping peer and its shared files in the new worker's kickoff", () => {
    commitIn(repo, 'src/core/gate.service.ts', 'export const g = 1;\n');
    planTask(db, { repoPath: repo, task: spec({ scopeIn: ['src/core/**'] }) });
    seedHolder('s-a', ['src/core/github.client.ts'], '%3');
    seedHolder('s-b', ['src/core/gate.service.ts'], '%4');

    launch();

    expect(kickoffText()).toContain(
      '## Peers\n' +
        'These live sessions are scoped to files you also hold. Each is reached by SendMessage ' +
        'under its peer name (it appears in ListAgents); follow the collaboration rules in the ' +
        'session protocol below.\n' +
        '- `pup-s-a` shares: src/core/github.client.ts\n' +
        '- `pup-s-b` shares: src/core/gate.service.ts',
    );
  });

  it('has no peers section when the launch overlaps nothing', () => {
    planTask(db, { repoPath: repo, task: spec() });

    launch();

    expect(kickoffText()).not.toContain('## Peers');
  });

  it('steers each existing peer exactly once, naming the newcomer and the shared files', () => {
    commitIn(repo, 'src/core/gate.service.ts', 'export const g = 1;\n');
    planTask(db, { repoPath: repo, task: spec({ scopeIn: ['src/core/**'] }) });
    seedHolder('s-a', ['src/core/github.client.ts'], '%3');
    seedHolder('s-b', ['src/core/**'], '%4');

    launch();

    expect(steersTo('%3')).toHaveLength(1);
    expect(steersTo('%3')[0]?.[1]).toBe(
      'A new peer session, pup-t-1, was just launched on files you also hold: ' +
        'src/core/github.client.ts. Before you edit one of them, message it by SendMessage ' +
        'what you will change (the function or section) and agree who does what.',
    );
    expect(steersTo('%4')).toHaveLength(1);
    expect(steersTo('%4')[0]?.[1]).toContain(
      'src/core/gate.service.ts, src/core/github.client.ts.',
    );
    expect(
      listEvents(db, 's-a')
        .filter((e) => e.type === 'steer')
        .map((e) => JSON.parse(e.payload)),
    ).toEqual([{ kind: 'peer-joined', by: 't-1' }]);
  });

  // Waking an idle window re-reads its whole cached context; the gate's
  // fresh-base stage and a fix round's introduction reach the rest (decision 104).
  it('introduces the newcomer to running peers only, not to one awaiting review or with an open PR', () => {
    planTask(db, { repoPath: repo, task: spec() });
    seedHolder('s-run', ['src/core/**'], '%3');
    seedHolder('s-review', ['src/core/**'], '%4');
    transitionSession(db, 's-review', 'awaiting-review');
    seedHolder('s-open', ['src/core/**'], '%5');
    appendEvent(db, 's-open', 'merge', {
      branch: 'pup/s-open',
      sha: 'abc123',
      target: 'main',
      files: ['src/core/github.client.ts'],
      prUrl: 'https://github.com/owner/repo/pull/8',
    });
    transitionSession(db, 's-open', 'blocked');

    const sessionId = launch();

    expect(steersTo('%3')).toHaveLength(1);
    expect(steersTo('%4')).toEqual([]);
    expect(steersTo('%5')).toEqual([]);
    const overlap = listEvents(db, sessionId).find((e) => e.type === 'scope_overlap');
    expect(
      JSON.parse(overlap?.payload ?? '{}')
        .accepted.map((a: { session: string }) => a.session)
        .sort(),
    ).toEqual(['s-open', 's-review', 's-run']);
  });

  it('sends no introduction for an overlap on the append-only decisions log alone', () => {
    commitIn(repo, 'docs/09-decisions.md', '# Decisions\n');
    planTask(db, { repoPath: repo, task: spec({ scopeIn: ['docs/09-decisions.md'] }) });
    seedHolder('s-docs', ['docs/**'], '%3');

    const sessionId = launch();

    expect(steerPane).not.toHaveBeenCalled();
    expect(listEvents(db, sessionId).some((e) => e.type === 'scope_overlap')).toBe(true);
    expect(kickoffText()).toContain('- `pup-s-docs` shares: docs/09-decisions.md');
  });

  it('leaves the decisions log out of an introduction that names other files too', () => {
    commitIn(repo, 'docs/09-decisions.md', '# Decisions\n');
    planTask(db, {
      repoPath: repo,
      task: spec({ scopeIn: ['docs/09-decisions.md', 'src/core/github.client.ts'] }),
    });
    seedHolder('s-both', ['docs/**', 'src/core/**'], '%3');

    launch();

    expect(String(steersTo('%3')[0]?.[1])).toContain(
      'on files you also hold: src/core/github.client.ts. Before',
    );
  });

  // The newcomer's kickoff already names the peer, so either side can open the
  // conversation; a peer's refused paste is no reason to undo a launch that worked.
  it('keeps the launch when a peer refuses the steer', () => {
    planTask(db, { repoPath: repo, task: spec() });
    seedHolder();
    vi.mocked(steerPane).mockImplementationOnce(() => {
      throw new SteerNotDeliveredError('s-held', 10, 'box-absent');
    });

    expect(launch()).toBe('t-1');
    expect(getSession(db, 't-1')?.state).toBe('running');
    expect(listEvents(db, 's-held').some((e) => e.type === 'steer')).toBe(false);
  });

  // Paths come from `git ls-files` and a peer name from the store; both are
  // typed into a pane, where a control character is a keystroke.
  it('scrubs control characters from peer names and paths in the kickoff and the steer', () => {
    const planted = 'src/core/evil\u001b]0;pwn\u0007\u009b2J.ts';
    commitIn(repo, planted, 'export const e = 1;\n');
    planTask(db, { repoPath: repo, task: spec({ scopeIn: ['src/core/**'] }) });
    seedHolder('s\u001b[31m-held', [planted]);

    launch();

    for (const text of [kickoffText(), String(steersTo('%3')[0]?.[1])]) {
      expect(text).toContain('evil ]0;pwn 2J.ts');
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence is the point
      expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    }
    expect(kickoffText()).toContain('`pup-s [31m-held` shares:');
  });

  it('plans and launches through `pup new` over a live session, recording the overlap', () => {
    seedHolder();

    const sessionId = createSession(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      task: spec(),
      claudeUserDir: join(repo, '.claude'),
    });

    expect(getTask(db, 't-1')).toBeDefined();
    const overlap = listEvents(db, sessionId).find((e) => e.type === 'scope_overlap');
    expect(JSON.parse(overlap?.payload ?? '{}').via).toBe('operator');
    expect(steersTo('%3')).toHaveLength(1);
  });

  // The overlap check is the first consumer of a stored spec's globs, so a row
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

  // The pane id, not the session name: a session target resolves to whichever
  // pane is active, and the agent can split (decision 46). Stored before the
  // kickoff types into it, and the kickoff goes to the same pane.
  it('stores the launch pane and kicks off into it', () => {
    planTask(db, { repoPath: repo, task: spec() });

    const sessionId = launch();

    expect(getSession(db, sessionId)?.tmux_target).toBe('%7');
    expect(vi.mocked(kickoff).mock.calls[0]?.[0]).toEqual({ sessionId, paneId: '%7' });
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
    vi.stubEnv('HOME', tempDir('pup-armed-home-'));
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    repo = tempDir('pup-armed-');
    gitIn(repo, 'init', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 't@t');
    gitIn(repo, 'config', 'user.name', 't');
    commitIn(repo, 'src/core/github.client.ts', 'export const gh = 1;\n');
    ensureProject(db, projectId(repo), repo);
    fired = join(tempDir('pup-armed-fired-'), 'fired');
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

// Usually the operator's config: `git sparse-checkout` turns
// `extensions.worktreeConfig` on, and the launch's own check refused it only
// once the worktree and the row existed, which then blocked every retry
// (decision 101).
describe('launchTask worktree-config guard', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    vi.stubEnv('HOME', tempDir('pup-wtconfig-home-'));
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    repo = tempDir('pup-wtconfig-');
    gitIn(repo, 'init', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 't@t');
    gitIn(repo, 'config', 'user.name', 't');
    commitIn(repo, 'src/core/github.client.ts', 'export const gh = 1;\n');
    ensureProject(db, projectId(repo), repo);
    gitIn(repo, 'sparse-checkout', 'set', 'src');
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

  it('refuses before any row, worktree or branch, and a retry once cleared launches', () => {
    planTask(db, { repoPath: repo, task: spec() });

    expect(launch).toThrow(WorktreeConfigError);
    expect(launch).toThrow(/git sparse-checkout/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE task_id = 't-1'").get()).toEqual({
      n: 0,
    });
    expect(existsSync(join(repo, '.worktrees', 't-1'))).toBe(false);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain('.worktrees');
    expect(gitIn(repo, 'branch', '--list', 'pup/t-1')).toBe('');

    // Cleared as the refusal says; nothing left behind claims the task.
    gitIn(repo, 'sparse-checkout', 'disable');
    gitIn(
      repo,
      '-C',
      '/',
      'config',
      '--file',
      join(repo, '.git/config'),
      '--unset',
      'extensions.worktreeConfig',
    );
    unlinkSync(join(repo, '.git', 'config.worktree'));
    expect(launch()).toBe('t-1');
  });

  it('writes no task row when `pup new` is refused', () => {
    expect(() =>
      createSession(db, {
        repoPath: repo,
        base: DEFAULT_BASE_PROFILE,
        task: spec(),
        claudeUserDir: join(repo, '.claude'),
      }),
    ).toThrow(WorktreeConfigError);
    expect(getTask(db, 't-1')).toBeUndefined();
    expect(listBacklogTasks(db, projectId(repo))).toEqual([]);
    expect(gitIn(repo, 'branch', '--list', 'pup/t-1')).toBe('');
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
    vi.stubEnv('HOME', tempDir('pup-rollback-home-'));
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    repo = tempDir('pup-rollback-');
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

describe('launchTask model routing (decision 92)', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    vi.stubEnv('HOME', tempDir('pup-route-home-'));
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    repo = tempDir('pup-route-');
    gitIn(repo, 'init', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 't@t');
    gitIn(repo, 'config', 'user.name', 't');
    commitIn(repo, 'src/cli/ui/app.component.tsx', 'export const app = 1;\n');
    ensureProject(db, projectId(repo), repo);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const launch = (
    override: { model?: string; effort?: string; overrideVia?: 'operator' | 'conductor' } = {},
  ) =>
    launchTask(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      taskId: 't-1',
      claudeUserDir: join(repo, '.claude'),
      ...override,
    });
  const launchedRoute = () => vi.mocked(launchSession).mock.calls.at(-1)?.[0].route;
  const routeColumns = (sessionId: string) =>
    db
      .prepare(
        'SELECT tier, rung, model, effort, rung_reason, route_override FROM sessions WHERE id = ?',
      )
      .get(sessionId);
  /** The session's window ran into a gate rejection, and the operator killed it. */
  const rejectAndKill = (sessionId: string) => {
    transitionSession(db, sessionId, 'awaiting-review');
    transitionSession(db, sessionId, 'rejected');
    killSession(db, sessionId);
  };
  const UI_SCOPE = { scopeIn: ['src/cli/ui/**'] };

  it('starts a UI task on the first standard rung, recorded on the session', () => {
    planTask(db, { repoPath: repo, task: spec(UI_SCOPE) });

    const sessionId = launch();

    expect(launchedRoute()).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      fallbackModel: 'claude-opus-5-5',
    });
    expect(routeColumns(sessionId)).toEqual({
      tier: 'standard',
      rung: 0,
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      rung_reason: null,
      route_override: 0,
    });
  });

  it('starts a task whose scope touches the store on the first critical rung', () => {
    planTask(db, { repoPath: repo, task: spec({ scopeIn: ['src/core/session.repository.ts'] }) });

    launch();

    expect(launchedRoute()).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
  });

  it('takes the tier the operator stored over the one the scope implies', () => {
    planTask(db, { repoPath: repo, task: spec(UI_SCOPE) });
    editTaskSpec(db, 't-1', { tier: 'critical' });

    const sessionId = launch();

    expect(launchedRoute()).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    expect(routeColumns(sessionId)).toMatchObject({ tier: 'critical', rung: 0 });
  });

  it('climbs exactly one rung on the relaunch after a gate rejection, recording why', () => {
    planTask(db, { repoPath: repo, task: spec(UI_SCOPE) });
    rejectAndKill(launch());

    const relaunched = launch();

    expect(relaunched).toBe('t-1-1');
    expect(launchedRoute()).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'high',
      fallbackModel: 'claude-opus-5-5',
    });
    expect(routeColumns(relaunched)).toMatchObject({ rung: 1, rung_reason: 'gate-rejection' });
  });

  it('climbs on the relaunch after a dead turn the watcher recorded', () => {
    planTask(db, { repoPath: repo, task: spec(UI_SCOPE) });
    const first = launch();
    appendEvent(db, first, 'turn_died', { reason: 'API Error: 529', stalledAt: 'x' });
    killSession(db, first);

    const relaunched = launch();

    expect(routeColumns(relaunched)).toMatchObject({ rung: 1, rung_reason: 'turn-death' });
  });

  /** The session's hook events file, last written `ageMs` before now. */
  const quietFor = (sessionId: string, ageMs: number) => {
    const eventsFile = projectPaths(repo).eventsFile(sessionId);
    mkdirSync(dirname(eventsFile), { recursive: true });
    writeFileSync(eventsFile, '{}\n');
    const at = new Date(Date.now() - ageMs);
    utimesSync(eventsFile, at, at);
  };
  const STALLED = 11 * 60 * 1000;

  // No event records a stall: the window was quiet past the bar (decision 35)
  // when the operator killed it, which the kill's time and the events file say.
  it('climbs on the relaunch after a window killed while stalled', () => {
    planTask(db, { repoPath: repo, task: spec(UI_SCOPE) });
    const first = launch();
    quietFor(first, STALLED);
    killSession(db, first);

    expect(routeColumns(launch())).toMatchObject({ rung: 1, rung_reason: 'stall' });
  });

  it('does not climb after a window that was busy, or only done, when it was killed', () => {
    planTask(db, { repoPath: repo, task: spec(UI_SCOPE) });
    const busy = launch();
    quietFor(busy, 60_000);
    killSession(db, busy);
    const done = launch();
    quietFor(done, STALLED);
    transitionSession(db, done, 'awaiting-review');
    killSession(db, done);

    expect(routeColumns(launch())).toMatchObject({ rung: 0, rung_reason: null });
  });

  it("records the operator's explicit effort as an override, on the rung's model", () => {
    planTask(db, { repoPath: repo, task: spec(UI_SCOPE) });

    const sessionId = launch({ effort: 'low' });

    expect(launchedRoute()).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'low',
      fallbackModel: 'claude-opus-5-5',
    });
    expect(routeColumns(sessionId)).toMatchObject({
      rung: 0,
      model: 'claude-sonnet-5-5',
      effort: 'low',
      route_override: 1,
    });
  });

  it('stays on its rung, and keeps why it got there, when the last window ran into nothing', () => {
    planTask(db, { repoPath: repo, task: spec(UI_SCOPE) });
    rejectAndKill(launch());
    killSession(db, launch());

    const third = launch();

    expect(routeColumns(third)).toMatchObject({ rung: 1, rung_reason: 'gate-rejection' });
  });

  it('never climbs a task the gate parked as blocked', () => {
    planTask(db, { repoPath: repo, task: spec(UI_SCOPE) });
    const first = launch();
    transitionSession(db, first, 'awaiting-review');
    transitionSession(db, first, 'rejected');
    transitionSession(db, first, 'blocked');
    killSession(db, first);

    expect(routeColumns(launch())).toMatchObject({ rung: 0, rung_reason: null });
  });

  it('refuses the relaunch after a failure on the top rung, launching nothing', () => {
    planTask(db, { repoPath: repo, task: spec({ scopeIn: ['src/claude/**'] }) });
    rejectAndKill(launch());
    rejectAndKill(launch());
    vi.mocked(launchSession).mockClear();

    expect(launch).toThrow(TopRungReachedError);
    expect(launch).toThrow(/gate-rejection on the top rung of its critical ladder/);
    expect(launchSession).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE task_id = 't-1'").get()).toEqual({
      n: 2,
    });
  });

  it("refuses the conductor's model at the top rung: only the operator lifts it", () => {
    planTask(db, { repoPath: repo, task: spec({ scopeIn: ['src/claude/**'] }) });
    rejectAndKill(launch());
    rejectAndKill(launch());

    expect(() => launch({ model: 'claude-opus-5-5', overrideVia: 'conductor' })).toThrow(
      TopRungReachedError,
    );
  });

  it("relaunches past the top on the operator's explicit model, recorded as an override", () => {
    planTask(db, { repoPath: repo, task: spec({ scopeIn: ['src/claude/**'] }) });
    rejectAndKill(launch());
    rejectAndKill(launch());

    const sessionId = launch({ model: 'claude-sonnet-5-5' });

    expect(launchedRoute()).toEqual({ model: 'claude-sonnet-5-5', effort: 'xhigh' });
    expect(routeColumns(sessionId)).toMatchObject({
      tier: 'critical',
      rung: 1,
      model: 'claude-sonnet-5-5',
      effort: 'xhigh',
      route_override: 1,
    });
  });

  // A CI fix round is the climb decision 92 counts for `pup fix` (decision 90).
  it('climbs a fix round one rung, and only the operator lifts the top rung', () => {
    planTask(db, { repoPath: repo, task: spec(UI_SCOPE) });
    const sessionId = launch();
    const session = () => getSession(db, sessionId) as SessionRow;
    const named = { model: 'claude-opus-5-5', effort: 'max' };

    expect(fixRoundRoute(db, session(), {}, 'conductor')).toEqual({
      tier: 'standard',
      rung: 1,
      model: 'claude-sonnet-5-5',
      effort: 'high',
      reason: 'ci-fix-round',
      override: false,
    });

    db.prepare('UPDATE sessions SET rung = 3 WHERE id = ?').run(sessionId);
    expect(() => fixRoundRoute(db, session(), {}, 'operator')).toThrow(TopRungReachedError);
    expect(() => fixRoundRoute(db, session(), named, 'conductor')).toThrow(TopRungReachedError);
    expect(fixRoundRoute(db, session(), named, 'operator')).toMatchObject({
      rung: 3,
      ...named,
      override: true,
    });
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
    const dir = tempDir('pup-cg-bin-');
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
    vi.stubEnv('HOME', tempDir('pup-cg-home-'));
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    repo = tempDir('pup-cg-launch-');
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
    vi.stubEnv('HOME', tempDir('pup-brief-home-'));
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    repo = tempDir('pup-brief-launch-');
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

describe('launch capacity (decision 96)', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    vi.stubEnv('HOME', tempDir('pup-cap-home-'));
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    repo = tempDir('pup-cap-');
    gitIn(repo, 'init', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 't@t');
    gitIn(repo, 'config', 'user.name', 't');
    commitIn(repo, 'src/core/github.client.ts', 'export const gh = 1;\n');
    ensureProject(db, projectId(repo), repo);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** `count` sessions in `state`, each on a task of its own sharing no file with `t-1`. */
  function seedSessions(count: number, state: 'running' | 'killed' = 'running'): void {
    for (let index = 0; index < count; index++) {
      const id = `s-${state}-${index}`;
      insertTask(db, {
        id: `t-${id}`,
        projectId: projectId(repo),
        spec: JSON.stringify({ id: `t-${id}`, goal: 'elsewhere', scopeIn: ['docs/**'] }),
      });
      insertSession(db, {
        id,
        taskId: `t-${id}`,
        worktreePath: join(repo, '.worktrees', id),
        branch: `pup/${id}`,
        profileHash: 'hash',
      });
      transitionSession(db, id, 'running');
      if (state === 'killed') transitionSession(db, id, 'killed');
    }
  }

  const launch = (by: 'operator' | 'conductor', overCap = false): string => {
    planTask(db, { repoPath: repo, task: spec() });
    return launchTask(db, {
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      taskId: 't-1',
      claudeUserDir: join(repo, '.claude'),
      overlapVia: by,
      overrideVia: by,
      overCap,
    });
  };

  it('launches below the default cap of four', () => {
    seedSessions(3);

    expect(launch('operator')).toBe('t-1');
  });

  it.each(['operator', 'conductor'] as const)(
    'refuses the %s at the cap, naming it and launching nothing',
    (by) => {
      seedSessions(4);

      expect(() => launch(by)).toThrow(
        "4 sessions are live, at this project's cap of 4 (`pup conductor start --max-sessions` " +
          'sets it); nothing was launched.',
      );
      expect(launchSession).not.toHaveBeenCalled();
      expect(getSession(db, 't-1')).toBeUndefined();
      expect(listBacklogTasks(db, projectId(repo)).map((t) => t.id)).toContain('t-1');
    },
  );

  it('lets the operator past the cap with --over-cap', () => {
    seedSessions(4);

    expect(launch('operator', true)).toBe('t-1');
  });

  it('never lets the conductor past the cap, --over-cap or not', () => {
    seedSessions(4);

    expect(() => launch('conductor', true)).toThrow(SessionCapReachedError);
    expect(() =>
      launchTask(db, {
        repoPath: repo,
        base: DEFAULT_BASE_PROFILE,
        taskId: 't-1',
        claudeUserDir: join(repo, '.claude'),
        overlapVia: 'conductor',
        overCap: true,
      }),
    ).toThrow(SessionCapReachedError);
  });

  it('counts live sessions only, not killed ones', () => {
    seedSessions(3);
    seedSessions(2, 'killed');

    expect(launch('operator')).toBe('t-1');
  });

  it('refuses `pup new` at the cap before writing its task', () => {
    seedSessions(4);

    expect(() =>
      createSession(db, {
        repoPath: repo,
        base: DEFAULT_BASE_PROFILE,
        task: spec(),
        claudeUserDir: join(repo, '.claude'),
      }),
    ).toThrow(SessionCapReachedError);
    expect(getTask(db, 't-1')).toBeUndefined();
  });

  it('refuses under 1.5 GB of available memory, naming the figure, --over-cap or not', () => {
    vi.mocked(availableMemoryBytes).mockReturnValueOnce(1.2 * 1024 ** 3);

    expect(() => launch('operator', true)).toThrow(
      'Only 1.2 GB of memory is available, under the 1.5 GB a launch needs; nothing was launched.',
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it('launches with 1.5 GB available', () => {
    vi.mocked(availableMemoryBytes).mockReturnValueOnce(1.5 * 1024 ** 3);

    expect(launch('operator')).toBe('t-1');
  });

  it('launches when the adapter fails to load, its test guard refusing the runners alone', () => {
    commitIn(repo, '.pupitre/adapter.yml', 'test: [unclosed\n');

    expect(launch('operator')).toBe('t-1');
    const patterns = readFileSync(
      join(projectPaths(repo).compiledDir('t-1'), 'hooks', 'test-runner.pat'),
      'utf8',
    );
    expect(patterns).toContain('vitest');
    expect(patterns).not.toContain('unclosed');
  });

  describe("a fix round's relaunch", () => {
    /** `t-1`'s session, merged, as a fix round finds it. */
    function mergedSession(): SessionRow {
      launch('operator');
      transitionSession(db, 't-1', 'awaiting-review');
      transitionSession(db, 't-1', 'merged');
      return getSession(db, 't-1') as SessionRow;
    }

    const recompile = (session: SessionRow) =>
      recompileSessionProfile(
        db,
        { repoPath: repo, base: DEFAULT_BASE_PROFILE, claudeUserDir: join(repo, '.claude') },
        session,
        projectPaths(repo),
      );

    it('goes ahead below the cap, its own merged session not counted', () => {
      const session = mergedSession();
      seedSessions(3);

      expect(recompile(session).compiled.hash).toBeTruthy();
    });

    it('is refused at the cap', () => {
      const session = mergedSession();
      seedSessions(4);

      expect(() => recompile(session)).toThrow(SessionCapReachedError);
    });

    it('is refused under 1.5 GB of available memory', () => {
      const session = mergedSession();
      vi.mocked(availableMemoryBytes).mockReturnValueOnce(1.2 * 1024 ** 3);

      expect(() => recompile(session)).toThrow(LowMemoryError);
    });
  });
});
