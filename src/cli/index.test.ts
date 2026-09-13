import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Side-effecting boundaries only (tmux/git spawns, `claude -p` sessions, and the
// multi-stage merge-gate orchestration) — everything else (sqlite repositories,
// profile-store file reads) is exercised for real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', () => ({
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
  killWatcher: vi.fn(),
  launchWatcher: vi.fn(),
}));
vi.mock('../core/conductor.service.js', () => ({
  isConductorRunning: vi.fn(() => false),
  startConductor: vi.fn(),
  stopConductor: vi.fn(),
}));
vi.mock('../core/merge-gate.service.js', () => ({
  runMergeGate: vi.fn(),
}));
vi.mock('../core/session-lifecycle.service.js', () => ({
  createSession: vi.fn(),
  interruptSession: vi.fn(),
  killSession: vi.fn(),
  launchTask: vi.fn(),
  markSessionDone: vi.fn(),
  planTask: vi.fn(),
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

import {
  SessionPaneMissingError,
  SteerNotDeliveredError,
} from '../claude/session-runtime.service.js';
import { isConductorRunning, startConductor, stopConductor } from '../core/conductor.service.js';
import type { SessionState } from '../core/db.client.js';
import { DEFAULT_BASE_PROFILE } from '../core/default-profile.constants.js';
import { insertLedgerEntry } from '../core/ledger.repository.js';
import { runMergeGate } from '../core/merge-gate.service.js';
import { projectId, projectPaths } from '../core/paths.utils.js';
import {
  ensureProject,
  getSession,
  getTask,
  incrementRejectCount,
  insertSession,
  insertTask,
  listBacklogTasks,
  listEvents,
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
  steerSession,
} from '../core/session-lifecycle.service.js';
import type { MergeOutcome } from '../core/types/merge-gate.types.js';
import { buildProgram, fatalExitCode } from './index.js';
import { ProjectResolutionError, resolveProject } from './project.utils.js';

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
    vi.stubEnv('HOME', tempDir('pup-cli-home-'));
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

    // Outside any repo the store decides, but only when it cannot be wrong
    // (decision 43).
    it('runs against the only registered project when outside any repo', () => {
      const repo = initRepo();
      seedBacklogTask(repo, 't-plan', 'the one project there is');
      useCwd(tempDir('pup-cli-noproj-'));

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs.join('\n')).toContain('the one project there is');
      expect(process.exitCode).toBeUndefined();
    });

    it('runs against the one project still on disk when the others are stale', () => {
      const live = initRepo();
      seedBacklogTask(live, 't-plan', 'the one repo still here');
      const stale = initRepo();
      registerProject(stale);
      rmSync(stale, { recursive: true });
      useCwd(tempDir('pup-cli-noproj-'));

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs.join('\n')).toContain('the one repo still here');
      expect(process.exitCode).toBeUndefined();
    });

    it('lists the registered projects and refuses when several could apply', () => {
      const repoA = initRepo();
      const repoB = initRepo();
      const idA = registerProject(repoA);
      const idB = registerProject(repoB);
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() => buildProgram().parse(['status'], { from: 'user' })).toThrow(
        new ProjectResolutionError(
          [
            ...[`${idA}  ${repoA}`, `${idB}  ${repoB}`].sort(),
            'Not inside a git repository; pass --project <id> to pick one of these.',
          ].join('\n'),
        ),
      );
    });

    it('refuses in one line when outside any repo and nothing is registered', () => {
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() => buildProgram().parse(['status'], { from: 'user' })).toThrow(
        new ProjectResolutionError(
          'Not inside a git repository and no project registered; run pup init from the repo you want to control.',
        ),
      );
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
      useCwd(initRepo());
      vi.mocked(startConductor).mockReturnValue({
        name: 'pup-conductor-p1',
        paneId: '%3',
        delivered: true,
      });

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
      expect(process.exitCode).toBeUndefined();
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

  // The conductor is the operator's delegate for planning, launching, steering
  // and killing, refused the merge, the respawn and other projects, and what
  // it plans is recorded as its own (decision 47).
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
