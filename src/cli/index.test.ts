import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CommanderError } from 'commander';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Side-effecting boundaries only (tmux/git spawns, `claude -p` sessions, and the
// multi-stage merge-gate orchestration) — everything else (sqlite repositories,
// profile-store file reads) is exercised for real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  SessionPaneMissingError: class SessionPaneMissingError extends Error {
    readonly sessionId: string;
    constructor(sessionId: string, paneId: string) {
      super(`Session ${sessionId}'s pane ${paneId} no longer exists; nothing was sent.`);
      this.sessionId = sessionId;
    }
  },
  SteerNotDeliveredError: class SteerNotDeliveredError extends Error {
    readonly sessionId: string;
    constructor(sessionId: string, chars: number) {
      super(`Steer to session ${sessionId} did not land: ${chars} chars`);
      this.sessionId = sessionId;
    }
  },
  conductorName: (repoProjectId: string) => `pup-conductor-${repoProjectId}`,
  // Spelled like the window name, as the runtime spells it: a separate tmux
  // server is what keeps a session from reaching the conductor (decision 47).
  conductorSocket: (repoProjectId: string) => `pup-conductor-${repoProjectId}`,
  // The turn watchdog's reads: a conductor window to find, a pane to read for
  // a dead turn, a nudge to type (addendum to decision 35).
  conductorPane: vi.fn(),
  deadTurnError: vi.fn(),
  killWatcher: vi.fn(),
  launchWatcher: vi.fn(),
  steerPane: vi.fn(),
  // Not a boundary but a path rule, and the real one: the dashboard checks a
  // stored `transcript_path` against `transcriptDir(worktree)` before reading
  // it (decision 67), so a fake rule here would only agree with itself.
  transcriptDir: (await importOriginal<typeof import('../claude/session-runtime.service.js')>())
    .transcriptDir,
}));
// `render` takes over the terminal and never returns until the operator quits,
// which is the one boundary `pup ui` has; the dashboard it would draw is tested
// against its own fixtures in src/cli/ui.
vi.mock('ink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ink')>()),
  render: vi.fn(),
}));
vi.mock('../core/conductor.service.js', () => ({
  isConductorRunning: vi.fn(() => false),
  startConductor: vi.fn(),
  stopConductor: vi.fn(),
}));
vi.mock('../core/git-diff.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/git-diff.client.js')>()),
  // The review queue diffs each seeded branch against main. The seeded
  // sessions' branches are store rows, not refs, in a repo with no commits, so
  // the real diff would refuse them: the queue sees no changed paths instead.
  gitDiffPaths: vi.fn(() => []),
  gitDiffNumstat: vi.fn(() => []),
}));
vi.mock('../core/merge-gate.service.js', () => ({
  runMergeGate: vi.fn(),
  // The review queue scores each branch with it. The seeded sessions' branches
  // are rows in a store and not real branches, so there is nothing to count.
  countChangedLines: vi.fn(() => ({ lines: 0, forged: [] })),
}));
vi.mock('../core/session-lifecycle.service.js', () => ({
  createSession: vi.fn(),
  interruptSession: vi.fn(),
  killSession: vi.fn(),
  launchTask: vi.fn(),
  markSessionDone: vi.fn(),
  planTask: vi.fn(),
  sessionPane: vi.fn(),
  steerSession: vi.fn(),
}));
vi.mock('../core/session-handoff.service.js', () => ({
  HANDOFF_WAIT_DEFAULT_MS: 10 * 60 * 1000,
  RESPAWN_SUGGEST_TOKENS: 120_000,
  awaitHandoffReady: vi.fn(),
  HandoffMissingError: class HandoffMissingError extends Error {
    constructor(sessionId: string, handoffPath: string) {
      super(`No handoff at ${handoffPath} for ${sessionId}.`);
    }
  },
  hardRespawnSession: vi.fn(),
  isHandoffReady: vi.fn(),
  markHandoffReady: vi.fn(),
  requestHandoff: vi.fn(),
  respawnSession: vi.fn(),
}));

import { render } from 'ink';
import {
  deadTurnError,
  launchWatcher,
  SessionPaneMissingError,
  SteerNotDeliveredError,
} from '../claude/session-runtime.service.js';
import { isConductorRunning, startConductor, stopConductor } from '../core/conductor.service.js';
import type { SessionState } from '../core/db.client.js';
import { DEFAULT_BASE_PROFILE } from '../core/default-profile.constants.js';
import { insertLedgerEntry } from '../core/ledger.repository.js';
import { MERGE_LOCK_DIRNAME } from '../core/merge-gate.constants.js';
import { runMergeGate } from '../core/merge-gate.service.js';
import { recordWatcherBeat } from '../core/overlap.repository.js';
import { WATCH_STALE_AFTER_MS } from '../core/overlap.service.js';
import { projectId, projectPaths } from '../core/paths.utils.js';
import { InvalidProfileError } from '../core/profile.errors.js';
import {
  appendEvent,
  ensureProject,
  getSession,
  getTask,
  incrementRejectCount,
  insertSession,
  insertTask,
  listBacklogTasks,
  listEvents,
  saveProjectDormantAt,
  transitionSession,
} from '../core/session.repository.js';
import { STALLED_AFTER_MS } from '../core/session-activity.constants.js';
import {
  awaitHandoffReady,
  HandoffMissingError,
  hardRespawnSession,
  isHandoffReady,
  markHandoffReady,
  requestHandoff,
  respawnSession,
} from '../core/session-handoff.service.js';
import { ScopeConflictError, UnknownTaskError } from '../core/session-lifecycle.errors.js';
import {
  createSession,
  interruptSession,
  killSession,
  launchTask,
  markSessionDone,
  planTask,
  sessionPane,
  steerSession,
} from '../core/session-lifecycle.service.js';
import { RESUME_MESSAGE } from '../core/turn-watchdog.service.js';
import type { MergeOutcome } from '../core/types/merge-gate.types.js';
import { buildProgram, fatalExitCode } from './index.js';
import { ProjectResolutionError, resolveProject } from './project.utils.js';
import type { DashboardReading, ProjectReading } from './ui/use-snapshot.hook.js';

const HANDOFF_WAIT_DEFAULT_MS = 10 * 60 * 1000;

// Test repos must not inherit the developer's global git config (hooks, signing)
// nor GIT_DIR & co. — when this suite runs inside a git hook (pre-commit), those
// would redirect every git call at the pupitre repo instead of the temp repo.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A repo with no adapter markers (no package.json, pyproject.toml, ...). */
function initRepo(): string {
  const repo = tempDir('pup-cli-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
  return repo;
}

/** The args of a mock's first call — throws instead of a `!` when it was never called. */
function firstCall<Args extends unknown[]>(mockFn: (...args: Args) => unknown): Args {
  const call = vi.mocked(mockFn).mock.calls[0];
  if (!call) throw new Error('expected the mock to have been called');
  return call;
}

/** A repo the TypeScript adapter detects, for commands that require one. */
function initRepoWithAdapter(): string {
  const repo = initRepo();
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(join(repo, 'tsconfig.json'), '{}');
  return repo;
}

/**
 * A `codegraph` on PATH printing `version`, or a PATH with none at all. The
 * capability line reports the operator's machine, so every test that reads it
 * says which machine it is pretending to be (decision 51).
 */
function stubCodegraph(version?: string): void {
  const dir = tempDir('pup-cli-cg-');
  if (version !== undefined) {
    writeFileSync(join(dir, 'codegraph'), `#!/bin/sh\necho "${version}"\nexit 0\n`, {
      mode: 0o755,
    });
  }
  // `git` stays reachable: `pup init` resolves its project through it.
  vi.stubEnv('PATH', `${dir}:/usr/bin:/bin`);
}

/** Inserts the project/task/session rows a real (unmocked) `getSession` needs. */
function seedSession(repoPath: string, sessionId: string, worktreePath?: string): void {
  const { db } = resolveProject(repoPath);
  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);
  insertTask(db, { id: `t-${sessionId}`, projectId: pid, spec: '{}' });
  insertSession(db, {
    id: sessionId,
    taskId: `t-${sessionId}`,
    worktreePath: worktreePath ?? join(repoPath, '.worktrees', sessionId),
    branch: `pup/${sessionId}`,
    profileHash: 'hash',
  });
  db.close();
}

/** The seeded session's worktree, created so `git -C` inside it resolves the repo. */
function worktreeOf(repoPath: string, sessionId: string): string {
  const path = join(repoPath, '.worktrees', sessionId);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Registers the repo in the store the way `pup init` does, with nothing planned. */
function registerProject(repoPath: string): string {
  const { db } = resolveProject(repoPath);
  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);
  db.close();
  return pid;
}

/** Puts a registered project to sleep, as `pup project dormant` leaves it. */
function markDormant(repoPath: string, at = '2026-09-21T10:00:00.000Z'): void {
  const { db } = resolveProject(repoPath);
  saveProjectDormantAt(db, projectId(repoPath), at);
  db.close();
}

/** One planned task: a row in the backlog with no session of its own. */
function seedBacklogTask(repoPath: string, taskId: string, goal: string): void {
  const { db } = resolveProject(repoPath);
  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);
  insertTask(db, {
    id: taskId,
    projectId: pid,
    spec: JSON.stringify({ id: taskId, goal, scopeIn: ['src/**'] }),
  });
  db.close();
}

/** A session whose tmux pane is gone for good — steer/interrupt must refuse it. */
function seedKilledSession(repoPath: string, sessionId: string): void {
  seedSession(repoPath, sessionId);
  const { db } = resolveProject(repoPath);
  transitionSession(db, sessionId, 'killed');
  db.close();
}

/** A session the gate parked, with the reason and the rejections it recorded. */
function seedBlockedSession(
  repoPath: string,
  sessionId: string,
  reason: string,
  rejectCount = 3,
): void {
  seedSession(repoPath, sessionId);
  const { db } = resolveProject(repoPath);
  transitionSession(db, sessionId, 'running');
  for (let i = 0; i < rejectCount; i += 1) incrementRejectCount(db, sessionId);
  transitionSession(db, sessionId, 'blocked', { reason, rejectCount });
  db.close();
}

/** Writes a running session's events file with its mtime `ageMs` in the past. */
function seedEventsFile(repoPath: string, sessionId: string, ageMs: number): void {
  const paths = projectPaths(repoPath);
  mkdirSync(paths.sessionDir(sessionId), { recursive: true });
  const eventsFile = paths.eventsFile(sessionId);
  writeFileSync(eventsFile, `${JSON.stringify({ hook_event_name: 'PostToolUse' })}\n`);
  const time = new Date(Date.now() - ageMs);
  utimesSync(eventsFile, time, time);
}

/**
 * A session's events file with its permissions taken away, which is what makes
 * a whole snapshot throw: the reader stats it, finds it, and cannot read it.
 * Returns the path, for the caller to give its mode back.
 */
function unreadableEventsFile(repoPath: string, sessionId: string, mode = 0o000): string {
  const eventsFile = projectPaths(repoPath).eventsFile(sessionId);
  mkdirSync(projectPaths(repoPath).sessionDir(sessionId), { recursive: true });
  writeFileSync(eventsFile, `${JSON.stringify({ hook_event_name: 'PostToolUse' })}\n`);
  chmodSync(eventsFile, mode);
  return eventsFile;
}

/**
 * A stalled running session with a pane, as the watchdog finds it: the events
 * file is older than the stall window and the pane was recorded at launch.
 */
function seedStalledSession(repoPath: string, sessionId: string): void {
  seedSession(repoPath, sessionId);
  const { db } = resolveProject(repoPath);
  db.prepare('UPDATE sessions SET tmux_target = ? WHERE id = ?').run('%7', sessionId);
  transitionSession(db, sessionId, 'running');
  db.close();
  seedEventsFile(repoPath, sessionId, STALLED_AFTER_MS + 60_000);
}

/** The watcher's record of a dead turn for the stall the session is in now. */
function seedDeadTurn(repoPath: string, sessionId: string, refusal?: string): void {
  const stalledAt = new Date(
    statSync(projectPaths(repoPath).eventsFile(sessionId)).mtimeMs,
  ).toISOString();
  const { db } = resolveProject(repoPath);
  appendEvent(db, sessionId, 'turn_died', {
    reason: '⏺ API Error: Connection lost while your computer was asleep',
    stalledAt,
    ...(refusal ? { refusal } : {}),
  });
  db.close();
}

/** The radar's last beat, as a sweep records it (real, unmocked repository). */
function seedWatcherBeat(repoPath: string, ageMs: number): void {
  const { db } = resolveProject(repoPath);
  ensureProject(db, projectId(repoPath), repoPath);
  recordWatcherBeat(db, projectId(repoPath), new Date(Date.now() - ageMs));
  db.close();
}

/** Inserts one open ledger entry (real, unmocked repository) and returns its id. */
function seedLedgerEntry(repoPath: string): number {
  const { db } = resolveProject(repoPath);
  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);
  const id = insertLedgerEntry(db, {
    projectId: pid,
    description: 'shortcut taken',
    files: ['src/a.ts'],
    reason: 'ship the demo',
    acceptedBy: 'human',
    reviewBy: 'before the next release',
  });
  db.close();
  return id;
}

describe('CLI commands', () => {
  const originalExitCode = process.exitCode;
  let logs: string[];
  let errors: string[];
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let savedGitEnv: Record<string, string | undefined>;
  let home: string;

  beforeEach(() => {
    vi.resetAllMocks();
    process.exitCode = undefined;
    logs = [];
    errors = [];
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = (message: string) => logs.push(message);
    console.error = (message: string) => errors.push(message);
    // resolveProject() always resolves state under homedir() — point it at a
    // throwaway HOME so a test run never touches the developer's real ~/.pupitre.
    home = tempDir('pup-cli-home-');
    vi.stubEnv('HOME', home);
    // Reaching another project refuses on PUP_SESSION_ID or PUP_CONDUCTOR
    // alone, and this suite runs inside a pup session during dogfooding —
    // under the conductor, inside its tmux, both variables are exported.
    // Operator cases must not inherit either; the cases that want one stub it.
    vi.stubEnv('PUP_SESSION_ID', '');
    vi.stubEnv('PUP_CONDUCTOR', '');
    // repoRoot() shells out to `git -C <cwd> rev-parse ...` with no env
    // override, so it inherits process.env as-is. Running inside the repo's
    // own pre-commit hook leaves GIT_DIR (and friends) set, which silently
    // redirects that call at the pupitre repo instead of the temp fixture
    // below — strip them for the duration of the test, same hazard the
    // GIT_ENV convention guards against for git calls this suite makes itself.
    savedGitEnv = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_')) {
        savedGitEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    for (const [key, value] of Object.entries(savedGitEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // process.chdir would be process-global and race with the other test
    // files vitest runs concurrently, so cwd is stubbed at the JS level
    // instead (resolveProject/repoRoot default their cwd param to
    // process.cwd(), read fresh on every call).
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    process.exitCode = originalExitCode;
  });

  function useCwd(dir: string): void {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  }

  describe('status', () => {
    it('reports an empty project when nothing runs and nothing is planned', () => {
      useCwd(initRepo());

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs).toContain('Nothing running and nothing planned.');
      expect(process.exitCode).toBeUndefined();
    });

    // `pup status` is where the operator looks to decide what to do next, and
    // planned work is an answer to that question (decision 41).
    it('names the conductor first when its window is up', () => {
      useCwd(initRepo());
      vi.mocked(isConductorRunning).mockReturnValue(true);

      buildProgram().parse(['status'], { from: 'user' });

      // With the attach command, socket included: the window is on the
      // conductor's own server, so a plain `tmux attach -t` finds nothing
      // (decision 47).
      expect(logs[0]).toMatch(
        /^conductor running \(attach: tmux -L pup-conductor-([0-9a-f]{12}) attach -t pup-conductor-\1\)$/,
      );
    });

    // The operator is the only caller that attaches. A session and the
    // conductor are told the window is up and nothing else: pup is not the
    // thing that hands a session the socket the conductor lives on.
    it.each([
      ['a session', 'PUP_SESSION_ID', 's1'],
      ['the conductor', 'PUP_CONDUCTOR', 'p1'],
    ])(
      'tells %s the conductor runs, without the socket to reach it on',
      (_who, variable, value) => {
        const repo = initRepo();
        useCwd(repo);
        seedSession(repo, 's1');
        vi.stubEnv(variable, value);
        vi.mocked(isConductorRunning).mockReturnValue(true);

        buildProgram().parse(['status'], { from: 'user' });

        expect(logs[0]).toBe('conductor running');
        expect(logs.join('\n')).not.toContain('tmux -L');
      },
    );

    it('lists a planned task under `planned`, with its goal', () => {
      const repo = initRepo();
      useCwd(repo);
      seedBacklogTask(repo, 't-plan', 'extract the gh exec options');

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs.join('\n')).toMatch(/planned\s+t-plan\s+extract the gh exec options/);
    });

    // A goal is a paragraph; unclipped, it pushed the scope column off the row
    // on the first real backlog this rendered.
    it('clips a long goal to the column instead of letting it run', () => {
      const repo = initRepo();
      useCwd(repo);
      seedBacklogTask(repo, 't-long', 'x'.repeat(120));

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs.join('\n')).toMatch(/t-long\s+x{43}\u2026$/m);
    });

    it('shows planned work even when the project has never run a session', () => {
      const repo = initRepo();
      useCwd(repo);
      seedBacklogTask(repo, 't-plan', 'the only intent there is');

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs).not.toContain('Nothing running and nothing planned.');
      expect(logs.join('\n')).toContain('the only intent there is');
    });

    it('drops a task from the backlog once a session claims it', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs.join('\n')).not.toContain('planned');
    });

    // Outside any repo `pup status` reads every registered store rather than
    // refusing; the one reader decision 60 lets cross stores.
    describe('the fleet view', () => {
      /** A session walked to `state` through the transitions the gate would make. */
      function seedSessionIn(repo: string, sessionId: string, path: SessionState[]): void {
        seedSession(repo, sessionId);
        const { db } = resolveProject(repo);
        for (const state of path) transitionSession(db, sessionId, state);
        db.close();
      }

      it('prints one block per project: what needs the operator, then counts', () => {
        const repoA = initRepo();
        const repoB = initRepo();
        seedBlockedSession(repoA, 's-blocked', 'lint keeps failing');
        seedStalledSession(repoA, 's-stalled');
        seedDeadTurn(repoA, 's-stalled');
        seedStalledSession(repoA, 's-quiet');
        seedSessionIn(repoA, 's-review', ['running', 'awaiting-review']);
        seedSessionIn(repoA, 's-busy', ['running']);
        seedSessionIn(repoA, 's-done', ['running', 'awaiting-review', 'merged']);
        seedBacklogTask(repoA, 't-plan', 'planned in A');
        const debt = seedLedgerEntry(repoB);
        const { db } = resolveProject(repoB);
        db.prepare("UPDATE ledger_entries SET review_by = '2020-01-01' WHERE id = ?").run(debt);
        db.close();
        useCwd(tempDir('pup-cli-noproj-'));

        buildProgram().parse(['status'], { from: 'user' });

        const idA = projectId(repoA);
        const idB = projectId(repoB);
        const blockA = [
          `${idA}  ${repoA}  conductor stopped`,
          expect.stringMatching(
            /^ {2}blocked +s-blocked +pup\/s-blocked {2}needs a human \(3 rejections\)/,
          ),
          expect.stringMatching(/^ {2}running +s-stalled +pup\/s-stalled {2}TURN DIED/),
          expect.stringMatching(/^ {2}running +s-quiet +pup\/s-quiet {2}STALLED/),
          expect.stringMatching(/^ {2}awaiting-review +s-review +pup\/s-review$/),
          '  3 running, 1 planned, 1 merged',
        ];
        const blockB = [
          `${idB}  ${repoB}  conductor stopped`,
          `  OVERDUE DEBT #${debt}  shortcut taken  (review by: 2020-01-01)`,
          '  0 running, 0 planned, 0 merged',
        ];
        // The store lists projects in directory order, which the ids decide.
        const [first, second] = idA < idB ? [blockA, blockB] : [blockB, blockA];
        expect(logs).toEqual([...first, '', ...second]);
        expect(logs.join('\n')).not.toContain('s-busy');
        expect(logs.join('\n')).not.toContain('planned in A');
        expect(process.exitCode).toBeUndefined();
      });

      it('names a running conductor, without the attach line the full table carries', () => {
        const repo = initRepo();
        registerProject(repo);
        vi.mocked(isConductorRunning).mockReturnValue(true);
        useCwd(tempDir('pup-cli-noproj-'));

        buildProgram().parse(['status'], { from: 'user' });

        expect(logs[0]).toBe(`${projectId(repo)}  ${repo}  conductor running`);
      });

      it('is the view outside a repo even with only one project registered', () => {
        const repo = initRepo();
        seedBacklogTask(repo, 't-plan', 'the one project there is');
        useCwd(tempDir('pup-cli-noproj-'));

        buildProgram().parse(['status'], { from: 'user' });

        expect(logs).toEqual([
          `${projectId(repo)}  ${repo}  conductor stopped`,
          '  0 running, 1 planned, 0 merged',
        ]);
      });

      it('is what --all prints from inside a repo, which alone prints its own table', () => {
        const repoA = initRepo();
        const repoB = initRepo();
        seedBacklogTask(repoA, 't-a', 'planned in A');
        registerProject(repoB);
        useCwd(repoA);

        buildProgram().parse(['status', '--all'], { from: 'user' });
        const fleet = [...logs];
        logs.length = 0;
        useCwd(tempDir('pup-cli-noproj-'));
        buildProgram().parse(['status'], { from: 'user' });

        expect(fleet).toEqual(logs);
        expect(fleet).toContain(`${projectId(repoB)}  ${repoB}  conductor stopped`);
        logs.length = 0;
        useCwd(repoA);
        buildProgram().parse(['status'], { from: 'user' });
        expect(logs).toEqual([expect.stringMatching(/^planned +t-a +planned in A/)]);
      });

      it('leaves --project to print that one project in full', () => {
        const repo = initRepo();
        const id = registerProject(repo);
        seedBacklogTask(repo, 't-a', 'planned here');
        useCwd(tempDir('pup-cli-noproj-'));

        buildProgram().parse(['--project', id, 'status', '--all'], { from: 'user' });

        expect(logs).toEqual([expect.stringMatching(/^planned +t-a +planned here/)]);
      });

      it('marks a project whose repo is gone missing, and never opens its store', () => {
        const live = initRepo();
        registerProject(live);
        // A bare store holding only its `projects` row: opening it through
        // openStore would lay the schema down, so the absence of `sessions`
        // afterwards is the proof it stayed shut.
        const gone = tempDir('pup-cli-gone-');
        const goneId = projectId(gone);
        const goneStore = join(home, '.pupitre', goneId, 'state.db');
        mkdirSync(join(home, '.pupitre', goneId), { recursive: true });
        const bare = new Database(goneStore);
        bare.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, repo_path TEXT NOT NULL)');
        bare.prepare('INSERT INTO projects VALUES (?, ?)').run(goneId, gone);
        bare.close();
        rmSync(gone, { recursive: true });
        useCwd(tempDir('pup-cli-noproj-'));

        buildProgram().parse(['status'], { from: 'user' });

        expect(logs).toContain(`${goneId}  ${gone}  missing: the repo no longer exists`);
        expect(logs).toContain(`${projectId(live)}  ${live}  conductor stopped`);
        const check = new Database(goneStore, { readonly: true });
        const tables = check
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[];
        check.close();
        expect(tables.map((table) => table.name)).toEqual(['projects']);
      });

      // Decision 62: a dormant project is counted, not shown, until --dormant.
      it('hides a dormant project and counts it, and shows it with --dormant', () => {
        const awake = initRepo();
        const asleep = initRepo();
        registerProject(awake);
        seedBacklogTask(asleep, 't-sleep', 'planned while asleep');
        markDormant(asleep);
        useCwd(tempDir('pup-cli-noproj-'));

        buildProgram().parse(['status'], { from: 'user' });
        expect(logs).toEqual([
          `${projectId(awake)}  ${awake}  conductor stopped`,
          '  0 running, 0 planned, 0 merged',
          '',
          '1 dormant project not shown; --dormant shows it.',
        ]);

        logs.length = 0;
        buildProgram().parse(['status', '--dormant'], { from: 'user' });
        expect(logs).toContain(
          `${projectId(asleep)}  ${asleep}  conductor stopped  dormant since 2026-09-21T10:00:00.000Z`,
        );
        expect(logs).toContain('  0 running, 1 planned, 0 merged');
        expect(logs.join('\n')).not.toContain('not shown');
      });

      it('prints only the count when every project is dormant', () => {
        const repoA = initRepo();
        const repoB = initRepo();
        registerProject(repoA);
        registerProject(repoB);
        markDormant(repoA);
        markDormant(repoB);
        useCwd(tempDir('pup-cli-noproj-'));

        buildProgram().parse(['status'], { from: 'user' });

        expect(logs).toEqual(['2 dormant projects not shown; --dormant shows them.']);
      });

      it('refuses in one line when nothing is registered', () => {
        useCwd(tempDir('pup-cli-noproj-'));

        expect(() => buildProgram().parse(['status'], { from: 'user' })).toThrow(
          new ProjectResolutionError(
            'No project registered; run pup init from the repo you want to control.',
          ),
        );
      });

      // Reading every store is another project's door like `--project`: a
      // session's guards cannot find it in any store but its own (decision 43).
      it('refuses a session asking from its worktree', () => {
        const own = initRepo();
        const worktree = join(own, '.worktrees', 's1');
        mkdirSync(worktree, { recursive: true });
        seedSession(own, 's1', worktree);
        useCwd(worktree);

        expect(() => buildProgram().parse(['status', '--all'], { from: 'user' })).toThrow(
          'operator-only',
        );
      });

      it('refuses a session that left every repo but still exports PUP_SESSION_ID', () => {
        registerProject(initRepo());
        useCwd(tempDir('pup-cli-noproj-'));
        vi.stubEnv('PUP_SESSION_ID', 's-elsewhere');

        expect(() => buildProgram().parse(['status'], { from: 'user' })).toThrow('operator-only');
      });

      it('refuses the conductor, even from inside a repo with --all', () => {
        const repo = initRepo();
        registerProject(repo);
        useCwd(repo);
        vi.stubEnv('PUP_CONDUCTOR', 'p1');

        expect(() => buildProgram().parse(['status', '--all'], { from: 'user' })).toThrow(
          'operator-only',
        );
      });

      // A store under ~/.pupitre is session-writable and the fleet opens every
      // one of them, so what a row says is sanitized before the terminal sees
      // it (decision 29).
      it('strips control characters out of a session row it prints', () => {
        const repo = initRepo();
        seedBlockedSession(repo, 's-blocked', 'lint keeps failing');
        const { db } = resolveProject(repo);
        db.prepare('UPDATE sessions SET branch = ? WHERE id = ?').run(
          'pup/\u001b[2Jhijack',
          's-blocked',
        );
        db.close();
        useCwd(tempDir('pup-cli-noproj-'));

        buildProgram().parse(['status'], { from: 'user' });

        const row = logs.find((line) => line.includes('s-blocked')) ?? '';
        expect(row).toContain('pup/ [2Jhijack');
        expect(row).not.toContain('\u001b');
      });

      it('prints the next project when one store cannot be read', () => {
        const broken = initRepo();
        const fine = initRepo();
        seedSession(broken, 's1');
        // An events file the snapshot cannot read: it throws on it, as it
        // would on a store that fails to migrate. Not a transcript — an
        // unreadable one is a context reading that degrades to unknown
        // (decision 67), and this case needs a snapshot that fails whole.
        const unreadable = unreadableEventsFile(broken, 's1');
        const { db } = resolveProject(broken);
        transitionSession(db, 's1', 'running');
        db.close();
        seedBacklogTask(fine, 't-plan', 'still here');
        useCwd(tempDir('pup-cli-noproj-'));

        try {
          buildProgram().parse(['status'], { from: 'user' });
        } finally {
          chmodSync(unreadable, 0o600);
        }

        expect(logs).toContainEqual(
          expect.stringMatching(
            new RegExp(`^${projectId(broken)}  ${broken}  unreadable: .*EACCES`),
          ),
        );
        expect(logs).toContain(`${projectId(fine)}  ${fine}  conductor stopped`);
        expect(logs).toContain('  0 running, 1 planned, 0 merged');
        expect(process.exitCode).toBeUndefined();
      });

      // Every other command keeps decision 43's refusal outside a repo.
      it('leaves every other command refusing when several projects could apply', () => {
        const repoA = initRepo();
        const repoB = initRepo();
        const idA = registerProject(repoA);
        const idB = registerProject(repoB);
        useCwd(tempDir('pup-cli-noproj-'));

        expect(() => buildProgram().parse(['plan', 'list'], { from: 'user' })).toThrow(
          new ProjectResolutionError(
            [
              ...[`${idA}  ${repoA}  active`, `${idB}  ${repoB}  active`].sort(),
              'Not inside a git repository; pass --project <id> to pick one of these.',
            ].join('\n'),
          ),
        );
      });
    });

    it('ignores the store while inside a repo', () => {
      const registered = initRepo();
      seedBacklogTask(registered, 't-plan', 'planned elsewhere');
      useCwd(initRepo());

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs).toContain('Nothing running and nothing planned.');
    });

    it('marks a running session STALLED with its age and sorts it before a fresh one', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's-fresh');
      seedSession(repo, 's-stalled');
      const { db } = resolveProject(repo);
      transitionSession(db, 's-fresh', 'running');
      transitionSession(db, 's-stalled', 'running');
      db.close();
      seedEventsFile(repo, 's-fresh', 0);
      seedEventsFile(repo, 's-stalled', STALLED_AFTER_MS + 60_000);

      buildProgram().parse(['status'], { from: 'user' });

      const stalledLine = logs.find((line) => line.includes('s-stalled'));
      const freshLine = logs.find((line) => line.includes('s-fresh'));
      expect(stalledLine).toMatch(/STALLED \(\d+m\)/);
      expect(freshLine).not.toContain('STALLED');
      expect(logs.indexOf(stalledLine as string)).toBeLessThan(logs.indexOf(freshLine as string));
    });

    it('does not flag a running session with a fresh events file', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's-fresh');
      const { db } = resolveProject(repo);
      transitionSession(db, 's-fresh', 'running');
      db.close();
      seedEventsFile(repo, 's-fresh', 0);

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs.some((line) => line.includes('STALLED'))).toBe(false);
    });

    // The watcher's record replaces the bare age: what the operator needs to
    // know about that row is that recovery already happened, or that it did
    // not (addendum to decision 35).
    it('prints the dead turn the watcher resumed in place of the STALLED age', () => {
      const repo = initRepo();
      useCwd(repo);
      seedStalledSession(repo, 's-dead');
      seedDeadTurn(repo, 's-dead');

      buildProgram().parse(['status'], { from: 'user' });

      const line = logs.find((entry) => entry.includes('s-dead'));
      expect(line).toMatch(/TURN DIED \(API error\) — resumed by watch at \d{2}:\d{2}/);
      expect(line).not.toContain('STALLED');
    });

    it('says the resume was refused and needs a human', () => {
      const repo = initRepo();
      useCwd(repo);
      seedStalledSession(repo, 's-dead');
      seedDeadTurn(repo, 's-dead', 'did not land');

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs.find((entry) => entry.includes('s-dead'))).toMatch(
        /TURN DIED \(API error\) — resume refused at \d{2}:\d{2}, needs a human/,
      );
    });

    // A record from an earlier stall is history: the session worked since,
    // and whatever it is stalled on now is a plain STALLED age again.
    it('keeps the STALLED age when the recorded dead turn is from an earlier stall', () => {
      const repo = initRepo();
      useCwd(repo);
      seedStalledSession(repo, 's-dead');
      seedDeadTurn(repo, 's-dead');
      seedEventsFile(repo, 's-dead', STALLED_AFTER_MS + 30_000);

      buildProgram().parse(['status'], { from: 'user' });

      const line = logs.find((entry) => entry.includes('s-dead'));
      expect(line).toMatch(/STALLED \(\d+m\)/);
      expect(line).not.toContain('TURN DIED');
    });
  });

  describe('ui', () => {
    /** What Ink's `render` hands back, reduced to the two bits `pup ui` uses. */
    function stubRender(): { unmount: ReturnType<typeof vi.fn> } {
      const unmount = vi.fn();
      vi.mocked(render).mockReturnValue({
        unmount,
        waitUntilExit: () => Promise.resolve(),
      } as unknown as ReturnType<typeof render>);
      return { unmount };
    }

    /** `pup ui` with stdout claiming to be, or not to be, a terminal. */
    function runUi(isTty: boolean, args: string[] = ['ui']): void {
      const wasTty = process.stdout.isTTY;
      process.stdout.isTTY = isTty;
      try {
        buildProgram().parse(args, { from: 'user' });
      } finally {
        process.stdout.isTTY = wasTty;
      }
    }

    /** The props `pup ui` mounted the dashboard with. */
    function mountedProps(): {
      read: () => DashboardReading;
      showAttach: boolean;
      readOnlyReason?: string;
    } {
      const [element] = firstCall(render);
      return (
        element as ReactElement<{
          read: () => DashboardReading;
          showAttach: boolean;
          readOnlyReason?: string;
        }>
      ).props;
    }

    /** The one project a single-project dashboard reads. */
    function onlyProject(): ProjectReading {
      const { projects } = mountedProps().read();
      expect(projects).toHaveLength(1);
      return projects[0] as ProjectReading;
    }

    it('mounts the dashboard on the alternate screen, reading the live store', () => {
      const repo = initRepo();
      useCwd(repo);
      seedBacklogTask(repo, 't-plan', 'the only intent there is');
      stubRender();

      runUi(true);

      const [, options] = firstCall(render);
      expect(options).toMatchObject({ alternateScreen: true });
      // The dashboard is handed the reading function, not a reading: every
      // frame it draws is a fresh `buildDashboardSnapshot` (decision 52).
      expect(onlyProject().snapshot.backlog).toEqual([
        {
          id: 't-plan',
          goal: 'the only intent there is',
          scope: ['src/**'],
          acceptance: [],
          origin: 'human',
        },
      ]);
      expect(process.exitCode).toBeUndefined();
    });

    // Decision 47: the operator attaches, and is the only caller that may be
    // shown the socket the conductor's window is on.
    it.each([
      ['the operator', '', true],
      ['a session', 's1', false],
    ])('tells %s whether it may see the attach command', (_who, declared, showAttach) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', declared);
      stubRender();

      runUi(true);

      expect(mountedProps().showAttach).toBe(showAttach);
    });

    // Every key writes through the open store and the repo the command
    // resolved, and the merge re-enters this same bin as a child (decision 52's
    // addendum) — a dashboard handed another project's store would drive a
    // fleet the operator is not looking at.
    it('hands the controls the store, the repo and the bin to re-enter', () => {
      const repo = initRepo();
      useCwd(repo);
      stubRender();

      runUi(true);

      expect(onlyProject().deps.repoPath).toBe(repo);
      expect(onlyProject().deps.pupBin).toBe(realpathSync(process.argv[1] ?? 'pup'));
    });

    // Every key the dashboard binds runs a command that is operator-only
    // somewhere, so the whole set goes rather than refusing one keystroke at a
    // time (decisions 42, 44, 47).
    it.each([
      ['the operator', {}, undefined],
      ['a session', { PUP_SESSION_ID: 's1' }, 'sessions do not drive sessions'],
      ['the conductor', { PUP_CONDUCTOR: 'pid' }, 'the conductor drives sessions'],
    ])('gives %s a dashboard it may drive, or says why not', (_who, env, reason) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      stubRender();

      runUi(true);

      if (reason === undefined) expect(mountedProps().readOnlyReason).toBeUndefined();
      else expect(mountedProps().readOnlyReason).toContain(reason);
    });

    // Ink restores the primary screen when it unmounts, so a signal that would
    // otherwise end the process has to reach unmount first — else the operator
    // is left on the alternate buffer with their scrollback hidden.
    it('unmounts on SIGINT, so the terminal comes back', () => {
      const repo = initRepo();
      useCwd(repo);
      const { unmount } = stubRender();
      const before = process.listeners('SIGINT');

      runUi(true);

      const [added] = process.listeners('SIGINT').filter((fn) => !before.includes(fn));
      expect(added).toBeDefined();
      added?.('SIGINT');
      expect(unmount).toHaveBeenCalledTimes(1);
    });

    it('prints the snapshot once and exits 0 when stdout is not a terminal', () => {
      const repo = initRepo();
      useCwd(repo);
      seedBacklogTask(repo, 't-plan', 'the only intent there is');

      runUi(false);

      expect(render).not.toHaveBeenCalled();
      expect(logs.join('\n')).toMatch(/planned\s+t-plan\s+the only intent there is/);
      expect(process.exitCode).toBeUndefined();
    });

    it('says the project is empty when piped, exactly as `pup status` does', () => {
      useCwd(initRepo());

      runUi(false);

      expect(logs).toContain('Nothing running and nothing planned.');
    });

    // Decision 61: outside a repo, or with --all, every project's store in one
    // table, each row's keys writing through its own project.
    describe('across projects', () => {
      /** The projects a fleet reading holds, keyed by project id. */
      function readProjects(): Map<string, ProjectReading> {
        const { projects } = mountedProps().read();
        return new Map(projects.map((project) => [project.snapshot.projectId, project]));
      }

      it('reads every project outside a repo, each with its own store and repo', () => {
        const repoA = initRepo();
        const repoB = initRepo();
        seedSession(repoA, 's-a');
        seedSession(repoB, 's-b');
        useCwd(tempDir('pup-cli-noproj-'));
        stubRender();

        runUi(true);

        const projects = readProjects();
        const a = projects.get(projectId(repoA));
        const b = projects.get(projectId(repoB));
        expect(projects.size).toBe(2);
        expect(a?.deps.repoPath).toBe(repoA);
        expect(b?.deps.repoPath).toBe(repoB);
        // The deps are that project's own open store, not a second project's.
        expect(b && getSession(b.deps.db, 's-b')).toBeDefined();
        expect(b && getSession(b.deps.db, 's-a')).toBeUndefined();
        expect(a?.snapshot.sessions.map((session) => session.id)).toEqual(['s-a']);
        expect(b?.deps.pupBin).toBe(realpathSync(process.argv[1] ?? 'pup'));
        expect(mountedProps()).toMatchObject({ showAttach: true });
        expect(mountedProps().readOnlyReason).toBeUndefined();
        expect(mountedProps().read().unreadable).toEqual([]);
      });

      it('reads the fleet from inside a repo with --all, and only that repo without it', () => {
        const repoA = initRepo();
        registerProject(repoA);
        registerProject(initRepo());
        useCwd(repoA);
        stubRender();

        runUi(true, ['ui', '--all']);
        expect(mountedProps().read().projects).toHaveLength(2);

        vi.mocked(render).mockClear();
        runUi(true);
        expect(
          mountedProps()
            .read()
            .projects.map((p) => p.deps.repoPath),
        ).toEqual([repoA]);
      });

      it('leaves a dormant project out of the reading, and reads it with --dormant', () => {
        const awake = initRepo();
        const asleep = initRepo();
        registerProject(awake);
        registerProject(asleep);
        markDormant(asleep);
        useCwd(tempDir('pup-cli-noproj-'));
        stubRender();

        runUi(true);
        expect([...readProjects().keys()]).toEqual([projectId(awake)]);
        expect(mountedProps().read().unreadable).toEqual([]);

        vi.mocked(render).mockClear();
        runUi(true, ['ui', '--dormant']);
        expect([...readProjects().keys()].sort()).toEqual(
          [projectId(awake), projectId(asleep)].sort(),
        );
      });

      it('leaves --project to name one project, over --all', () => {
        const repo = initRepo();
        const id = registerProject(repo);
        registerProject(initRepo());
        useCwd(tempDir('pup-cli-noproj-'));
        stubRender();

        runUi(true, ['--project', id, 'ui', '--all']);

        expect(
          mountedProps()
            .read()
            .projects.map((p) => p.deps.repoPath),
        ).toEqual([repo]);
      });

      it('lists a project whose repo is gone and one it cannot read, and reads the rest', () => {
        const live = initRepo();
        registerProject(live);
        const gone = initRepo();
        const goneId = registerProject(gone);
        rmSync(gone, { recursive: true });
        const broken = initRepo();
        seedSession(broken, 's1');
        // An events file that cannot be read makes the snapshot throw, as a
        // store that fails to migrate would; an unreadable transcript no
        // longer does (decision 67). Left readable until the reading is
        // mounted, as this case has always done.
        const unreadable = unreadableEventsFile(broken, 's1', 0o600);
        const { db } = resolveProject(broken);
        transitionSession(db, 's1', 'running');
        db.close();
        useCwd(tempDir('pup-cli-noproj-'));
        stubRender();

        runUi(true);
        chmodSync(unreadable, 0o000);
        let reading: DashboardReading;
        try {
          reading = mountedProps().read();
        } finally {
          chmodSync(unreadable, 0o600);
        }

        expect(reading.projects.map((p) => p.deps.repoPath)).toEqual([live]);
        expect(reading.unreadable).toContain(
          `${goneId}  ${gone}  missing: the repo no longer exists`,
        );
        expect(reading.unreadable).toContainEqual(
          expect.stringMatching(
            new RegExp(`^${projectId(broken)}  ${broken}  unreadable: .*EACCES`),
          ),
        );
        // The next reading finds the events file readable again.
        expect(mountedProps().read().projects).toHaveLength(2);
      });

      it('lists a store it cannot open and reads the rest', () => {
        const live = initRepo();
        registerProject(live);
        // A store the listing can read but `openStore` refuses: its schema
        // indexes `events`, and a view there cannot be indexed.
        const odd = initRepo();
        const oddId = projectId(odd);
        mkdirSync(join(home, '.pupitre', oddId), { recursive: true });
        const bare = new Database(join(home, '.pupitre', oddId, 'state.db'));
        bare.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, repo_path TEXT NOT NULL)');
        bare.exec('CREATE VIEW events AS SELECT 1 AS session_id');
        bare.prepare('INSERT INTO projects VALUES (?, ?)').run(oddId, odd);
        bare.close();
        useCwd(tempDir('pup-cli-noproj-'));
        stubRender();

        runUi(true);

        const reading = mountedProps().read();
        expect(reading.projects.map((p) => p.deps.repoPath)).toEqual([live]);
        expect(reading.unreadable).toEqual([
          `${oddId}  ${odd}  unreadable: views may not be indexed`,
        ]);
      });

      // A store keyed to the hash of the operator's repo path plus a slash:
      // the path exists, the hash differs, and its rows are a session's own.
      // Listed, never opened, in all three fleet readers (decision 61).
      it('never opens a project whose path is a variant of a repo path', () => {
        const real = initRepo();
        registerProject(real);
        const variant = `${real}/`;
        const plantedId = projectId(variant);
        const plantedStore = join(home, '.pupitre', plantedId, 'state.db');
        mkdirSync(join(home, '.pupitre', plantedId), { recursive: true });
        const bare = new Database(plantedStore);
        bare.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, repo_path TEXT NOT NULL)');
        bare.prepare('INSERT INTO projects VALUES (?, ?)').run(plantedId, variant);
        bare.close();
        const line = `${plantedId}  ${variant}  not its own path: a variant of a repo path, never opened`;
        useCwd(tempDir('pup-cli-noproj-'));
        stubRender();

        buildProgram().parse(['status'], { from: 'user' });
        const status = [...logs];
        logs.length = 0;
        runUi(false, ['ui', '--all']);
        const piped = [...logs];
        runUi(true, ['ui', '--all']);
        const reading = mountedProps().read();

        expect(status).toContain(line);
        expect(piped).toContain(line);
        expect(status).toContain(`${projectId(real)}  ${real}  conductor stopped`);
        expect(reading.unreadable).toEqual([line]);
        expect(reading.projects.map((p) => p.deps.repoPath)).toEqual([real]);
        const check = new Database(plantedStore, { readonly: true });
        const tables = check
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[];
        check.close();
        expect(tables.map((table) => table.name)).toEqual(['projects']);
      });

      it('prints the fleet `pup status` prints when piped', () => {
        const repo = initRepo();
        seedBacklogTask(repo, 't-plan', 'planned here');
        useCwd(tempDir('pup-cli-noproj-'));

        runUi(false);

        expect(render).not.toHaveBeenCalled();
        expect(logs).toEqual([
          `${projectId(repo)}  ${repo}  conductor stopped`,
          '  0 running, 1 planned, 0 merged',
        ]);
      });

      // Reading every store is another project's door, as it is for `pup status`.
      it.each([
        ['a session that left every repo', { PUP_SESSION_ID: 's-elsewhere' }],
        ['the conductor', { PUP_CONDUCTOR: 'p1' }],
      ])('refuses %s', (_who, env) => {
        registerProject(initRepo());
        useCwd(tempDir('pup-cli-noproj-'));
        for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
        stubRender();

        expect(() => runUi(true)).toThrow('operator-only');
        expect(render).not.toHaveBeenCalled();
      });
    });
  });

  describe('watch', () => {
    it('emits a STALLED line for a running session with an old events file', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's-stalled');
      const { db } = resolveProject(repo);
      transitionSession(db, 's-stalled', 'running');
      db.close();
      seedEventsFile(repo, 's-stalled', STALLED_AFTER_MS + 60_000);

      buildProgram().parse(['watch', '--once'], { from: 'user' });

      expect(logs.some((line) => line.includes('STALLED') && line.includes('s-stalled'))).toBe(
        true,
      );
    });

    it('resumes a stalled session whose pane shows a dead turn, and prints one line for it', () => {
      const repo = initRepo();
      useCwd(repo);
      seedStalledSession(repo, 's-dead');
      vi.mocked(sessionPane).mockReturnValue({ sessionId: 's-dead', paneId: '%7' });
      vi.mocked(deadTurnError).mockReturnValue('⏺ API Error: Connection lost');

      buildProgram().parse(['watch', '--once'], { from: 'user' });

      expect(steerSession).toHaveBeenCalledTimes(1);
      expect(firstCall(steerSession).slice(1)).toEqual(['s-dead', RESUME_MESSAGE]);
      const resumeLines = logs.filter((line) => line.includes('TURN DIED'));
      expect(resumeLines).toHaveLength(1);
      expect(resumeLines[0]).toMatch(
        /TURN DIED {2}s-dead {2}resumed {2}⏺ API Error: Connection lost$/,
      );
      // Still stalled on this sweep: the events file only moves once the
      // resumed turn fires a hook.
      expect(logs.some((line) => line.includes('STALLED') && line.includes('s-dead'))).toBe(true);
      const { db } = resolveProject(repo);
      const types = listEvents(db, 's-dead').map((event) => event.type);
      db.close();
      expect(types).toEqual(expect.arrayContaining(['turn_died', 'steer']));
    });

    // The sweep types into panes and records resumes in the watcher's name:
    // a session or the conductor running it could forge one against another
    // session. The detached radar runs from the main checkout with both
    // variables stripped, so it passes.
    it.each([
      ['a session', 'PUP_SESSION_ID', 's1'],
      ['the conductor', 'PUP_CONDUCTOR', 'p1'],
    ])('refuses %s running the radar', (_who, variable, value) => {
      const repo = initRepo();
      useCwd(repo);
      seedStalledSession(repo, 's1');
      vi.mocked(sessionPane).mockReturnValue({ sessionId: 's1', paneId: '%7' });
      vi.mocked(deadTurnError).mockReturnValue('⏺ API Error: Connection lost');
      vi.stubEnv(variable, value);

      buildProgram().parse(['watch', '--once'], { from: 'user' });

      expect(errors).toEqual(['`pup watch` is operator-only; the radar resumes sessions.']);
      expect(logs).toEqual([]);
      expect(steerSession).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    // The overlap scan has already recorded this sweep's beat, so a sweep
    // that killed the process would be a radar `pup status` reads as running
    // while nothing sweeps.
    it('reports a sweep that throws and goes on with the scan', () => {
      const repo = initRepo();
      useCwd(repo);
      seedStalledSession(repo, 's-dead');
      vi.mocked(sessionPane).mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      });

      buildProgram().parse(['watch', '--once'], { from: 'user' });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\S+ {2}watchdog sweep failed {2}SQLITE_BUSY: database is locked$/,
      );
      expect(logs.some((line) => line.includes('STALLED') && line.includes('s-dead'))).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });

    it('prints the refusal when the resume could not be typed', () => {
      const repo = initRepo();
      useCwd(repo);
      seedStalledSession(repo, 's-dead');
      vi.mocked(sessionPane).mockReturnValue({ sessionId: 's-dead', paneId: '%7' });
      vi.mocked(deadTurnError).mockReturnValue('⏺ API Error: Connection lost');
      vi.mocked(steerSession).mockImplementation(() => {
        throw new SteerNotDeliveredError('s-dead', RESUME_MESSAGE.length);
      });

      buildProgram().parse(['watch', '--once'], { from: 'user' });

      expect(logs.find((line) => line.includes('TURN DIED'))).toMatch(
        /TURN DIED {2}s-dead {2}resume REFUSED \(Steer to session s-dead did not land: \d+ chars\) {2}⏺ API Error/,
      );
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('init', () => {
    it('reports the NoAdapterError and exits 1 when no adapter detects the repo', () => {
      useCwd(initRepo());

      buildProgram().parse(['init'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('No adapter detected')]);
      expect(logs).toEqual([]);
    });

    it('throws when run outside any git repo (no project to resolve)', () => {
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() => buildProgram().parse(['init'], { from: 'user' })).toThrow();
    });

    // Beside the sandbox line and for the same reason (decision 36): an
    // operator who never sees it cannot tell a fleet whose sessions get a code
    // graph from one whose sessions grep.
    it('reports the installed codegraph version beside the sandbox line', () => {
      useCwd(initRepoWithAdapter());
      stubCodegraph('codegraph 1.6.0');

      buildProgram().parse(['init'], { from: 'user' });

      expect(logs).toContain('codegraph: codegraph 1.6.0');
      expect(logs.indexOf('codegraph: codegraph 1.6.0')).toBe(
        logs.findIndex((line) => line.startsWith('sandbox: ')) + 1,
      );
    });

    it('says so when the operator has none — detected like gh and tmux, never required', () => {
      useCwd(initRepoWithAdapter());
      stubCodegraph();

      buildProgram().parse(['init'], { from: 'user' });

      expect(logs).toContain('codegraph: not installed');
    });

    const ORIGIN_URL = 'git@github.com:owner/repo.git';

    /** What a real project has: an adapter to detect and an origin to push to. */
    function initRepoWithOrigin(): string {
      const repo = initRepoWithAdapter();
      execFileSync('git', ['remote', 'add', 'origin', ORIGIN_URL], {
        cwd: repo,
        env: GIT_ENV,
        encoding: 'utf8',
      });
      return repo;
    }

    function recordedOrigin(repo: string): string | null {
      const { db } = resolveProject(repo);
      const row = db.prepare('SELECT origin_url FROM projects WHERE id = ?').get(projectId(repo)) as
        | { origin_url: string | null }
        | undefined;
      db.close();
      return row?.origin_url ?? null;
    }

    // The recorded push target is what `pup merge --pr` refuses to differ from,
    // so it is printed with the other lines about how this fleet is confined
    // (decisions 36, 51, 56).
    it("records origin's URL and prints it beside the sandbox line", () => {
      const repo = initRepoWithOrigin();
      useCwd(repo);

      buildProgram().parse(['init'], { from: 'user' });

      expect(recordedOrigin(repo)).toBe(ORIGIN_URL);
      expect(logs).toContain(`push target: ${ORIGIN_URL}`);
      expect(logs.indexOf(`push target: ${ORIGIN_URL}`)).toBe(
        logs.findIndex((line) => line.startsWith('sandbox: ')) + 2,
      );
    });

    it('says the push target is unrecorded when the repo has no origin to record', () => {
      useCwd(initRepoWithAdapter());

      buildProgram().parse(['init'], { from: 'user' });

      expect(logs).toContain(
        'push target: not recorded — `pup merge --pr` refuses until `pup init` records one',
      );
    });

    // `init` stamps the debt baseline exactly as `audit` does, and records the
    // push target the gate holds a `--pr` merge to, so a session running it
    // would pick the moment its own bar moved and where its work is pushed
    // (decisions 48, 56, 64). Discriminating on the writes, not only the
    // message: the baseline and the push target are both still null after.
    it.each([
      ['', []],
      [' --origin-moved', ['--origin-moved']],
    ])('refuses `init%s` when a session is calling', (_label, flags) => {
      const repo = initRepoWithOrigin();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');

      buildProgram().parse(['init', ...flags], { from: 'user' });

      expect(errors).toEqual(['`pup init` is operator-only; sessions cannot move the baseline.']);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(recordedOrigin(repo)).toBeNull();
      const { db } = resolveProject(repo);
      expect(db.prepare('SELECT baseline FROM projects WHERE id = ?').get(projectId(repo))).toEqual(
        { baseline: null },
      );
      db.close();
    });

    // The conductor is the operator's delegate for setup, as it is for the
    // audit (decision 48): the guard asks for a session and nothing else.
    it('lets the conductor run `init`', () => {
      const repo = initRepoWithOrigin();
      useCwd(repo);
      vi.stubEnv('PUP_CONDUCTOR', 'p1');

      buildProgram().parse(['init'], { from: 'user' });

      expect(errors).toEqual([]);
      expect(recordedOrigin(repo)).toBe(ORIGIN_URL);
      const { db } = resolveProject(repo);
      expect(
        db.prepare('SELECT baseline FROM projects WHERE id = ?').get(projectId(repo)),
      ).not.toEqual({ baseline: null });
      db.close();
    });

    it('prints a recorded push target through the sanitizer', () => {
      const repo = initRepoWithOrigin();
      useCwd(repo);
      // A row written before `recordOriginUrl` refused these: printing it raw
      // would let it repaint the sandbox and codegraph lines above it.
      const { db } = resolveProject(repo);
      ensureProject(db, projectId(repo), repo);
      db.prepare('UPDATE projects SET origin_url = ? WHERE id = ?').run(
        `${ORIGIN_URL}\u001b[2Aowned`,
        projectId(repo),
      );
      db.close();

      buildProgram().parse(['init'], { from: 'user' });

      expect(logs).toContain(`push target: ${ORIGIN_URL} [2Aowned`);
    });

    // The record is made before the stages so a stage that dies cannot lose it
    // (decision 55); the line reporting it has to survive the same death, or a
    // first record lands with no output at all.
    it('prints the recorded push target when a broken toolchain kills the capture', () => {
      const repo = initRepo();
      execFileSync('git', ['remote', 'add', 'origin', ORIGIN_URL], {
        cwd: repo,
        env: GIT_ENV,
        encoding: 'utf8',
      });
      useCwd(repo);
      const tmp = tempDir('pup-cli-cache-');
      vi.stubEnv('TMPDIR', tmp);
      // The poisoned shape decision 55 recognises: a corepack install whose
      // bin/ is empty, so the stage's `node <entrypoint>` dies with an empty
      // require stack. Reached through a custom adapter, the one way a test
      // repo can name the command a stage runs.
      const install = join(
        tmp,
        'pup-toolchain-cache',
        projectId(repo),
        'corepack',
        'v1',
        'pnpm',
        '1.0.0',
      );
      mkdirSync(join(install, 'bin'), { recursive: true });
      mkdirSync(join(repo, '.pupitre'), { recursive: true });
      writeFileSync(
        join(repo, '.pupitre', 'adapter.yml'),
        `id: fake\nbuild: node ${join(install, 'bin', 'pnpm.cjs')}\n`,
      );

      expect(() => buildProgram().parse(['init'], { from: 'user' })).toThrow('toolchain cache');

      expect(recordedOrigin(repo)).toBe(ORIGIN_URL);
      expect(logs).toEqual([`push target: ${ORIGIN_URL}`]);
    });

    it('re-records a moved origin when the operator says it moved', () => {
      const repo = initRepoWithOrigin();
      useCwd(repo);
      buildProgram().parse(['init'], { from: 'user' });
      execFileSync('git', ['config', 'remote.origin.url', 'git@github.com:owner/renamed.git'], {
        cwd: repo,
        env: GIT_ENV,
        encoding: 'utf8',
      });

      buildProgram().parse(['init', '--origin-moved'], { from: 'user' });

      expect(recordedOrigin(repo)).toBe('git@github.com:owner/renamed.git');
      expect(logs).toContain('push target: git@github.com:owner/renamed.git');
    });
  });

  describe('audit', () => {
    it('reports the NoAdapterError and exits 1 when no adapter detects the repo', () => {
      useCwd(initRepo());

      buildProgram().parse(['audit'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('No adapter detected')]);
      expect(logs).toEqual([]);
    });

    it('throws when run outside any git repo (no project to resolve)', () => {
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() => buildProgram().parse(['audit'], { from: 'user' })).toThrow();
    });

    // The repeat path prints it too, or the capability goes quiet on every run
    // after the first (decision 29).
    it('reports the codegraph capability on the re-run path as well', () => {
      useCwd(initRepoWithAdapter());
      stubCodegraph('1.6.0');

      buildProgram().parse(['audit'], { from: 'user' });

      expect(logs).toContain('codegraph: 1.6.0');
    });

    it('reports an absent codegraph on the re-run path too', () => {
      useCwd(initRepoWithAdapter());
      stubCodegraph();

      buildProgram().parse(['audit'], { from: 'user' });

      expect(logs).toContain('codegraph: not installed');
    });

    // A sweep is scoped to the whole repo, so it collides with every live
    // session there is; refusing it would make `--sweep` unrunnable whenever
    // anything else runs, and there is no flag to say otherwise (decision 41).
    it('rolls the sweep launch back when its kickoff never lands whole', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(createSession).mockImplementation(() => {
        throw new SteerNotDeliveredError('sweep-abc', 3000);
      });

      buildProgram().parse(['audit', '--sweep'], { from: 'user' });

      expect(firstCall(killSession)[1]).toBe('sweep-abc');
      // The sweep task was already planned, so the retry is a launch of it,
      // not another `--sweep` that would plan a second one beside the orphan.
      const [, request] = firstCall(createSession);
      expect(errors).toEqual([
        'Steer to session sweep-abc did not land: 3000 chars',
        `Launch rolled back (session sweep-abc killed). Re-run \`pup launch ${(request as { task: { id: string } }).task.id}\`.`,
      ]);
      expect(errors[1]).toMatch(/Re-run `pup launch sweep-[a-z0-9]+`\.$/);
      expect(process.exitCode).toBe(1);
      expect(logs.join('\n')).not.toContain('Launched sweep session');
    });

    it('launches a sweep that allows the overlap it always has', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(createSession).mockReturnValue('sweep-abc');

      buildProgram().parse(['audit', '--sweep'], { from: 'user' });

      expect(firstCall(createSession)[1]).toMatchObject({ allowOverlap: true, origin: 'audit' });
    });

    // The compile reads the project brief, so a brief over the cap refuses the
    // sweep in one line. The sweep's expected-error list was empty, which made
    // it the one launch path that crashed on it instead (decision 57).
    it('refuses a sweep in one line when the project brief is over the cap', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(createSession).mockImplementation(() => {
        throw new InvalidProfileError('The project brief at /s/brief.md is 9000 characters.');
      });

      buildProgram().parse(['audit', '--sweep'], { from: 'user' });

      expect(errors).toEqual(['The project brief at /s/brief.md is 9000 characters.']);
      expect(process.exitCode).toBe(1);
    });

    // The audit re-stamps the debt baseline, and on a `--pr` repo nothing else
    // does, so an open `audit` let a session pick the moment its own bar moved;
    // `--sweep` is a launch besides (decisions 26, 39, 42). The stored baseline
    // is still null afterwards: the refusal lands before anything measures.
    it.each([
      ['', []],
      [' --sweep', ['--sweep']],
    ])('refuses `audit%s` when a session is calling', (_label, flags) => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');

      buildProgram().parse(['audit', ...flags], { from: 'user' });

      expect(createSession).not.toHaveBeenCalled();
      expect(errors).toEqual(['`pup audit` is operator-only; sessions cannot move the baseline.']);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
      const { db } = resolveProject(repo);
      expect(db.prepare('SELECT baseline FROM projects WHERE id = ?').get(projectId(repo))).toEqual(
        { baseline: null },
      );
    });
  });

  describe('plan', () => {
    it('records a task without launching anything', () => {
      useCwd(initRepo());
      vi.mocked(planTask).mockReturnValue('t-abc');

      buildProgram().parse(
        ['plan', 'add', 'extract the gh options', '--scope', 'src/core/github.client.ts'],
        { from: 'user' },
      );

      expect(planTask).toHaveBeenCalledTimes(1);
      const [, request] = firstCall(planTask);
      expect(request).toMatchObject({
        task: {
          goal: 'extract the gh options',
          scopeIn: ['src/core/github.client.ts'],
          acceptance: ['goal met and committed'],
        },
      });
      expect(createSession).not.toHaveBeenCalled();
      expect(logs).toContain('Planned t-abc. Launch it with `pup launch t-abc`.');
    });

    it('refuses to add without a scope', () => {
      useCwd(initRepo());

      buildProgram().parse(['plan', 'add', 'no scope given'], { from: 'user' });

      expect(planTask).not.toHaveBeenCalled();
      expect(errors).toContain('Usage: pup plan add "<goal>" --scope <glob...>');
      expect(process.exitCode).toBe(1);
    });

    it('lists the backlog, and says so when it is empty', () => {
      const repo = initRepo();
      useCwd(repo);
      buildProgram().parse(['plan'], { from: 'user' });
      expect(logs.join('\n')).toContain('Backlog empty.');

      const { db, repoPath } = resolveProject();
      ensureProject(db, projectId(repoPath), repoPath);
      insertTask(db, {
        id: 't-1',
        projectId: projectId(repoPath),
        spec: JSON.stringify({ goal: 'sharpen the thing', scopeIn: ['src/**'] }),
      });

      buildProgram().parse(['plan'], { from: 'user' });

      expect(logs.join('\n')).toContain('t-1');
      expect(logs.join('\n')).toContain('sharpen the thing');
      expect(logs.join('\n')).toContain('src/**');
      expect(logs.join('\n')).not.toContain('(from');
    });

    // A spec an agent wrote is one the operator never typed; the listing the
    // operator launches from says so (decision 47).
    it('marks a task the conductor authored, in the backlog and in status', () => {
      const repo = initRepo();
      useCwd(repo);
      const { db, repoPath } = resolveProject(repo);
      ensureProject(db, projectId(repoPath), repoPath);
      insertTask(db, {
        id: 't-c',
        projectId: projectId(repoPath),
        spec: JSON.stringify({ goal: 'fold the guards', scopeIn: ['src/**'] }),
        origin: 'conductor',
      });
      db.close();

      buildProgram().parse(['plan'], { from: 'user' });
      buildProgram().parse(['status'], { from: 'user' });

      const planned = logs.filter((line) => line.includes('t-c'));
      expect(planned).toHaveLength(2);
      for (const line of planned) expect(line).toContain('(from conductor)');
    });

    it('drops a planned task, and reports one it cannot drop', () => {
      const repo = initRepo();
      useCwd(repo);
      const { db, repoPath } = resolveProject();
      ensureProject(db, projectId(repoPath), repoPath);
      insertTask(db, { id: 't-1', projectId: projectId(repoPath), spec: '{}' });

      buildProgram().parse(['plan', 'drop', 't-1'], { from: 'user' });
      expect(logs).toContain('Dropped t-1.');
      expect(listBacklogTasks(db, projectId(repoPath))).toEqual([]);

      buildProgram().parse(['plan', 'drop', 't-1'], { from: 'user' });
      expect(errors.join('\n')).toContain('No planned task t-1');
      expect(process.exitCode).toBe(1);
    });

    it('edits only the fields it is given', () => {
      const repo = initRepo();
      useCwd(repo);
      const { db, repoPath } = resolveProject();
      ensureProject(db, projectId(repoPath), repoPath);
      insertTask(db, {
        id: 't-1',
        projectId: projectId(repoPath),
        spec: JSON.stringify({
          id: 't-1',
          goal: 'first thought',
          scopeIn: ['src/**'],
          acceptance: ['tests pass'],
        }),
      });

      buildProgram().parse(['plan', 'edit', 't-1', '--goal', 'sharper thought'], { from: 'user' });

      expect(logs).toContain('Updated t-1.');
      expect(JSON.parse(getTask(db, 't-1')?.spec ?? '{}')).toEqual({
        id: 't-1',
        goal: 'sharper thought',
        scopeIn: ['src/**'],
        acceptance: ['tests pass'],
      });
    });

    // A spec a session writes becomes a later session's kickoff prompt verbatim
    // and the hook allowlist the gate audits against, so authoring one is prompt
    // injection carrying the operator's attribution (decisions 26, 40).
    it.each(['add', 'drop', 'edit'])('refuses `plan %s` when a session is calling', (verb) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');

      buildProgram().parse(['plan', verb, 't-1', '--scope', 'src/**'], { from: 'user' });

      expect(planTask).not.toHaveBeenCalled();
      expect(errors.join('\n')).toContain('operator-only');
      expect(process.exitCode).toBe(1);
    });

    it('still lists the backlog for a session, which reads nothing it wrote', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');

      buildProgram().parse(['plan'], { from: 'user' });

      expect(errors.join('\n')).not.toContain('operator-only');
    });

    it('rejects an unknown action', () => {
      useCwd(initRepo());

      buildProgram().parse(['plan', 'sprint'], { from: 'user' });

      expect(errors.join('\n')).toContain('Unknown plan action');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('launch', () => {
    it('starts a session for a task already in the backlog', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockReturnValue('t-abc-0');

      buildProgram().parse(['launch', 't-abc', '--model', 'opus'], { from: 'user' });

      const [, request] = firstCall(launchTask);
      expect(request).toMatchObject({ taskId: 't-abc', model: 'opus', base: DEFAULT_BASE_PROFILE });
      expect(logs).toContain('Launched session t-abc-0 (tmux: pup-t-abc-0).');
    });

    it('reports an unknown task and exits 1 rather than throwing', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockImplementation(() => {
        throw new UnknownTaskError('t-nope');
      });

      buildProgram().parse(['launch', 't-nope'], { from: 'user' });

      expect(errors.join('\n')).toContain('No task t-nope');
      expect(process.exitCode).toBe(1);
    });

    it('reports a scope conflict and exits 1 rather than throwing', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockImplementation(() => {
        throw new ScopeConflictError('t-1', [{ sessionId: 's1', files: ['src/a.ts'] }]);
      });

      buildProgram().parse(['launch', 't-1'], { from: 'user' });

      expect(errors.join('\n')).toContain('src/a.ts');
      expect(process.exitCode).toBe(1);
    });

    it('fails loudly when the kickoff context never lands whole in the new window', () => {
      // kickoff() delivers the compiled context through the same paste, so a
      // launch whose context arrived as a tail is a launch that failed, not a
      // session to attach to (decision 45).
      useCwd(initRepo());
      vi.mocked(launchTask).mockImplementation(() => {
        throw new SteerNotDeliveredError('t-abc-0', 3000);
      });

      buildProgram().parse(['launch', 't-abc'], { from: 'user' });

      // startSession throws after the task is claimed, the row is `running`
      // and the window is up; killing the session returns the task to the
      // backlog (decision 40) so `pup launch` can be re-run.
      expect(firstCall(killSession)[1]).toBe('t-abc-0');
      expect(errors).toEqual([
        'Steer to session t-abc-0 did not land: 3000 chars',
        'Launch rolled back (session t-abc-0 killed). Re-run `pup launch t-abc`.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(logs.join('\n')).not.toContain('Launched session');
    });

    it('prints the refusal before the rollback, so a kill that throws does not hide it', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockImplementation(() => {
        throw new SteerNotDeliveredError('t-abc-0', 3000);
      });
      vi.mocked(killSession).mockImplementation(() => {
        throw new Error('tmux server gone');
      });

      expect(() => buildProgram().parse(['launch', 't-abc'], { from: 'user' })).toThrow(
        'tmux server gone',
      );

      expect(errors).toEqual(['Steer to session t-abc-0 did not land: 3000 chars']);
    });

    it('rolls back a launch whose window was gone before the kickoff could type into it', () => {
      // The same three steps had already happened — task claimed, row running,
      // window opened — when the pane vanished under the kickoff, so the same
      // rollback applies (decision 46).
      useCwd(initRepo());
      vi.mocked(launchTask).mockImplementation(() => {
        throw new SessionPaneMissingError('t-abc-0', '%3', 'gone');
      });

      buildProgram().parse(['launch', 't-abc'], { from: 'user' });

      expect(firstCall(killSession)[1]).toBe('t-abc-0');
      expect(errors).toEqual([
        "Session t-abc-0's pane %3 no longer exists; nothing was sent.",
        'Launch rolled back (session t-abc-0 killed). Re-run `pup launch t-abc`.',
      ]);
      expect(process.exitCode).toBe(1);
    });

    it('passes --allow-overlap through to the launch', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockReturnValue('t-abc-0');

      buildProgram().parse(['launch', 't-abc', '--allow-overlap'], { from: 'user' });

      expect(firstCall(launchTask)[1]).toMatchObject({ allowOverlap: true });
    });

    // Guarding only `--allow-overlap` left the command open: a session could
    // kill the holder of a scope and launch a conflicting task plainly, so the
    // whole command is operator-only by the rule that keeps `pup merge` and spec
    // authoring so (decisions 26, 42).
    it.each([
      ['', []],
      [' --allow-overlap', ['--allow-overlap']],
    ])('refuses `launch%s` when a session is calling', (_label, flags) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');
      vi.mocked(launchTask).mockReturnValue('t-abc-0');

      buildProgram().parse(['launch', 't-abc', ...flags], { from: 'user' });

      expect(launchTask).not.toHaveBeenCalled();
      expect(errors).toEqual(['`pup launch` is operator-only; sessions cannot launch sessions.']);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
    });
  });

  describe('debt close', () => {
    // Retiring an entry erases the operator's own overdue-debt reminder; no
    // session closes one (decisions 30, 47).
    it('refuses a calling session and leaves the entry open', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');
      const id = seedLedgerEntry(repo);

      buildProgram().parse(['debt', 'close', String(id)], { from: 'user' });

      expect(errors.join('\n')).toContain('operator-only');
      expect(process.exitCode).toBe(1);
      const { db } = resolveProject(repo);
      expect(db.prepare('SELECT status FROM ledger_entries WHERE id = ?').get(id)).toEqual({
        status: 'open',
      });
    });
  });

  describe('conductor', () => {
    it('starts the conductor with its own model and the model its sessions get', () => {
      const repo = initRepo();
      useCwd(repo);
      vi.mocked(startConductor).mockReturnValue({
        name: 'pup-conductor-p1',
        paneId: '%3',
        delivered: true,
      });
      seedWatcherBeat(repo, 0);

      buildProgram().parse(['conductor', '--model', 'fable', '--worker-model', 'opus'], {
        from: 'user',
      });

      expect(firstCall(startConductor)[0]).toMatchObject({
        base: DEFAULT_BASE_PROFILE,
        model: 'fable',
        workerModel: 'opus',
      });
      expect(logs[0]).toBe('Conductor running (tmux: pup-conductor-p1).');
      // The socket is the project's, not the name the stub returned: the
      // window is not on the default server, and the attach has to say so.
      expect(logs[1]).toMatch(
        /^Attach with: tmux -L pup-conductor-[0-9a-f]{12} attach -t pup-conductor-p1$/,
      );
      expect(logs).toHaveLength(2);
      expect(launchWatcher).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    // The radar hosts the turn watchdog, and the conductor's waiting turn is
    // what the watchdog exists to bring back (addendum to decision 35).
    // Whether one is up is the store's beat, not a window name a session
    // could mint.
    it.each([
      ['none has ever swept', undefined],
      ['the last beat is stale', WATCH_STALE_AFTER_MS + 1_000],
    ])('starts the conflict radar with it when %s, and says so', (_when, beatAgeMs) => {
      const repo = initRepo();
      useCwd(repo);
      vi.mocked(startConductor).mockReturnValue({
        name: 'pup-conductor-p1',
        paneId: '%3',
        delivered: true,
      });
      if (beatAgeMs !== undefined) seedWatcherBeat(repo, beatAgeMs);
      vi.mocked(launchWatcher).mockReturnValue({ target: 'pup-watch-p1' });

      buildProgram().parse(['conductor', 'start'], { from: 'user' });

      expect(firstCall(launchWatcher)).toEqual([projectId(repo), repo]);
      expect(logs[2]).toBe(
        'Conflict radar started with it (tmux: pup-watch-p1) — it runs the turn watchdog.',
      );
      expect(logs).toHaveLength(3);
    });

    it('stops the conductor', () => {
      useCwd(initRepo());

      buildProgram().parse(['conductor', 'stop'], { from: 'user' });

      expect(stopConductor).toHaveBeenCalledTimes(1);
      expect(startConductor).not.toHaveBeenCalled();
      expect(logs).toContain('Conductor stopped.');
    });

    it('rejects an unknown action', () => {
      useCwd(initRepo());

      buildProgram().parse(['conductor', 'restart'], { from: 'user' });

      expect(errors.join('\n')).toContain('Unknown conductor action');
      expect(process.exitCode).toBe(1);
    });

    it('rolls the launch back when the kickoff never lands whole', () => {
      useCwd(initRepo());
      vi.mocked(startConductor).mockImplementation(() => {
        throw new SteerNotDeliveredError('conductor-p1', 900);
      });

      buildProgram().parse(['conductor'], { from: 'user' });

      expect(stopConductor).toHaveBeenCalledTimes(1);
      expect(errors[0]).toContain('did not land');
      expect(errors[1]).toContain('rolled back');
      expect(process.exitCode).toBe(1);
    });

    // A window with no context is a bypass-permissions agent in the main
    // checkout that has read none of its tier — killed, never left up.
    it('kills the window and exits 1 when it never became ready to take its context', () => {
      useCwd(initRepo());
      vi.mocked(startConductor).mockReturnValue({
        name: 'pup-conductor-p1',
        paneId: '%3',
        delivered: false,
      });

      buildProgram().parse(['conductor'], { from: 'user' });

      expect(stopConductor).toHaveBeenCalledTimes(1);
      expect(errors.join('\n')).toContain('the window was killed');
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
    });

    // The conductor holds every operator power but the merge, so a session or
    // a conductor minting one would be a session launching sessions under
    // another name (decision 47).
    it.each([
      ['a session', 'PUP_SESSION_ID', 's1', 'start'],
      ['a session', 'PUP_SESSION_ID', 's1', 'stop'],
      ['the conductor', 'PUP_CONDUCTOR', 'p1', 'start'],
      ['the conductor', 'PUP_CONDUCTOR', 'p1', 'stop'],
    ])('refuses %s calling `conductor %s`', (_who, variable, value, verb) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv(variable, value);

      buildProgram().parse(['conductor', verb], { from: 'user' });

      expect(startConductor).not.toHaveBeenCalled();
      expect(stopConductor).not.toHaveBeenCalled();
      expect(errors).toEqual([`\`pup conductor ${verb}\` is operator-only.`]);
      expect(process.exitCode).toBe(1);
    });
  });

  /**
   * `pup review` prints a whole page out of the store on the operator's
   * terminal: the session row, the spec the conductor may have written, and the
   * gate report the events hold. Every string on it is scrubbed (decision 67).
   */
  describe('review', () => {
    const NOISY_ID = '\u001b[2Js1';

    /** One reviewable session whose every stored string carries an escape. */
    function seedReviewable(repoPath: string): void {
      seedSession(repoPath, NOISY_ID);
      const { db } = resolveProject(repoPath);
      db.prepare('UPDATE tasks SET spec = ? WHERE id = ?').run(
        JSON.stringify({
          id: `t-${NOISY_ID}`,
          goal: '\u001b[2Jheadline\nsecond line of the goal',
          scopeIn: ['\u001b[2Jsrc/**'],
          scopeOut: ['\u001b[2Jdocs/**'],
          acceptance: ['\u001b[2Jit works'],
        }),
        `t-${NOISY_ID}`,
      );
      db.prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?').run(
        '\u001b[2J/wt',
        NOISY_ID,
      );
      transitionSession(db, NOISY_ID, 'running');
      transitionSession(db, NOISY_ID, 'awaiting-review');
      appendEvent(db, NOISY_ID, 'gate_result', {
        report: {
          sessionId: NOISY_ID,
          passed: false,
          sandbox: 'none',
          stages: [{ stage: '\u001b[2Jlint', status: 'fail', detail: '\u001b[2Jboom' }],
        },
      });
      db.close();
    }

    it('scrubs the queue row, and prints the goal as one headline', () => {
      const repo = initRepo();
      useCwd(repo);
      seedReviewable(repo);

      buildProgram().parse(['review'], { from: 'user' });

      const row = logs.at(-1) ?? '';
      expect(row).toContain('[2Js1');
      expect(row).toContain('[2Jheadline');
      // A goal runs to a paragraph; the queue is one line per session.
      expect(row).not.toContain('second line of the goal');
      expect(row).not.toContain('\u001b');
    });

    it("scrubs every stored string on one branch's page", () => {
      const repo = initRepo();
      useCwd(repo);
      seedReviewable(repo);

      buildProgram().parse(['review', NOISY_ID], { from: 'user' });

      const page = logs.join('\n');
      expect(page).toContain('[2Js1  (awaiting-review');
      // An escape is replaced by a space, so a branch that opens with one
      // reads `pup/ [2Js1` rather than losing a character.
      expect(page).toContain('branch: pup/ [2Js1  worktree: [2J/wt');
      expect(page).toContain('scope-in: [2Jsrc/**');
      expect(page).toContain('scope-out: [2Jdocs/**');
      expect(page).toContain('acceptance: [2Jit works');
      expect(page).toContain('[2Jlint');
      expect(page).toContain('[2Jboom');
      expect(page).not.toContain('\u001b');
    });
  });

  // The brief is the operator's direction to the whole fleet, read into the
  // conductor and every session at their next start (decision 57).
  describe('brief', () => {
    /** An editor that always succeeds and changes nothing. */
    function stubEditor(): void {
      vi.stubEnv('EDITOR', 'true');
    }

    it('creates the templated brief on first edit, and then shows it', () => {
      const repo = initRepo();
      useCwd(repo);
      stubEditor();

      buildProgram().parse(['brief', 'edit'], { from: 'user' });
      buildProgram().parse(['brief', 'show'], { from: 'user' });

      const path = projectPaths(repo).briefFile;
      expect(existsSync(path)).toBe(true);
      expect(logs).toContain(`Created ${path} from the template.`);
      const shown = logs.at(-1) ?? '';
      expect(shown).toContain('## Destination');
      expect(shown).toContain('## Constraints');
      expect(shown).toContain('## Priorities');
      expect(process.exitCode).toBeUndefined();
    });

    it('defaults to showing, and says a project with no brief has none', () => {
      const repo = initRepo();
      useCwd(repo);

      buildProgram().parse(['brief'], { from: 'user' });

      expect(logs.join('\n')).toContain('No project brief yet.');
      expect(existsSync(projectPaths(repo).briefFile)).toBe(false);
      expect(process.exitCode).toBeUndefined();
    });

    it('prints the brief the operator wrote, not the template', () => {
      const repo = initRepo();
      useCwd(repo);
      mkdirSync(projectPaths(repo).root, { recursive: true });
      writeFileSync(projectPaths(repo).briefFile, '## Destination\nShip the gate.\n');

      buildProgram().parse(['brief', 'show'], { from: 'user' });

      expect(logs).toContain('## Destination\nShip the gate.');
    });

    // Naming them is the whole point of the line: a window already open read
    // the brief as it was, and only the operator can decide whether that is
    // worth restarting.
    it('names the running conductor and sessions the edit will not reach', () => {
      const repo = initRepo();
      useCwd(repo);
      seedStalledSession(repo, 's1');
      vi.mocked(isConductorRunning).mockReturnValue(true);
      stubEditor();

      buildProgram().parse(['brief', 'edit'], { from: 'user' });

      const line = logs.at(-1) ?? '';
      expect(line).toContain('takes effect at the next launch and the next conductor start');
      expect(line).toContain(`pup-conductor-${projectId(repo)}`);
      expect(line).toContain('s1');
      expect(line).toContain('are already running on the brief as it was');
    });

    // The ids come out of a store the sessions themselves write, and this line
    // puts them on the operator's terminal (decisions 29, 61).
    it('strips what a terminal would obey out of a session id it names', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, '\u001b[2Js1');
      const { db } = resolveProject(repo);
      transitionSession(db, '\u001b[2Js1', 'running');
      db.close();
      stubEditor();

      buildProgram().parse(['brief', 'edit'], { from: 'user' });

      expect(logs.at(-1)).toContain('[2Js1 is already running on the brief as it was');
      expect(logs.at(-1)).not.toContain('\u001b');
    });

    it('says only that it takes effect later when nothing is running', () => {
      const repo = initRepo();
      useCwd(repo);
      stubEditor();

      buildProgram().parse(['brief', 'edit'], { from: 'user' });

      expect(logs.at(-1)).toBe(
        'Saved. It takes effect at the next launch and the next conductor start.',
      );
    });

    it('keeps the file when the editor fails, and says what failed', () => {
      const repo = initRepo();
      useCwd(repo);
      vi.stubEnv('EDITOR', 'false');

      buildProgram().parse(['brief', 'edit'], { from: 'user' });

      expect(existsSync(projectPaths(repo).briefFile)).toBe(true);
      expect(errors.join('\n')).toContain('exited 1');
      expect(process.exitCode).toBe(1);
    });

    // A missing editor binary must say so: `exited on a signal` would send the
    // operator looking at the editor's behaviour instead of their $EDITOR.
    it('says an editor that is not installed could not run', () => {
      const repo = initRepo();
      useCwd(repo);
      vi.stubEnv('EDITOR', 'pup-no-such-editor');

      buildProgram().parse(['brief', 'edit'], { from: 'user' });

      expect(errors.join('\n')).toContain('could not run');
      expect(errors.join('\n')).toContain('ENOENT');
      expect(errors.join('\n')).not.toContain('on a signal');
      expect(existsSync(projectPaths(repo).briefFile)).toBe(true);
      expect(process.exitCode).toBe(1);
    });

    it('falls back to $VISUAL when $EDITOR is unset', () => {
      const repo = initRepo();
      useCwd(repo);
      vi.stubEnv('EDITOR', '');
      vi.stubEnv('VISUAL', 'pup-visual-editor');

      buildProgram().parse(['brief', 'edit'], { from: 'user' });

      expect(errors.join('\n')).toContain('pup-visual-editor');
    });

    // `pup brief show` prints to the operator's terminal, so the cap it shares
    // with the compilers refuses here in one line too (decision 57).
    it('refuses to show a brief over the cap, naming the file', () => {
      const repo = initRepo();
      useCwd(repo);
      mkdirSync(projectPaths(repo).root, { recursive: true });
      writeFileSync(projectPaths(repo).briefFile, 'x'.repeat(9000));

      buildProgram().parse(['brief', 'show'], { from: 'user' });

      expect(errors.join('\n')).toContain(projectPaths(repo).briefFile);
      expect(errors.join('\n')).toContain('pup brief edit');
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
    });

    // The terminal the brief is printed to is the operator's: an escape
    // sequence in a store file a session can reach must not reach it.
    it('prints a brief with its control characters stripped', () => {
      const repo = initRepo();
      useCwd(repo);
      mkdirSync(projectPaths(repo).root, { recursive: true });
      writeFileSync(projectPaths(repo).briefFile, '## Destination\r\n\u001b[2JShip the gate.\n');

      buildProgram().parse(['brief', 'show'], { from: 'user' });

      expect(logs).toEqual(['## Destination\n[2JShip the gate.']);
    });

    it('refuses an unknown action', () => {
      useCwd(initRepo());

      buildProgram().parse(['brief', 'publish'], { from: 'user' });

      expect(errors).toEqual(['Unknown brief action `publish` (expected show|edit).']);
      expect(process.exitCode).toBe(1);
    });

    // Both halves are refused, `show` included: a session writing the brief
    // would be writing its own kickoff and the next session's, and the
    // Priorities are the conductor's to act on, not a session's to read.
    it.each([
      ['a session', 'PUP_SESSION_ID', 's1'],
      ['the conductor', 'PUP_CONDUCTOR', 'p1'],
    ])('refuses %s running `brief show` and `brief edit`', (_who, variable, value) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      mkdirSync(projectPaths(repo).root, { recursive: true });
      writeFileSync(projectPaths(repo).briefFile, '## Destination\nShip the gate.\n');
      vi.stubEnv(variable, value);
      vi.stubEnv('EDITOR', 'true');

      buildProgram().parse(['brief', 'show'], { from: 'user' });
      buildProgram().parse(['brief', 'edit'], { from: 'user' });

      expect(errors).toEqual([
        '`pup brief show` is operator-only.',
        '`pup brief edit` is operator-only.',
      ]);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
    });
  });

  // The conductor is the operator's delegate for planning, launching, steering
  // and killing, refused the merge, the respawn and other projects, and what
  // it plans is recorded as its own (decision 47).
  // Decision 62: the registry, and putting a project to sleep and waking it.
  describe('project', () => {
    function dormantAt(repo: string): string | null {
      const { db } = resolveProject(repo);
      const row = db
        .prepare('SELECT dormant_at FROM projects WHERE id = ?')
        .get(projectId(repo)) as { dormant_at: string | null };
      db.close();
      return row.dormant_at;
    }

    it('lists every registered project with its state and its conductor', () => {
      const repoA = initRepo();
      const repoB = initRepo();
      registerProject(repoA);
      registerProject(repoB);
      markDormant(repoB);
      vi.mocked(isConductorRunning).mockImplementation((repoPath) => repoPath === repoA);
      useCwd(tempDir('pup-cli-noproj-'));

      buildProgram().parse(['project', 'list'], { from: 'user' });

      expect([...logs].sort()).toEqual(
        [
          `${projectId(repoA)}  ${repoA}  active  conductor running`,
          `${projectId(repoB)}  ${repoB}  dormant since 2026-09-21T10:00:00.000Z  conductor stopped`,
        ].sort(),
      );
      expect(process.exitCode).toBeUndefined();
    });

    it('lists the one project --project names, and refuses an id nobody registered', () => {
      const repo = initRepo();
      const id = registerProject(repo);
      registerProject(initRepo());
      useCwd(tempDir('pup-cli-noproj-'));

      buildProgram().parse(['--project', id, 'project', 'list'], { from: 'user' });
      expect(logs).toEqual([`${id}  ${repo}  active  conductor stopped`]);

      buildProgram().parse(['--project', 'nope\u001b[2J', 'project', 'list'], { from: 'user' });
      expect(errors).toEqual([
        'No project nope [2J; `pup project list` shows the registered ones.',
      ]);
      expect(process.exitCode).toBe(1);
    });

    // A store is session-writable, and the registry prints what it says (decision 29).
    it('strips control characters out of a dormant stamp before printing it', () => {
      const repo = initRepo();
      registerProject(repo);
      markDormant(repo, '2026\u001b[31m');
      useCwd(tempDir('pup-cli-noproj-'));

      buildProgram().parse(['project', 'list'], { from: 'user' });

      expect(logs).toEqual([
        `${projectId(repo)}  ${repo}  dormant since 2026 [31m  conductor stopped`,
      ]);
    });

    // A session's shell can write a BLOB into its own row; the driver hands it
    // back as bytes, and every reader must still get a string (decision 62).
    it('reads a BLOB stamp as dormant, scrubbed, in list, status --dormant and dormant', () => {
      const repo = initRepo();
      const id = registerProject(repo);
      const { db } = resolveProject(repo);
      db.prepare('UPDATE projects SET dormant_at = ? WHERE id = ?').run(
        Buffer.from([0x1b, 0x5b, 0x32, 0x4a]),
        id,
      );
      db.close();
      useCwd(tempDir('pup-cli-noproj-'));

      buildProgram().parse(['project', 'list'], { from: 'user' });
      buildProgram().parse(['status', '--dormant'], { from: 'user' });
      buildProgram().parse(['project', 'dormant', id], { from: 'user' });

      expect(logs).toEqual([
        `${id}  ${repo}  dormant since [2J  conductor stopped`,
        `${id}  ${repo}  conductor stopped  dormant since [2J`,
        '  0 running, 0 planned, 0 merged',
        `Project ${id} is already dormant since [2J.`,
      ]);
      expect(process.exitCode).toBeUndefined();
    });

    it('refuses an empty registry, an id on list, and an unknown action', () => {
      useCwd(tempDir('pup-cli-noproj-'));

      buildProgram().parse(['project', 'list'], { from: 'user' });
      buildProgram().parse(['project', 'list', 'abc'], { from: 'user' });
      buildProgram().parse(['project', 'forget'], { from: 'user' });

      expect(errors).toEqual([
        'No project registered; run pup init from the repo you want to control.',
        '`pup project list` takes no id; use --project <id>.',
        'Unknown project action `forget` (expected list|dormant|wake).',
      ]);
      expect(process.exitCode).toBe(1);
    });

    it('refuses to put a project to sleep while its conductor or a session is live, naming them', () => {
      const repo = initRepo();
      const id = registerProject(repo);
      seedSession(repo, 's-live');
      const { db } = resolveProject(repo);
      transitionSession(db, 's-live', 'running');
      db.close();
      seedKilledSession(repo, 's-gone');
      seedSession(repo, 's-review');
      const review = resolveProject(repo);
      transitionSession(review.db, 's-review', 'running');
      transitionSession(review.db, 's-review', 'awaiting-review');
      review.db.close();
      vi.mocked(isConductorRunning).mockReturnValue(true);
      useCwd(repo);

      buildProgram().parse(['project', 'dormant'], { from: 'user' });

      // Sessions seeded in the same second tie on created_at, so their order is the store's.
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(
        new RegExp(
          `^Project ${id} still has pup-conductor-${id}, (s-live, s-review|s-review, s-live) live; stop them \\(pup conductor stop, pup kill <session>, or merge\\) before putting it to sleep\\.$`,
        ),
      );
      expect(process.exitCode).toBe(1);
      expect(dormantAt(repo)).toBeNull();

      // The conductor stopped and one session merged, the other still live:
      // named alone. Awaiting review is live, not only running.
      errors.length = 0;
      vi.mocked(isConductorRunning).mockReturnValue(false);
      const merged = resolveProject(repo);
      transitionSession(merged.db, 's-live', 'killed');
      merged.db.close();
      buildProgram().parse(['project', 'dormant'], { from: 'user' });
      expect(errors).toEqual([
        `Project ${id} still has s-review live; stop it (pup conductor stop, pup kill <session>, or merge) before putting it to sleep.`,
      ]);

      // Everything stopped: it sleeps.
      const reopened = resolveProject(repo);
      transitionSession(reopened.db, 's-review', 'merged');
      reopened.db.close();
      process.exitCode = undefined;
      buildProgram().parse(['project', 'dormant'], { from: 'user' });
      expect(process.exitCode).toBeUndefined();
      expect(logs).toEqual([
        `Project ${id} is dormant: pup status, pup ui and the radar pass it over until \`pup project wake ${id}\`.`,
      ]);
      expect(dormantAt(repo)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('wakes a dormant project, and says so when there is nothing to change', () => {
      const repo = initRepo();
      const id = registerProject(repo);
      markDormant(repo);
      useCwd(repo);

      buildProgram().parse(['project', 'dormant'], { from: 'user' });
      buildProgram().parse(['project', 'wake'], { from: 'user' });
      buildProgram().parse(['project', 'wake'], { from: 'user' });

      expect(logs).toEqual([
        `Project ${id} is already dormant since 2026-09-21T10:00:00.000Z.`,
        `Project ${id} is awake: the fleet views and the radar read it again.`,
        `Project ${id} is already active.`,
      ]);
      expect(dormantAt(repo)).toBeNull();
      expect(process.exitCode).toBeUndefined();
    });

    it('targets a project by id or --project from anywhere, and refuses two different ones', () => {
      const repoA = initRepo();
      const repoB = initRepo();
      const idA = registerProject(repoA);
      const idB = registerProject(repoB);
      useCwd(tempDir('pup-cli-noproj-'));

      buildProgram().parse(['project', 'dormant', idA], { from: 'user' });
      buildProgram().parse(['--project', idB, 'project', 'dormant'], { from: 'user' });
      expect(dormantAt(repoA)).not.toBeNull();
      expect(dormantAt(repoB)).not.toBeNull();
      buildProgram().parse(['--project', idA, 'project', 'wake', idA], { from: 'user' });
      expect(dormantAt(repoA)).toBeNull();
      expect(process.exitCode).toBeUndefined();

      buildProgram().parse(['--project', idA, 'project', 'wake', idB], { from: 'user' });
      expect(errors).toEqual([
        `\`pup project wake\` was given two projects (${idB} and --project ${idA}); name one.`,
      ]);
      expect(dormantAt(repoB)).not.toBeNull();
      expect(process.exitCode).toBe(1);
    });

    it('refuses a repo that was never registered', () => {
      const repo = initRepo();
      useCwd(repo);

      buildProgram().parse(['project', 'dormant'], { from: 'user' });

      expect(errors).toEqual([
        `No project at ${repo}; run pup init from the repo you want to control.`,
      ]);
      expect(process.exitCode).toBe(1);
    });

    describe.each([['list'], ['dormant'], ['wake']])('%s is operator-only', (action) => {
      // The same refusal `--project` throws (decision 43): one guard, not a per-command copy.
      const operatorOnlyMessage =
        'Reaching another project is operator-only; a session controls only the project it runs in.';

      it('refuses a session asking from its worktree', () => {
        const repo = initRepo();
        const worktree = worktreeOf(repo, 's1');
        seedSession(repo, 's1', worktree);
        useCwd(worktree);

        expect(() => buildProgram().parse(['project', action], { from: 'user' })).toThrow(
          operatorOnlyMessage,
        );
        expect(dormantAt(repo)).toBeNull();
      });

      it('refuses a session that left every repo but still exports PUP_SESSION_ID', () => {
        const repo = initRepo();
        const id = registerProject(repo);
        useCwd(tempDir('pup-cli-noproj-'));
        vi.stubEnv('PUP_SESSION_ID', 's-elsewhere');

        expect(() =>
          buildProgram().parse(['--project', id, 'project', action], { from: 'user' }),
        ).toThrow(operatorOnlyMessage);
        expect(logs).toEqual([]);
        expect(dormantAt(repo)).toBeNull();
      });

      it('refuses the conductor, from inside its own repo', () => {
        const repo = initRepo();
        registerProject(repo);
        useCwd(repo);
        vi.stubEnv('PUP_CONDUCTOR', projectId(repo));

        expect(() => buildProgram().parse(['project', action], { from: 'user' })).toThrow(
          operatorOnlyMessage,
        );
        expect(logs).toEqual([]);
        expect(dormantAt(repo)).toBeNull();
      });
    });
  });

  describe('a calling conductor', () => {
    beforeEach(() => {
      vi.stubEnv('PUP_CONDUCTOR', 'p1');
    });

    it('launches a task, and answers for an overlap it waves through', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockReturnValue('t-abc-0');

      buildProgram().parse(['launch', 't-abc', '--allow-overlap'], { from: 'user' });

      expect(firstCall(launchTask)[1]).toMatchObject({
        taskId: 't-abc',
        allowOverlap: true,
        overlapVia: 'conductor',
      });
      expect(logs).toContain('Launched session t-abc-0 (tmux: pup-t-abc-0).');
    });

    it('plans a task recorded as authored by the conductor, not the operator', () => {
      useCwd(initRepo());
      vi.mocked(planTask).mockReturnValue('t-1');

      buildProgram().parse(['plan', 'add', 'fix the thing', '--scope', 'src/**'], {
        from: 'user',
      });

      expect(firstCall(planTask)[1]).toMatchObject({ origin: 'conductor' });
      expect(errors).toEqual([]);
    });

    it('runs `pup new` with the same attribution', () => {
      useCwd(initRepo());
      vi.mocked(createSession).mockReturnValue('t-1-0');

      buildProgram().parse(['new', 'fix the thing', '--scope', 'src/**', '--allow-overlap'], {
        from: 'user',
      });

      expect(firstCall(createSession)[1]).toMatchObject({
        origin: 'conductor',
        overlapVia: 'conductor',
        allowOverlap: true,
      });
    });

    it('kills a session', () => {
      useCwd(initRepo());

      buildProgram().parse(['kill', 's1'], { from: 'user' });

      expect(killSession).toHaveBeenCalledTimes(1);
      expect(errors).toEqual([]);
    });

    // The hard respawn kicks the session off on a `context.md` the conductor's
    // shell can rewrite: the authored kickoff `pup respawn` refuses it.
    it('is refused the hard respawn', () => {
      useCwd(initRepo());

      buildProgram().parse(['kill', 's1', '--respawn'], { from: 'user' });

      expect(hardRespawnSession).not.toHaveBeenCalled();
      expect(killSession).not.toHaveBeenCalled();
      expect(errors).toEqual([
        '`pup kill --respawn` is operator-only; the conductor kills, the operator respawns.',
      ]);
      expect(process.exitCode).toBe(1);
    });

    it('is refused closing a ledger entry', () => {
      const repo = initRepo();
      useCwd(repo);
      const id = seedLedgerEntry(repo);

      buildProgram().parse(['debt', 'close', String(id)], { from: 'user' });

      expect(errors).toEqual([
        '`pup debt close` is operator-only; only the operator retires a ledger entry.',
      ]);
      expect(process.exitCode).toBe(1);
      const { db } = resolveProject(repo);
      expect(db.prepare('SELECT status FROM ledger_entries WHERE id = ?').get(id)).toEqual({
        status: 'open',
      });
    });

    it('is refused the merge, and told the operator merges', () => {
      useCwd(initRepoWithAdapter());

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(runMergeGate).not.toHaveBeenCalled();
      expect(errors).toEqual([
        '`pup merge` is operator-only; the conductor reports a finished branch and the operator merges it.',
      ]);
      expect(process.exitCode).toBe(1);
    });

    it('is refused the respawn', () => {
      useCwd(initRepo());

      buildProgram().parse(['respawn', 's1'], { from: 'user' });

      expect(respawnSession).not.toHaveBeenCalled();
      expect(requestHandoff).not.toHaveBeenCalled();
      expect(errors).toEqual([
        '`pup respawn` is operator-only; the conductor asks the operator to respawn.',
      ]);
      expect(process.exitCode).toBe(1);
    });

    // The conductor is what the blocked session was working for, so its own
    // judgement that the block is dealt with is the one the parking refuses.
    it('is refused the unblock', () => {
      const repo = initRepo();
      useCwd(repo);
      seedBlockedSession(repo, 's1', 'reject cap of 2 reached');

      buildProgram().parse(['unblock', 's1'], { from: 'user' });

      expect(errors).toEqual([
        '`pup unblock` is operator-only; the conductor reports a blocked session and the operator unblocks it.',
      ]);
      expect(process.exitCode).toBe(1);
      const { db } = resolveProject(repo);
      expect(getSession(db, 's1')?.state).toBe('blocked');
      db.close();
    });

    it('is refused another project', () => {
      const repo = initRepo();
      useCwd(repo);
      const other = registerProject(initRepo());

      expect(() => buildProgram().parse(['--project', other, 'status'], { from: 'user' })).toThrow(
        'operator-only',
      );
    });
  });

  describe('new', () => {
    it('requires --scope', () => {
      useCwd(initRepo());

      expect(() => buildProgram().parse(['new', 'do the thing'], { from: 'user' })).toThrow();
      expect(createSession).not.toHaveBeenCalled();
    });

    // Same reason as the sweep: the compile reads the brief, and `pup new`
    // listed only the scope conflict as answerable (decision 57).
    it('refuses in one line when the project brief is over the cap', () => {
      useCwd(initRepo());
      vi.mocked(createSession).mockImplementation(() => {
        throw new InvalidProfileError('The project brief at /s/brief.md is 9000 characters.');
      });

      buildProgram().parse(['new', 'do the thing', '--scope', 'src/**'], { from: 'user' });

      expect(errors).toEqual(['The project brief at /s/brief.md is 9000 characters.']);
      expect(process.exitCode).toBe(1);
    });

    it('compiles the task spec from its options and launches a session', () => {
      useCwd(initRepo());
      vi.mocked(createSession).mockReturnValue('t-abc-0');

      buildProgram().parse(
        [
          'new',
          'do the thing',
          '--scope',
          'src/**',
          'docs/**',
          '--scope-out',
          'src/generated/**',
          '--accept',
          'tests pass',
          '--model',
          'opus',
        ],
        { from: 'user' },
      );

      expect(createSession).toHaveBeenCalledTimes(1);
      const [, request] = firstCall(createSession);
      expect(request).toMatchObject({
        base: DEFAULT_BASE_PROFILE,
        model: 'opus',
        task: {
          goal: 'do the thing',
          scopeIn: ['src/**', 'docs/**'],
          scopeOut: ['src/generated/**'],
          acceptance: ['tests pass'],
        },
      });
      expect(request.task.id as string).toMatch(/^t-/);
      expect(logs).toContain('Launched session t-abc-0 (tmux: pup-t-abc-0).');
      expect(logs).toContain('Attach with: tmux attach -t pup-t-abc-0');
    });

    // `pup new` is `plan add` plus a launch, so guarding only the newer command
    // would leave the same capability open under an older name (decision 40).
    it('is operator-only; a session cannot author a spec through it either', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');

      buildProgram().parse(['new', 'do the thing', '--scope', 'src/**'], { from: 'user' });

      expect(createSession).not.toHaveBeenCalled();
      expect(errors.join('\n')).toContain('operator-only');
      expect(process.exitCode).toBe(1);
    });

    it('passes --allow-overlap through, since `new` is `plan add` plus a launch', () => {
      useCwd(initRepo());
      vi.mocked(createSession).mockReturnValue('t-abc-0');

      buildProgram().parse(['new', 'do the thing', '--scope', 'src/**', '--allow-overlap'], {
        from: 'user',
      });

      expect(firstCall(createSession)[1]).toMatchObject({ allowOverlap: true });
    });

    it('rolls the launch back when the kickoff never lands whole', () => {
      useCwd(initRepo());
      vi.mocked(createSession).mockImplementation(() => {
        throw new SteerNotDeliveredError('t-new-0', 3000);
      });

      buildProgram().parse(['new', 'do the thing', '--scope', 'src/**'], { from: 'user' });

      expect(firstCall(killSession)[1]).toBe('t-new-0');
      expect(errors[0]).toBe('Steer to session t-new-0 did not land: 3000 chars');
      expect(errors[1]).toMatch(
        /^Launch rolled back \(session t-new-0 killed\)\. Re-run `pup launch t-[a-z0-9]+`\.$/,
      );
      expect(process.exitCode).toBe(1);
      expect(logs.join('\n')).not.toContain('Launched session');
    });

    it('reports a scope conflict from `new` and exits 1 rather than throwing', () => {
      useCwd(initRepo());
      vi.mocked(createSession).mockImplementation(() => {
        throw new ScopeConflictError('t-1', [{ sessionId: 's1', files: ['src/a.ts'] }]);
      });

      buildProgram().parse(['new', 'do the thing', '--scope', 'src/**'], { from: 'user' });

      expect(errors.join('\n')).toContain('src/a.ts');
      expect(process.exitCode).toBe(1);
    });

    it('defaults acceptance criteria when --accept is omitted', () => {
      useCwd(initRepo());
      vi.mocked(createSession).mockReturnValue('t-abc-0');

      buildProgram().parse(['new', 'do the thing', '--scope', 'src/**'], { from: 'user' });

      const [, request] = firstCall(createSession);
      expect(request.task.acceptance).toEqual(['goal met and committed']);
    });

    it('throws when run outside any git repo (no project to resolve)', () => {
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() =>
        buildProgram().parse(['new', 'goal', '--scope', 'src/**'], { from: 'user' }),
      ).toThrow();
    });
  });

  describe('steer', () => {
    it('reports no session and does not steer', () => {
      useCwd(initRepo());

      buildProgram().parse(['steer', 'missing-session', 'do X instead'], { from: 'user' });

      expect(errors).toEqual(['No session missing-session.']);
      expect(process.exitCode).toBe(1);
      expect(steerSession).not.toHaveBeenCalled();
    });

    it('steers an existing session and records the event', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');

      buildProgram().parse(['steer', 's1', 'do X instead'], { from: 'user' });

      // By session id through the lifecycle, which resolves the pane recorded
      // at launch; the CLI never forms a tmux target itself (decision 46).
      expect(steerSession).toHaveBeenCalledWith(expect.anything(), 's1', 'do X instead');
      expect(logs).toContain('Steered session s1.');
      expect(process.exitCode).toBeUndefined();

      const { db } = resolveProject(repo);
      const events = db
        .prepare("SELECT type, payload FROM events WHERE session_id = 's1'")
        .all() as { type: string; payload: string }[];
      expect(events).toContainEqual({ type: 'steer', payload: JSON.stringify({ kind: 'manual' }) });
    });

    // A message over the peer socket lands whole and never touches the input
    // box, so nothing is typed; the record is what the report and the
    // last-steer queries read, and it names who sent it (decision 47).
    it.each([
      ['operator', '', ''],
      ['conductor', 'p1', ''],
      // A session pup can identify is named as one, whatever else it exports.
      ['session:s1', 'p1', 's1'],
    ])(
      'records a steer already sent by message, by the %s, and types nothing',
      (by, conductor, session) => {
        const repo = initRepo();
        useCwd(repo);
        seedSession(repo, 's1');
        vi.stubEnv('PUP_CONDUCTOR', conductor);
        vi.stubEnv('PUP_SESSION_ID', session);

        buildProgram().parse(['steer', 's1', 'do X instead', '--sent'], { from: 'user' });

        expect(steerSession).not.toHaveBeenCalled();
        expect(logs).toContain('Recorded a message steer to session s1.');
        const { db } = resolveProject(repo);
        const events = db
          .prepare("SELECT type, payload FROM events WHERE session_id = 's1'")
          .all() as { type: string; payload: string }[];
        expect(events).toEqual([
          { type: 'steer', payload: JSON.stringify({ kind: 'message', by }) },
        ]);
      },
    );

    it('refuses a terminal session', () => {
      const repo = initRepo();
      useCwd(repo);
      seedKilledSession(repo, 's1');

      buildProgram().parse(['steer', 's1', 'do X instead'], { from: 'user' });

      expect(errors).toEqual(['Session s1 is killed; nothing to steer.']);
      expect(process.exitCode).toBe(1);
      expect(steerSession).not.toHaveBeenCalled();
    });

    it('exits 1 with the named message, and records no steer, when the paste never lands', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.mocked(steerSession).mockImplementation(() => {
        throw new SteerNotDeliveredError('s1', 3000);
      });

      buildProgram().parse(['steer', 's1', 'a'.repeat(3000)], { from: 'user' });

      expect(errors).toEqual(['Steer to session s1 did not land: 3000 chars']);
      expect(process.exitCode).toBe(1);
      expect(logs).not.toContain('Steered session s1.');
      const { db } = resolveProject(repo);
      expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 's1'").get()).toEqual({
        n: 0,
      });
    });

    it('exits 1 with the named message, and records no steer, when the launch pane is gone', () => {
      // The pane pinned at launch no longer exists; nothing was pasted into
      // whatever pane the session now shows (decision 46).
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.mocked(steerSession).mockImplementation(() => {
        throw new SessionPaneMissingError('s1', '%3', 'gone');
      });

      buildProgram().parse(['steer', 's1', 'do X instead'], { from: 'user' });

      expect(errors).toEqual(["Session s1's pane %3 no longer exists; nothing was sent."]);
      expect(process.exitCode).toBe(1);
      expect(logs).not.toContain('Steered session s1.');
      const { db } = resolveProject(repo);
      expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 's1'").get()).toEqual({
        n: 0,
      });
    });
  });

  describe('interrupt', () => {
    function sessionEvents(repo: string, sessionId: string): { type: string; payload: string }[] {
      const { db } = resolveProject(repo);
      return db.prepare('SELECT type, payload FROM events WHERE session_id = ?').all(sessionId) as {
        type: string;
        payload: string;
      }[];
    }

    it('reports no session and touches neither tmux nor the event log', () => {
      useCwd(initRepo());

      buildProgram().parse(['interrupt', 'missing-session'], { from: 'user' });

      expect(errors).toEqual(['No session missing-session.']);
      expect(process.exitCode).toBe(1);
      expect(interruptSession).not.toHaveBeenCalled();
      expect(steerSession).not.toHaveBeenCalled();
    });

    it('sends Escape before steering when a message is given, and records a steered interrupt', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');

      buildProgram().parse(['interrupt', 's1', 'retry the fetch'], { from: 'user' });

      expect(interruptSession).toHaveBeenCalledWith(expect.anything(), 's1');
      expect(steerSession).toHaveBeenCalledWith(expect.anything(), 's1', 'retry the fetch');
      // The whole point of `interrupt <sid> "msg"` over `steer` is Escape lands
      // FIRST, so the steer is not queued behind the hung tool call.
      const escapeOrder = vi.mocked(interruptSession).mock.invocationCallOrder[0];
      const steerOrder = vi.mocked(steerSession).mock.invocationCallOrder[0];
      expect(escapeOrder).toBeLessThan(steerOrder as number);
      expect(logs).toContain('Interrupted and steered session s1.');
      expect(process.exitCode).toBeUndefined();
      const events = sessionEvents(repo, 's1');
      expect(events).toContainEqual({
        type: 'interrupt',
        payload: JSON.stringify({ steered: true }),
      });
      // The delivered message is a real steer — logged as one too, so a
      // last-steer query cannot miss steers that arrived via interrupt.
      expect(events).toContainEqual({
        type: 'steer',
        payload: JSON.stringify({ kind: 'interrupt' }),
      });
    });

    it('refuses a terminal session without touching tmux', () => {
      const repo = initRepo();
      useCwd(repo);
      seedKilledSession(repo, 's1');

      buildProgram().parse(['interrupt', 's1', 'retry the fetch'], { from: 'user' });

      expect(errors).toEqual(['Session s1 is killed; nothing to interrupt.']);
      expect(process.exitCode).toBe(1);
      expect(interruptSession).not.toHaveBeenCalled();
      expect(steerSession).not.toHaveBeenCalled();
    });

    it('records the interrupt but not the steer, and exits 1, when the message never lands', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.mocked(steerSession).mockImplementation(() => {
        throw new SteerNotDeliveredError('s1', 3000);
      });

      buildProgram().parse(['interrupt', 's1', 'retry the fetch'], { from: 'user' });

      // Escape had already landed when the paste was refused.
      expect(interruptSession).toHaveBeenCalledWith(expect.anything(), 's1');
      expect(errors).toEqual(['Steer to session s1 did not land: 3000 chars']);
      expect(process.exitCode).toBe(1);
      expect(sessionEvents(repo, 's1')).toEqual([
        { type: 'interrupt', payload: JSON.stringify({ steered: false }) },
      ]);
    });

    it('does not steer when no message is given', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');

      buildProgram().parse(['interrupt', 's1'], { from: 'user' });

      expect(interruptSession).toHaveBeenCalledWith(expect.anything(), 's1');
      expect(steerSession).not.toHaveBeenCalled();
      expect(logs).toContain('Interrupted session s1.');
      expect(process.exitCode).toBeUndefined();
      expect(sessionEvents(repo, 's1')).toContainEqual({
        type: 'interrupt',
        payload: JSON.stringify({ steered: false }),
      });
    });

    it('records nothing, and does not steer, when the launch pane is gone before Escape', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.mocked(interruptSession).mockImplementation(() => {
        throw new SessionPaneMissingError('s1', '%3', 'gone');
      });

      buildProgram().parse(['interrupt', 's1', 'retry the fetch'], { from: 'user' });

      // Escape never landed, so there is no interrupt to put on record, and
      // the steer is not attempted into a pane that is not there.
      expect(errors).toEqual(["Session s1's pane %3 no longer exists; nothing was sent."]);
      expect(process.exitCode).toBe(1);
      expect(steerSession).not.toHaveBeenCalled();
      expect(sessionEvents(repo, 's1')).toEqual([]);
    });
  });

  describe('kill', () => {
    it('kills a session', () => {
      useCwd(initRepo());

      buildProgram().parse(['kill', 's1'], { from: 'user' });

      expect(killSession).toHaveBeenCalledTimes(1);
      const [, sessionId] = firstCall(killSession);
      expect(sessionId).toBe('s1');
      expect(logs).toContain('Killed session s1.');
      expect(process.exitCode).toBeUndefined();
    });

    it('hard-respawns instead of killing when --respawn is passed', () => {
      useCwd(initRepo());

      buildProgram().parse(['kill', 's1', '--respawn'], { from: 'user' });

      expect(hardRespawnSession).toHaveBeenCalledTimes(1);
      expect(killSession).not.toHaveBeenCalled();
      expect(logs).toContain('Hard-respawned session s1 (tmux: pup-s1).');
    });

    it('reports the error and exits 1 when the hard respawn fails', () => {
      useCwd(initRepo());
      vi.mocked(hardRespawnSession).mockImplementation(() => {
        throw new Error('worktree is dirty');
      });

      buildProgram().parse(['kill', 's1', '--respawn'], { from: 'user' });

      expect(errors).toEqual(['worktree is dirty']);
      expect(process.exitCode).toBe(1);
      expect(logs).toEqual([]);
    });

    // `killed` releases the scope and returns the task to the backlog (decision
    // 40), so an open `kill` let a session clear the way for any launch; the
    // guard covers `--respawn` too, the same authority over another window
    // (decisions 26, 42).
    it.each([
      ['', []],
      [' --respawn', ['--respawn']],
    ])('refuses `kill%s` when a session is calling', (_label, flags) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');

      buildProgram().parse(['kill', 's2', ...flags], { from: 'user' });

      expect(killSession).not.toHaveBeenCalled();
      expect(hardRespawnSession).not.toHaveBeenCalled();
      expect(errors).toEqual(['`pup kill` is operator-only; sessions cannot kill sessions.']);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
    });
  });

  // Decision 7 parks a session for a human but left the human no command: the
  // gate refuses a blocked session, `kill --respawn` and `respawn` both want
  // `running`, and `pup session done` is an illegal transition — so the only
  // way back was a hand-written transitionSession call (decision 45's addendum).
  describe('unblock', () => {
    function stateOf(repoPath: string, sessionId: string): string {
      const { db } = resolveProject(repoPath);
      const state = getSession(db, sessionId)?.state;
      db.close();
      return state ?? 'gone';
    }

    function unblockEvent(repoPath: string, sessionId: string): Record<string, unknown> {
      const { db } = resolveProject(repoPath);
      const events = listEvents(db, sessionId).map(
        (event) => JSON.parse(event.payload) as Record<string, unknown>,
      );
      db.close();
      const unblock = events.find((payload) => payload.kind === 'operator-unblock');
      if (!unblock) throw new Error('expected an operator-unblock event');
      return unblock;
    }

    it('returns a blocked session to running, and says what it was blocked for', () => {
      const repo = initRepo();
      useCwd(repo);
      seedBlockedSession(repo, 's1', 'reject cap of 2 reached');

      buildProgram().parse(['unblock', 's1'], { from: 'user' });

      expect(stateOf(repo, 's1')).toBe('running');
      expect(unblockEvent(repo, 's1')).toMatchObject({
        kind: 'operator-unblock',
        from: 'blocked',
        to: 'running',
      });
      expect(logs[0]).toBe('Session s1 was blocked: reject cap of 2 reached');
      expect(errors).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    });

    // The refusal decision 45's addendum records is 2000 characters of raw SGR
    // away from the pane that produced it; the reason it leaves behind is text
    // the session's own output shaped, so it is sanitized before it is printed.
    it('flattens control characters out of the reason it prints', () => {
      const repo = initRepo();
      useCwd(repo);
      seedBlockedSession(repo, 's1', 'Steer to s1 did not land:\u001b[31m 2431\nchars');

      buildProgram().parse(['unblock', 's1'], { from: 'user' });

      expect(logs[0]).toBe('Session s1 was blocked: Steer to s1 did not land: [31m 2431 chars');
    });

    it('says so when the block carried no reason', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      const { db } = resolveProject(repo);
      transitionSession(db, 's1', 'running');
      transitionSession(db, 's1', 'blocked');
      db.close();

      buildProgram().parse(['unblock', 's1'], { from: 'user' });

      expect(logs[0]).toBe('Session s1 was blocked: (no reason recorded)');
      expect(stateOf(repo, 's1')).toBe('running');
    });

    it('records the operator reason on the event', () => {
      const repo = initRepo();
      useCwd(repo);
      seedBlockedSession(repo, 's1', 'reject cap of 2 reached');

      buildProgram().parse(['unblock', 's1', '--reason', 'typed the report in by hand'], {
        from: 'user',
      });

      expect(unblockEvent(repo, 's1')).toMatchObject({
        kind: 'operator-unblock',
        reason: 'typed the report in by hand',
      });
    });

    // Rolling the count back would let one failure loop through the gate for
    // ever; keeping it means the operator is told the next failure re-parks it.
    it('keeps the reject count, and warns that the next failure parks it again', () => {
      const repo = initRepo();
      useCwd(repo);
      seedBlockedSession(repo, 's1', 'reject cap of 2 reached', 3);

      buildProgram().parse(['unblock', 's1'], { from: 'user' });

      const { db } = resolveProject(repo);
      expect(getSession(db, 's1')?.reject_count).toBe(3);
      db.close();
      expect(logs).toContain(
        'Unblocked s1; it is running again. Its 3 rejections are kept, so the next gate failure parks it again.',
      );
      expect(logs).toContain('Its window is untouched — `pup kill --respawn s1` if it is gone.');
    });

    // A refused re-steer parks a session at any count, and one under the cap
    // has rejections left — saying otherwise would send the operator to
    // `pup kill` for a session the gate would still take.
    it('omits the warning when the session was parked under the cap', () => {
      const repo = initRepo();
      useCwd(repo);
      seedBlockedSession(repo, 's1', 're-steer failed — session unreachable', 1);

      buildProgram().parse(['unblock', 's1'], { from: 'user' });

      expect(logs).toContain('Unblocked s1; it is running again.');
    });

    // Every state but `blocked`, reached the way the state machine allows, so
    // the refusal covers the whole surface and not just the neighbouring one.
    it.each([
      ['queued', []],
      ['running', ['running']],
      ['awaiting-review', ['running', 'awaiting-review']],
      ['merged', ['running', 'awaiting-review', 'merged']],
      ['rejected', ['running', 'awaiting-review', 'rejected']],
      ['killed', ['killed']],
    ] as [SessionState, SessionState[]][])(
      'refuses a session that is %s, not blocked',
      (state, steps) => {
        const repo = initRepo();
        useCwd(repo);
        seedSession(repo, 's1');
        const { db } = resolveProject(repo);
        for (const step of steps) transitionSession(db, 's1', step);
        db.close();

        buildProgram().parse(['unblock', 's1'], { from: 'user' });

        expect(errors).toEqual([`Session s1 is ${state}; only blocked sessions unblock.`]);
        expect(logs).toEqual([]);
        expect(process.exitCode).toBe(1);
        expect(stateOf(repo, 's1')).toBe(state);
      },
    );

    it('refuses a session it has never heard of', () => {
      useCwd(initRepo());

      buildProgram().parse(['unblock', 's1'], { from: 'user' });

      expect(errors).toEqual(['No session s1.']);
      expect(process.exitCode).toBe(1);
    });

    // Releasing decision 7's parking brake is the one judgement the parking
    // exists to ask a human for, so the session it parked cannot make it.
    it('refuses when a session is calling', () => {
      const repo = initRepo();
      useCwd(repo);
      seedBlockedSession(repo, 's1', 'reject cap of 2 reached');
      seedSession(repo, 's2');
      vi.stubEnv('PUP_SESSION_ID', 's2');

      buildProgram().parse(['unblock', 's1'], { from: 'user' });

      expect(errors).toEqual(['`pup unblock` is operator-only; sessions cannot unblock sessions.']);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(stateOf(repo, 's1')).toBe('blocked');
    });
  });

  describe('respawn', () => {
    it('respawns immediately when the handoff is already ready', () => {
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(true);

      buildProgram().parse(['respawn', 's1'], { from: 'user' });

      expect(requestHandoff).not.toHaveBeenCalled();
      expect(respawnSession).toHaveBeenCalledTimes(1);
      expect(logs).toContain('Respawned s1 on a fresh context window with its handoff.');
      expect(process.exitCode).toBeUndefined();
    });

    it('requests and awaits a handoff before respawning when not yet ready', () => {
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(false);
      vi.mocked(requestHandoff).mockReturnValue('/tmp/handoff.md');
      vi.mocked(awaitHandoffReady).mockReturnValue(true);

      buildProgram().parse(['respawn', 's1'], { from: 'user' });

      expect(requestHandoff).toHaveBeenCalledTimes(1);
      expect(logs).toContain(
        'Handoff requested; waiting for the session to write /tmp/handoff.md …',
      );
      expect(awaitHandoffReady).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        's1',
        HANDOFF_WAIT_DEFAULT_MS,
      );
      expect(respawnSession).toHaveBeenCalledTimes(1);
      expect(logs).toContain('Respawned s1 on a fresh context window with its handoff.');
    });

    it('exits 1 with the named message when the handoff request never lands', () => {
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(false);
      vi.mocked(requestHandoff).mockImplementation(() => {
        throw new SteerNotDeliveredError('s1', 3000);
      });

      buildProgram().parse(['respawn', 's1'], { from: 'user' });

      expect(errors).toEqual([
        'Steer to session s1 did not land: 3000 chars',
        'Re-run `pup respawn s1`.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(respawnSession).not.toHaveBeenCalled();
    });

    it('exits 1 with the named message when the relaunch kickoff never lands', () => {
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(true);
      vi.mocked(respawnSession).mockImplementation(() => {
        throw new SteerNotDeliveredError('s1', 3000);
      });

      buildProgram().parse(['respawn', 's1'], { from: 'user' });

      expect(errors).toEqual([
        'Steer to session s1 did not land: 3000 chars',
        'Re-run `pup respawn s1`.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(logs.join('\n')).not.toContain('Respawned s1');
    });

    it('points at the hard respawn, not a re-run, when the launch pane is gone', () => {
      // Asking again cannot help: the handoff request has no pane to land in.
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(false);
      vi.mocked(requestHandoff).mockImplementation(() => {
        throw new SessionPaneMissingError('s1', '%3', 'gone');
      });

      buildProgram().parse(['respawn', 's1'], { from: 'user' });

      expect(errors).toEqual([
        "Session s1's pane %3 no longer exists; nothing was sent.",
        'Relaunch it without a handoff: `pup kill --respawn s1`.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(respawnSession).not.toHaveBeenCalled();
    });

    it('forwards a custom --wait as milliseconds', () => {
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(false);
      vi.mocked(requestHandoff).mockReturnValue('/tmp/handoff.md');
      vi.mocked(awaitHandoffReady).mockReturnValue(true);

      buildProgram().parse(['respawn', 's1', '--wait', '30'], { from: 'user' });

      expect(awaitHandoffReady).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        's1',
        30_000,
      );
    });

    it('reports and exits 1 when the handoff never arrives', () => {
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(false);
      vi.mocked(requestHandoff).mockReturnValue('/tmp/handoff.md');
      vi.mocked(awaitHandoffReady).mockReturnValue(false);

      buildProgram().parse(['respawn', 's1'], { from: 'user' });

      expect(respawnSession).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([
        expect.stringContaining('Session s1 has not signalled handoff-done yet'),
      ]);
    });

    // A respawn kicks another session off with whatever its handoff file says,
    // so a session that could respawn could author another's context (decision 44).
    it('refuses when a session is calling', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');
      vi.mocked(isHandoffReady).mockReturnValue(true);

      buildProgram().parse(['respawn', 's2'], { from: 'user' });

      expect(requestHandoff).not.toHaveBeenCalled();
      expect(respawnSession).not.toHaveBeenCalled();
      expect(errors).toEqual(['`pup respawn` is operator-only; sessions cannot respawn sessions.']);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
    });
  });

  describe('report', () => {
    it('writes a self-contained report.html into the project dir and echoes the path', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');

      buildProgram().parse(['report'], { from: 'user' });

      const outFile = join(projectPaths(repo).root, 'report.html');
      expect(logs).toContain(`Report written to ${outFile}`);
      const html = readFileSync(outFile, 'utf8');
      expect(html).toContain('<!doctype html>');
      expect(html).not.toMatch(/<script[^>]+src=/);
      expect(process.exitCode).toBeUndefined();
    });

    it('writes one dossier page per session alongside the index', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');

      buildProgram().parse(['report'], { from: 'user' });

      const dossier = readFileSync(join(projectPaths(repo).root, 'session-s1.html'), 'utf8');
      expect(dossier).toContain('<!doctype html>');
      expect(logs).toContain('1 session dossier alongside.');
    });

    it('throws when run outside any git repo (no project to resolve)', () => {
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() => buildProgram().parse(['report'], { from: 'user' })).toThrow();
    });
  });

  describe('debt', () => {
    it('reports no open ledger entries', () => {
      useCwd(initRepo());

      buildProgram().parse(['debt'], { from: 'user' });

      expect(logs).toContain('No open ledger entries.');
    });

    it('prints open ledger entries', () => {
      const repo = initRepo();
      useCwd(repo);
      const id = seedLedgerEntry(repo);

      buildProgram().parse(['debt'], { from: 'user' });

      expect(logs.some((l) => l.includes(`#${id}`) && l.includes('shortcut taken'))).toBe(true);
      expect(
        logs.some(
          (l) =>
            l.includes('reason: ship the demo') &&
            l.includes('review by: before the next release') &&
            l.includes('accepted by: human'),
        ),
      ).toBe(true);
    });

    describe('close', () => {
      it('closes an open ledger entry', () => {
        const repo = initRepo();
        useCwd(repo);
        const id = seedLedgerEntry(repo);

        buildProgram().parse(['debt', 'close', String(id)], { from: 'user' });

        expect(logs).toContain(`Closed ledger entry #${id}.`);
        expect(process.exitCode).toBeUndefined();
      });

      it('reports and exits 1 for a non-existent or already-closed entry', () => {
        useCwd(initRepo());

        buildProgram().parse(['debt', 'close', '999'], { from: 'user' });

        expect(errors).toEqual(['No open ledger entry #999.']);
        expect(process.exitCode).toBe(1);
      });
    });
  });

  describe('--project', () => {
    it('selects a registered project from outside any repo, before or after the command', () => {
      const repoA = initRepo();
      const repoB = initRepo();
      seedBacklogTask(repoA, 't-a', 'planned in A');
      const idB = registerProject(repoB);
      useCwd(tempDir('pup-cli-noproj-'));

      buildProgram().parse(['--project', idB, 'status'], { from: 'user' });
      buildProgram().parse(['status', '--project', idB], { from: 'user' });

      expect(logs).toEqual([
        'Nothing running and nothing planned.',
        'Nothing running and nothing planned.',
      ]);
      expect(process.exitCode).toBeUndefined();
    });

    it('wins over the repo around cwd', () => {
      const repoA = initRepo();
      seedBacklogTask(repoA, 't-a', 'planned in A');
      useCwd(initRepo());

      buildProgram().parse(['--project', projectId(repoA), 'status'], { from: 'user' });

      expect(logs.join('\n')).toContain('planned in A');
    });

    it('refuses an unknown id in one line', () => {
      const id = registerProject(initRepo());
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() =>
        buildProgram().parse(['--project', 'ghost', 'status'], { from: 'user' }),
      ).toThrow(new ProjectResolutionError(`No project ghost; registered projects: ${id}.`));
    });

    // Every operator-only guard asks `callingSession` of the store it was
    // handed; a session handed another project's store is unknown there, so
    // `--project` itself is operator-only (decision 43).
    it('refuses a session calling from its worktree, before any command runs', () => {
      const own = initRepo();
      const worktree = join(own, '.worktrees', 's1');
      mkdirSync(worktree, { recursive: true });
      seedSession(own, 's1', worktree);
      const other = registerProject(initRepo());
      useCwd(worktree);

      expect(() =>
        buildProgram().parse(['--project', other, 'plan', 'add', 'goal', '--scope', 'src/**'], {
          from: 'user',
        }),
      ).toThrow(
        new ProjectResolutionError(
          'Reaching another project is operator-only; a session controls only the project it runs in.',
        ),
      );
      expect(planTask).not.toHaveBeenCalled();
    });

    it('refuses a session declared by PUP_SESSION_ID from its own repo', () => {
      const own = initRepo();
      seedSession(own, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');
      const other = registerProject(initRepo());
      useCwd(own);

      expect(() => buildProgram().parse(['--project', other, 'status'], { from: 'user' })).toThrow(
        'operator-only',
      );
    });

    // Outside every repo there is no own store to find the session in, so the
    // variable alone refuses; decision 42's ceiling needed both leaving the
    // worktree and unsetting it, and this keeps it so.
    it('refuses a session that left every repo but still exports PUP_SESSION_ID', () => {
      registerProject(initRepo());
      const other = registerProject(initRepo());
      vi.stubEnv('PUP_SESSION_ID', 's-elsewhere');
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() =>
        buildProgram().parse(['--project', other, 'plan', 'add', 'goal', '--scope', 'src/**'], {
          from: 'user',
        }),
      ).toThrow('operator-only');
      expect(planTask).not.toHaveBeenCalled();
    });

    // The store's auto-select is the same door as `--project`: another
    // project's store, where the session's guards cannot find it.
    it('refuses a session outside every repo even when the store would auto-select', () => {
      const only = initRepo();
      registerProject(only);
      vi.stubEnv('PUP_SESSION_ID', 's-elsewhere');
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() =>
        buildProgram().parse(['plan', 'add', 'goal', '--scope', 'src/**'], { from: 'user' }),
      ).toThrow('operator-only');
      expect(planTask).not.toHaveBeenCalled();
    });

    it('lets an operator inside one repo author work in another', () => {
      const other = initRepo();
      const otherId = registerProject(other);
      vi.mocked(planTask).mockReturnValue('t-abc');
      useCwd(initRepo());

      buildProgram().parse(['--project', otherId, 'plan', 'add', 'goal', '--scope', 'src/**'], {
        from: 'user',
      });

      expect(firstCall(planTask)[1]).toMatchObject({ repoPath: other });
      expect(process.exitCode).toBeUndefined();
    });

    // The fleet readers' refusal, on the door that names one project: a store
    // keyed to the operator's repo path plus a slash is never opened, and so
    // never migrated or read as the real project (decisions 61, 65).
    it('refuses a planted project whose path is a variant of a registered repo', () => {
      const real = initRepo();
      registerProject(real);
      const variant = `${real}/`;
      const plantedId = projectId(variant);
      const plantedStore = join(home, '.pupitre', plantedId, 'state.db');
      mkdirSync(join(home, '.pupitre', plantedId), { recursive: true });
      const bare = new Database(plantedStore);
      bare.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, repo_path TEXT NOT NULL)');
      bare.prepare('INSERT INTO projects VALUES (?, ?)').run(plantedId, variant);
      bare.close();
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() =>
        buildProgram().parse(['--project', plantedId, 'status'], { from: 'user' }),
      ).toThrow(
        new ProjectResolutionError(
          `Project ${plantedId} is registered at ${variant}, which is not its own path: a variant of a repo path, never opened.`,
        ),
      );
      expect(logs).toEqual([]);
      const check = new Database(plantedStore, { readonly: true });
      const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[];
      check.close();
      expect(tables.map((table) => table.name)).toEqual(['projects']);
    });

    it('reaches commands that read the project dir, not only the store', () => {
      const id = registerProject(initRepo());
      useCwd(tempDir('pup-cli-noproj-'));

      buildProgram().parse(['--project', id, 'profile', 'list'], { from: 'user' });

      expect(logs.some((l) => l.startsWith(DEFAULT_BASE_PROFILE.name))).toBe(true);
    });
  });

  // The entry point maps what escaped parse to an exit code; tests drive parse
  // in-process, so this is the only place the one-line contract is checked.
  describe('fatalExitCode', () => {
    it('prints a project resolution failure as one message and exits 1', () => {
      expect(fatalExitCode(new ProjectResolutionError('No project ghost.'))).toBe(1);

      expect(errors).toEqual(['No project ghost.']);
    });

    it("keeps commander's own exit code, whose message is already written", () => {
      expect(fatalExitCode(new CommanderError(2, 'commander.unknownOption', 'unknown'))).toBe(2);

      expect(errors).toEqual([]);
    });

    it('rethrows anything else, so a bug still crashes with its stack', () => {
      const bug = new TypeError('undefined is not a function');

      expect(() => fatalExitCode(bug)).toThrow(bug);
    });
  });

  describe('profile', () => {
    it('lists the built-in base layer when no profiles are compiled yet', () => {
      useCwd(initRepo());

      buildProgram().parse(['profile', 'list'], { from: 'user' });

      expect(logs.some((l) => l.startsWith('NAME'))).toBe(true);
      expect(logs.some((l) => l.startsWith(DEFAULT_BASE_PROFILE.name))).toBe(true);
    });

    it('shows the built-in base layer', () => {
      useCwd(initRepo());

      buildProgram().parse(['profile', 'show', 'base'], { from: 'user' });

      expect(logs.some((l) => l.includes('name: base'))).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });

    it('reports and exits 1 for an unknown layer', () => {
      useCwd(initRepo());

      buildProgram().parse(['profile', 'show', 'ghost'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('No profile layer `ghost`')]);
    });

    it('requires a name for `profile show`', () => {
      useCwd(initRepo());

      buildProgram().parse(['profile', 'show'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual(['Usage: pup profile show <name>']);
    });

    it.each(['edit', 'stale'])('reports `%s` as not implemented yet', (action) => {
      useCwd(initRepo());

      buildProgram().parse(['profile', action], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([`pup profile ${action}: not implemented yet`]);
    });

    it('reports an unknown action', () => {
      useCwd(initRepo());

      buildProgram().parse(['profile', 'bogus'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual(['Unknown profile action `bogus` (expected list|show|edit|stale).']);
    });
  });

  describe('session', () => {
    describe('done', () => {
      it('requires PUP_SESSION_ID', () => {
        useCwd(initRepo());
        vi.stubEnv('PUP_SESSION_ID', '');

        buildProgram().parse(['session', 'done', 'summary'], { from: 'user' });

        expect(process.exitCode).toBe(1);
        expect(errors).toEqual([
          'pup session done must run inside a Pupitre session (PUP_SESSION_ID unset).',
        ]);
        expect(markSessionDone).not.toHaveBeenCalled();
      });

      it('marks the session done from inside its own worktree', () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(worktreeOf(repo, 's1'));
        vi.stubEnv('PUP_SESSION_ID', 's1');

        buildProgram().parse(['session', 'done', 'shipped the thing'], { from: 'user' });

        expect(markSessionDone).toHaveBeenCalledTimes(1);
        const [, sessionId, summary] = firstCall(markSessionDone);
        expect(sessionId).toBe('s1');
        expect(summary).toBe('shipped the thing');
        expect(logs).toContain('Session s1 marked done: shipped the thing');
        expect(process.exitCode).toBeUndefined();
      });

      // `PUP_SESSION_ID` is the session's own word; the worktree around cwd is
      // decision 26's detection, and the match is required, not only the absence
      // of a contradiction: a session that exports a running victim's id from
      // the repo root is inside no worktree at all (decision 44).
      it('refuses an id that names no session instead of throwing from the store', () => {
        const repo = initRepo();
        useCwd(worktreeOf(repo, 'ghost'));
        vi.stubEnv('PUP_SESSION_ID', 'ghost');

        buildProgram().parse(['session', 'done', 'shipped the thing'], { from: 'user' });

        expect(markSessionDone).not.toHaveBeenCalled();
        expect(errors).toEqual(['pup session done: PUP_SESSION_ID names no session (ghost).']);
        expect(process.exitCode).toBe(1);
      });

      // The refusal echoes a value only the session set, the one message here
      // the store did not validate first (decision 29).
      it('sanitizes a bogus id before echoing it', () => {
        const repo = initRepo();
        useCwd(repo);
        vi.stubEnv('PUP_SESSION_ID', 'gh\u001b[2Kost\u0007');

        buildProgram().parse(['session', 'done', 'shipped the thing'], { from: 'user' });

        expect(markSessionDone).not.toHaveBeenCalled();
        expect(errors).toEqual(['pup session done: PUP_SESSION_ID names no session (gh [2Kost).']);
      });

      it('refuses from the repo root, inside no worktree', () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(repo);
        vi.stubEnv('PUP_SESSION_ID', 's1');

        buildProgram().parse(['session', 'done', 'shipped the thing'], { from: 'user' });

        expect(markSessionDone).not.toHaveBeenCalled();
        expect(errors).toEqual([
          "`pup session done` reports only its own session; this directory is not inside s1's worktree.",
        ]);
        expect(logs).toEqual([]);
        expect(process.exitCode).toBe(1);
      });

      it('refuses when the worktree around cwd belongs to another session', () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        seedSession(repo, 's2');
        useCwd(worktreeOf(repo, 's2'));
        vi.stubEnv('PUP_SESSION_ID', 's1');

        buildProgram().parse(['session', 'done', 'shipped the thing'], { from: 'user' });

        expect(markSessionDone).not.toHaveBeenCalled();
        expect(errors).toEqual([
          '`pup session done` reports only its own session; this worktree belongs to s2, not s1.',
        ]);
        expect(logs).toEqual([]);
        expect(process.exitCode).toBe(1);
      });
    });

    describe('handoff-done', () => {
      it('requires PUP_SESSION_ID', () => {
        useCwd(initRepo());
        vi.stubEnv('PUP_SESSION_ID', '');

        buildProgram().parse(['session', 'handoff-done'], { from: 'user' });

        expect(process.exitCode).toBe(1);
        expect(errors).toEqual([
          'pup session handoff-done must run inside a Pupitre session (PUP_SESSION_ID unset).',
        ]);
        expect(markHandoffReady).not.toHaveBeenCalled();
      });

      it('records the handoff from inside its own worktree', () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(worktreeOf(repo, 's1'));
        vi.stubEnv('PUP_SESSION_ID', 's1');

        buildProgram().parse(['session', 'handoff-done'], { from: 'user' });

        expect(markHandoffReady).toHaveBeenCalledTimes(1);
        const [, , sessionId] = firstCall(markHandoffReady);
        expect(sessionId).toBe('s1');
        expect(logs).toContain('Session s1 handoff recorded; Pupitre will respawn you shortly.');
        expect(process.exitCode).toBeUndefined();
      });

      // Signalling for a document that is not there would otherwise arm a
      // respawn on whatever writes that path next (decision 49).
      it('refuses when the document it is signalling for was never written', () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(worktreeOf(repo, 's1'));
        vi.stubEnv('PUP_SESSION_ID', 's1');
        vi.mocked(markHandoffReady).mockImplementation(() => {
          throw new HandoffMissingError('s1', '/state/s1/handoff.md');
        });

        buildProgram().parse(['session', 'handoff-done'], { from: 'user' });

        expect(errors).toEqual(['No handoff at /state/s1/handoff.md for s1.']);
        expect(logs).toEqual([]);
        expect(process.exitCode).toBe(1);
      });

      it('refuses from the repo root, inside no worktree', () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(repo);
        vi.stubEnv('PUP_SESSION_ID', 's1');

        buildProgram().parse(['session', 'handoff-done'], { from: 'user' });

        expect(markHandoffReady).not.toHaveBeenCalled();
        expect(errors).toEqual([
          "`pup session handoff-done` reports only its own session; this directory is not inside s1's worktree.",
        ]);
        expect(process.exitCode).toBe(1);
      });

      it('refuses when the worktree around cwd belongs to another session', () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        seedSession(repo, 's2');
        useCwd(worktreeOf(repo, 's2'));
        vi.stubEnv('PUP_SESSION_ID', 's1');

        buildProgram().parse(['session', 'handoff-done'], { from: 'user' });

        expect(markHandoffReady).not.toHaveBeenCalled();
        expect(errors).toEqual([
          '`pup session handoff-done` reports only its own session; this worktree belongs to s2, not s1.',
        ]);
        expect(process.exitCode).toBe(1);
      });
    });
  });

  describe('merge', () => {
    function mergedOutcome(overrides: Partial<MergeOutcome> = {}): MergeOutcome {
      return {
        status: 'merged',
        report: { sessionId: 's1', passed: true, sandbox: 'sandbox-exec (macOS)', stages: [] },
        rejectCount: 0,
        ...overrides,
      };
    }

    /**
     * The gate's lock is a directory released in a `finally`, which a process
     * killed by a signal never reaches — Ctrl-C at the terminal, or the SIGTERM
     * `pup ui`'s `q` sends this child. Left behind, it refuses every later
     * merge on behalf of a run that is long gone.
     */
    describe('the lock a signal would otherwise strand', () => {
      /** The signal listeners `merge` added, and the lock path it guards. */
      function runMergeUnderSignals(repo: string): {
        handlers: NodeJS.SignalsListener[];
        lockPath: string;
      } {
        const before = process.listeners('SIGINT');
        vi.mocked(runMergeGate).mockImplementation(() => {
          // Inside the gate: the listeners are live and the lock is held.
          mkdirSync(join(repo, '.git', MERGE_LOCK_DIRNAME), { recursive: true });
          handlers = process
            .listeners('SIGINT')
            .filter((fn) => !before.includes(fn)) as NodeJS.SignalsListener[];
          throw new Error('interrupted');
        });
        let handlers: NodeJS.SignalsListener[] = [];
        buildProgram().parse(['merge', 's1'], { from: 'user' });
        return { handlers, lockPath: join(repo, '.git', MERGE_LOCK_DIRNAME) };
      }

      it('removes the lock this run took, and exits', () => {
        const repo = initRepoWithAdapter();
        useCwd(repo);
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        const { handlers, lockPath } = runMergeUnderSignals(repo);
        expect(handlers).toHaveLength(1);
        handlers[0]?.('SIGINT');

        expect(existsSync(lockPath)).toBe(false);
        expect(exit).toHaveBeenCalledWith(130);
      });

      // A lock that was already there belongs to another merge, and removing it
      // would hand that run's exclusion to whoever interrupted this one.
      it('leaves a lock it found already held', () => {
        const repo = initRepoWithAdapter();
        useCwd(repo);
        mkdirSync(join(repo, '.git', MERGE_LOCK_DIRNAME), { recursive: true });
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        const { handlers, lockPath } = runMergeUnderSignals(repo);
        handlers[0]?.('SIGTERM');

        expect(existsSync(lockPath)).toBe(true);
      });

      // Once the gate has returned it has released its own lock, so a later
      // signal must not reach a handler that would delete the next run's.
      it('takes its handlers off again when the gate returns', () => {
        const repo = initRepoWithAdapter();
        useCwd(repo);
        const before = process.listeners('SIGINT').length;

        vi.mocked(runMergeGate).mockReturnValue(mergedOutcome());
        buildProgram().parse(['merge', 's1'], { from: 'user' });

        expect(process.listeners('SIGINT')).toHaveLength(before);
      });
    });

    it('rejects --accept-debt without --review-by', () => {
      useCwd(initRepo());

      buildProgram().parse(['merge', 's1', '--accept-debt', 'shortcut taken'], { from: 'user' });

      expect(errors).toEqual(['--accept-debt and --review-by must be passed together.']);
      expect(process.exitCode).toBe(1);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    it('rejects --review-by without --accept-debt', () => {
      useCwd(initRepo());

      buildProgram().parse(['merge', 's1', '--review-by', 'before v2'], { from: 'user' });

      expect(errors).toEqual(['--accept-debt and --review-by must be passed together.']);
      expect(process.exitCode).toBe(1);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    it('reports no adapter detected and exits 1', () => {
      useCwd(initRepo());

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('No adapter detected')]);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    // Only `--pr` was guarded, so a session could merge or reject another
    // session's branch plainly and park it `blocked` (decisions 26, 44).
    it.each([
      ['', []],
      [' --pr', ['--pr']],
    ])('refuses `merge%s` when a session is calling', (_label, flags) => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      seedSession(repo, 's1', repo);

      buildProgram().parse(['merge', 's2', ...flags], { from: 'user' });

      expect(errors).toEqual(['`pup merge` is operator-only; sessions cannot merge sessions.']);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    // The variable once counted only when it named a session that exists, to
    // keep garbage out of the ledger's acceptor; with the acceptor constant, a
    // variable naming no session is still a session, not an operator (decision 44).
    it('refuses when PUP_SESSION_ID names no session', () => {
      useCwd(initRepoWithAdapter());
      vi.stubEnv('PUP_SESSION_ID', 'does-not-exist');

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(errors).toEqual(['`pup merge` is operator-only; sessions cannot merge sessions.']);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    it('forwards the repo, session, and detected adapter to the gate', () => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      vi.mocked(runMergeGate).mockReturnValue(mergedOutcome());

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(runMergeGate).toHaveBeenCalledTimes(1);
      const [, request] = firstCall(runMergeGate);
      expect(request.repoPath).toBe(repo);
      expect(request.sessionId).toBe('s1');
      expect(request.adapter.id).toBe('typescript');
      expect(request.openPr).toBeUndefined();
    });

    it('reports a thrown gate error and exits 1', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockImplementation(() => {
        throw new Error('worktree has a held lock');
      });

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(errors).toEqual(['worktree has a held lock']);
      expect(process.exitCode).toBe(1);
      expect(logs).toEqual([]);
    });

    it('merges and cleans up on a passing gate with no PR', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue(
        mergedOutcome({
          report: {
            sessionId: 's1',
            passed: true,
            sandbox: 'sandbox-exec (macOS)',
            stages: [{ stage: 'lint', status: 'pass' }],
          },
        }),
      );

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(logs.some((l) => /lint\s+PASS/.test(l))).toBe(true);
      expect(logs).toContain('Merged s1; worktree and branch cleaned up.');
      expect(process.exitCode).toBeUndefined();
    });

    it('reports an opened PR when merging with --pr', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue(
        mergedOutcome({ prUrl: 'https://github.com/acme/repo/pull/7', prWasAdopted: false }),
      );

      buildProgram().parse(['merge', 's1', '--pr'], { from: 'user' });

      expect(firstCall(runMergeGate)[1].openPr).toBe(true);
      expect(logs).toContain(
        'Gate passed; opened https://github.com/acme/repo/pull/7 — merge it there, then run `pup audit`.',
      );
    });

    it('reports an adopted PR when one was already open', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue(
        mergedOutcome({ prUrl: 'https://github.com/acme/repo/pull/7', prWasAdopted: true }),
      );

      buildProgram().parse(['merge', 's1', '--pr'], { from: 'user' });

      expect(logs).toContain(
        'Gate passed; reused the open PR https://github.com/acme/repo/pull/7 and rewrote its ' +
          'description with this gate report — check it, merge it there, then run `pup audit`.',
      );
    });

    it('surfaces debt candidates touched by the merge', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue(
        mergedOutcome({ debtCandidates: [{ id: 3, description: 'old shortcut' }] }),
      );

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(logs).toContain(
        'This merge touched files of open debt #3 (old shortcut) — if the shortcut is gone, ' +
          'run `pup debt close 3`.',
      );
    });

    it('does not crash when a decision record id has no matching row', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue(mergedOutcome({ decisionRecordId: 999 }));

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(logs).toContain('Merged s1; worktree and branch cleaned up.');
      expect(process.exitCode).toBeUndefined();
    });

    it('reports a refused gate and exits 1', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue({
        status: 'refused',
        report: {
          sessionId: 's1',
          passed: false,
          sandbox: 'sandbox-exec (macOS)',
          stages: [{ stage: 'diff-size', status: 'flagged', detail: 'big diff' }],
        },
        rejectCount: 0,
      });

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(logs).toContain(
        'Merge refused: diff-size flagged. Re-run with --accept-debt "<reason>" --review-by ' +
          '"<condition>", or steer the session to address the flags.',
      );
      expect(process.exitCode).toBe(1);
    });

    it('reports a rejected gate and exits 1', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue({
        status: 'rejected',
        report: { sessionId: 's1', passed: false, sandbox: 'sandbox-exec (macOS)', stages: [] },
        rejectCount: 1,
      });

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(logs).toContain('Gate failed; report re-injected into the session (rejection 1/2).');
      expect(process.exitCode).toBe(1);
    });

    it('reports a blocked gate and exits 1', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue({
        status: 'blocked',
        report: { sessionId: 's1', passed: false, sandbox: 'sandbox-exec (macOS)', stages: [] },
        rejectCount: 2,
      });

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(logs).toContain(
        'Gate failed; session parked as blocked — needs a human. Address it, then `pup unblock s1`.',
      );
      expect(process.exitCode).toBe(1);
    });

    it('forwards --accept-debt/--review-by, attributed to the human the guard admits', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue(mergedOutcome());

      buildProgram().parse(
        ['merge', 's1', '--accept-debt', 'shipped a shortcut', '--review-by', 'before v2'],
        { from: 'user' },
      );

      const [, request] = firstCall(runMergeGate);
      expect(request.acceptDebt).toEqual({
        reason: 'shipped a shortcut',
        reviewBy: 'before v2',
        acceptedBy: 'human',
      });
    });

    it('throws when run outside any git repo (no project to resolve)', () => {
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() => buildProgram().parse(['merge', 's1'], { from: 'user' })).toThrow();
    });
  });
});

// `npm link` installs `bin/pup` as a symlink; `process.argv[1]` is that link
// while `import.meta.url` is the resolved file, so without a realpath the
// entry point decides it is being imported and exits 0 without parsing argv.
describe('executable entry point', () => {
  it('parses argv when invoked through a symlink, as the linked `pup` binary is', () => {
    const link = join(tempDir('pup-bin-'), 'pup');
    symlinkSync(join(process.cwd(), 'src', 'cli', 'index.ts'), link);

    const out = execFileSync(process.execPath, ['--import', 'tsx', link, '--help'], {
      encoding: 'utf8',
      env: GIT_ENV,
      cwd: process.cwd(),
    });

    expect(out).toContain('Usage:');
  });
});
