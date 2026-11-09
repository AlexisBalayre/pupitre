import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import Database from 'better-sqlite3';
import { CommanderError } from 'commander';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

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
  // Not boundaries but the names and attach lines themselves, and the real
  // ones: what these print is the contract under test — the pinned target and
  // the socket the conductor's window is on (decisions 46, 47) — so a fake
  // spelling here would only agree with itself.
  attachCommand: (await importOriginal<typeof import('../claude/session-runtime.service.js')>())
    .attachCommand,
  windowLabel: (await importOriginal<typeof import('../claude/session-runtime.service.js')>())
    .windowLabel,
  // `pup attach` hands the terminal to tmux; here it hands it to nothing.
  attachWindow: vi.fn(() => 0),
  hasSessionWindow: vi.fn(() => true),
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
  // The real rule and the real file, under the throwaway HOME: which names
  // `pup init --session-env` refuses and keeps, and the config dir a launch
  // hashes from them, are the contract (decision 106).
  resolveWindowEnv: (await importOriginal<typeof import('../claude/session-runtime.service.js')>())
    .resolveWindowEnv,
  claudeUserDir: (await importOriginal<typeof import('../claude/session-runtime.service.js')>())
    .claudeUserDir,
  ConfigDirRefusedError: (
    await importOriginal<typeof import('../claude/session-runtime.service.js')>()
  ).ConfigDirRefusedError,
  sessionEnvAllowed: (await importOriginal<typeof import('../claude/session-runtime.service.js')>())
    .sessionEnvAllowed,
  readSessionEnv: (await importOriginal<typeof import('../claude/session-runtime.service.js')>())
    .readSessionEnv,
  refusedSessionEnv: (await importOriginal<typeof import('../claude/session-runtime.service.js')>())
    .refusedSessionEnv,
  saveSessionEnv: (await importOriginal<typeof import('../claude/session-runtime.service.js')>())
    .saveSessionEnv,
}));
// `render` takes over the terminal and never returns until the operator quits,
// which is the one boundary `pup ui` has; the dashboard it would draw is tested
// against its own fixtures in src/cli/ui.
vi.mock('ink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ink')>()),
  render: vi.fn(),
}));
vi.mock('../core/conductor.service.js', () => ({
  ConductorTellRefusedError: class ConductorTellRefusedError extends Error {},
  DEFAULT_MAX_SESSIONS: 4,
  NO_CONDUCTOR_RUNNING:
    'No conductor is running for this project; start one with `pup conductor start`.',
  isConductorRunning: vi.fn(() => false),
  startConductor: vi.fn(),
  stopConductor: vi.fn(),
  tellConductor: vi.fn(() => true),
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
  countChangedLines: vi.fn(() => ({ source: 0, test: 0, docs: 0, forged: [] })),
}));
// The land's own git and gh work is land.test.ts's, against a real repo.
vi.mock('../core/land.service.js', () => ({ landSession: vi.fn() }));
// So is the fix round's, in fix-round.test.ts; `pup status` asks GitHub nothing here.
vi.mock('../core/fix-round.service.js', () => ({
  ciReviewLookup: vi.fn(),
  startFixRound: vi.fn(),
}));
// The wait's gh reads and clock are ci-wait.test.ts's.
vi.mock('../core/ci-wait.service.js', () => ({ waitForCiReview: vi.fn() }));
// The server and its socket are web-dashboard.test.ts's; here it binds nothing.
vi.mock('../core/web-dashboard.service.js', () => ({ startWebDashboard: vi.fn() }));
// The browser opener is `pup dashboard --open`'s one boundary; every other
// call, the fixtures' git included, runs for real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), spawn: vi.fn(actual.spawn) };
});
vi.mock('../core/session-lifecycle.service.js', async (importOriginal) => ({
  createSession: vi.fn(),
  interruptSession: vi.fn(),
  killSession: vi.fn(),
  LowMemoryError: (await importOriginal<typeof import('../core/session-lifecycle.service.js')>())
    .LowMemoryError,
  launchTask: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionQuestion: vi.fn(),
  planTask: vi.fn(),
  recordSteerMessage: vi.fn(),
  SessionCapReachedError: (
    await importOriginal<typeof import('../core/session-lifecycle.service.js')>()
  ).SessionCapReachedError,
  sessionPane: vi.fn(),
  steerSession: vi.fn(),
}));
// The run and its slot are test-slot.test.ts's; here only what the command hands them.
vi.mock('../core/test-slot.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/test-slot.service.js')>()),
  runSessionTest: vi.fn(async () => 0),
  sessionTestCommand: vi.fn(() => ({ stage: 'test', command: 'pnpm', args: ['run', 'test'] })),
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
  firstCall,
  HANDOFF_WAIT_DEFAULT_MS,
  initRepo,
  initRepoWithAdapter,
  markDormant,
  registerProject,
  rolledBackLaunch,
  seedBacklogTask,
  seedBlockedSession,
  seedDeadTurn,
  seedEventsFile,
  seedKilledSession,
  seedLedgerEntry,
  seedSession,
  seedStalledSession,
  unreadableEventsFile,
  worktreeOf,
} from '@test/helpers/cli-index.mock.js';
import { render } from 'ink';
import {
  SessionPaneMissingError,
  SteerNotDeliveredError,
} from '../claude/session-runtime.service.js';
import { isConductorRunning } from '../core/conductor.service.js';
import type { SessionState } from '../core/db.client.js';
import { insertDecisionRecord } from '../core/decision-record.repository.js';
import { DEFAULT_BASE_PROFILE } from '../core/default-profile.constants.js';
import { insertLedgerEntry } from '../core/ledger.repository.js';
import { MergeLockLostError } from '../core/merge-gate.errors.js';
import { runMergeGate } from '../core/merge-gate.service.js';
import { replaceOverlaps } from '../core/overlap.repository.js';
import { projectId } from '../core/paths.utils.js';
import { GateInterruptedError, UndeclaredSandboxError } from '../core/sandbox.utils.js';
import {
  appendEvent,
  ensureProject,
  getSession,
  getTask,
  insertTask,
  listBacklogTasks,
  MalformedTaskSpecError,
  recordSessionRoute,
  transitionSession,
} from '../core/session.repository.js';
import { STALLED_AFTER_MS } from '../core/session-activity.constants.js';
import {
  awaitHandoffReady,
  HandoffMissingError,
  isHandoffReady,
  markHandoffReady,
  requestHandoff,
  respawnSession,
} from '../core/session-handoff.service.js';
import {
  LaunchRolledBackError,
  TaskAlreadyClaimedError,
  TerminalSessionError,
  TopRungReachedError,
  UnknownSessionError,
  UnknownTaskError,
} from '../core/session-lifecycle.errors.js';
import {
  createSession,
  interruptSession,
  launchTask,
  markSessionDone,
  markSessionQuestion,
  planTask,
  SessionCapReachedError,
  steerSession,
} from '../core/session-lifecycle.service.js';
import {
  runSessionTest,
  SlotWaitInterruptedError,
  sessionTestCommand,
} from '../core/test-slot.service.js';
import type { MergeOutcome } from '../core/types/merge-gate.types.js';
import { startWebDashboard } from '../core/web-dashboard.service.js';
import { buildProgram, fatalExitCode } from './index.js';
import { ProjectResolutionError, resolveProject } from './project.utils.js';
import type { DashboardReading, ProjectReading } from './ui/use-snapshot.hook.js';

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
    process.exitCode = originalExitCode;
  });

  function useCwd(dir: string): void {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  }

  /** Pretend to be another platform for one test; `process.platform` is a plain property. */
  function onPlatform(platform: NodeJS.Platform): void {
    // better-sqlite3 picks its native prebuild by platform on first open, so it
    // is loaded for the real one before the command opens the store.
    new Database(':memory:').close();
    const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    onTestFinished(() => {
      Object.defineProperty(process, 'platform', original);
    });
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
        /^conductor running \(attach: tmux -L pup-conductor-([0-9a-f]{12}) attach -t '=pup-conductor-\1:'\)$/,
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

    // Decision 76: the question a worker asked rides on its row, scrubbed,
    // until a steer answers it.
    it('shows an open question on the session line until a steer answers it', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      const { db } = resolveProject(repo);
      transitionSession(db, 's1', 'running');
      appendEvent(db, 's1', 'question', { text: 'rebase\u001b[2J or\nmerge?' });
      db.close();

      buildProgram().parse(['status'], { from: 'user' });

      // The session row, below the inbox line that leads with the same question.
      const line = logs.find((entry) => entry.includes('pup/s1')) ?? '';
      expect(line).toMatch(/pup\/s1 {2}question: rebase \[2J or merge\?$/);
      expect(logs.join('\n')).not.toContain('\u001b');

      const again = resolveProject(repo).db;
      appendEvent(again, 's1', 'steer', { kind: 'message', by: 'operator' });
      again.close();
      logs.length = 0;

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs.join('\n')).not.toContain('question');
    });

    // Decision 92: a rung is chosen for the operator, so the row says which.
    it("shows a session's model, effort and rung, and why it climbed there", () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      const { db } = resolveProject(repo);
      transitionSession(db, 's1', 'running');
      recordSessionRoute(db, 's1', {
        tier: 'standard',
        rung: 2,
        model: 'claude-opus-5-5',
        effort: 'high',
        reason: 'gate-rejection',
        override: false,
      });
      db.close();

      buildProgram().parse(['status'], { from: 'user' });

      const line = logs.find((entry) => entry.includes('pup/s1')) ?? '';
      expect(line).toContain('claude-opus-5-5 high, rung 3/4 after gate-rejection');
    });

    // Decision 83: what waits on the operator leads, with what answers it.
    it('prints the needs-you inbox before everything else, one line of each kind in order', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's-pr');
      seedSession(repo, 's-local');
      seedSession(repo, 's-review');
      seedStalledSession(repo, 's-stalled');
      seedBlockedSession(repo, 's-blocked', 'lint keeps failing');
      seedSession(repo, 's-asking');
      const { db } = resolveProject(repo);
      for (const id of ['s-pr', 's-local', 's-review']) {
        transitionSession(db, id, 'running');
        transitionSession(db, id, 'awaiting-review');
      }
      for (const id of ['s-pr', 's-local']) {
        transitionSession(db, id, 'merged');
        appendEvent(db, id, 'merge', {
          branch: `pup/${id}`,
          // A sha the repo's unborn main cannot hold: the PR waits on the operator.
          sha: 'f'.repeat(40),
          target: 'main',
          files: [],
          ...(id === 's-pr' ? { prUrl: 'https://github.com/o/r/pull/7' } : {}),
        });
      }
      transitionSession(db, 's-asking', 'running');
      appendEvent(db, 's-asking', 'question', { text: 'rebase or merge?' });
      db.close();
      seedLedgerEntry(repo, { reviewBy: '2020-01-01' });
      vi.mocked(isConductorRunning).mockReturnValue(true);

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs.slice(0, 5)).toEqual([
        'Needs you',
        '  s-asking  question: rebase or merge?  → pup answer s-asking "..."',
        '  s-blocked  blocked (3 rejections)  → pup unblock s-blocked',
        expect.stringMatching(
          /^ {2}s-stalled {2}STALLED \(\d+m\) {2}→ pup steer s-stalled "\.\.\."$/,
        ),
        '  s-pr  PR opened, not landed  → https://github.com/o/r/pull/7',
      ]);
      expect(logs[5]).toMatch(/^OVERDUE DEBT/);
      // A local fast-forward has landed already: no PR waits on anyone.
      expect(logs.join('\n')).not.toContain('s-local');
      // The running conductor gates the finished session (decision 102): it
      // leaves the inbox and stays in the table.
      expect(logs.join('\n')).not.toContain('awaiting review');
      expect(logs.slice(6)).toContainEqual(expect.stringMatching(/^awaiting-review +s-review /));
    });

    it('puts an awaiting-review session in the inbox when no conductor runs to gate it', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's-review');
      const { db } = resolveProject(repo);
      transitionSession(db, 's-review', 'running');
      transitionSession(db, 's-review', 'awaiting-review');
      db.close();

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs.slice(0, 2)).toEqual([
        'Needs you',
        '  s-review  awaiting review  → pup review s-review then pup merge s-review --pr',
      ]);
    });

    it('prints no inbox when nothing waits on the operator', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      const { db } = resolveProject(repo);
      transitionSession(db, 's1', 'running');
      db.close();

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs).not.toContain('Needs you');
    });

    it('leaves merged and killed rows to --history', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's-live');
      seedSession(repo, 's-merged');
      seedKilledSession(repo, 's-killed');
      const { db } = resolveProject(repo);
      transitionSession(db, 's-live', 'running');
      transitionSession(db, 's-merged', 'running');
      transitionSession(db, 's-merged', 'awaiting-review');
      transitionSession(db, 's-merged', 'merged');
      db.close();

      buildProgram().parse(['status'], { from: 'user' });

      const table = logs.join('\n');
      expect(table).toMatch(/^running +s-live/m);
      expect(table).not.toContain('s-merged');
      // Only the session row goes: its task is planned again.
      expect(table).not.toMatch(/^killed/m);

      logs.length = 0;
      buildProgram().parse(['status', '--history'], { from: 'user' });

      expect(logs).toEqual([
        expect.stringMatching(/^running +s-live/),
        expect.stringMatching(/^merged +s-merged/),
        expect.stringMatching(/^killed +s-killed/),
        // The killed session's task is planned again.
        expect.stringMatching(/^planned +t-s-killed/),
      ]);
    });

    it('says nothing runs when every session has finished, until --history', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's-merged');
      const { db } = resolveProject(repo);
      transitionSession(db, 's-merged', 'running');
      transitionSession(db, 's-merged', 'awaiting-review');
      transitionSession(db, 's-merged', 'merged');
      db.close();

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs).toEqual(['Nothing running and nothing planned.']);

      logs.length = 0;
      buildProgram().parse(['status', '--history'], { from: 'user' });

      expect(logs).toEqual([expect.stringMatching(/^merged +s-merged/)]);
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
          '  s-blocked  blocked (3 rejections)  → pup unblock s-blocked',
          expect.stringMatching(
            /^ {2}s-stalled {2}TURN DIED \(API error\).*→ pup steer s-stalled "\.\.\."$/,
          ),
          expect.stringMatching(
            /^ {2}s-quiet {2}STALLED \(\d+m\) {2}→ pup steer s-quiet "\.\.\."$/,
          ),
          '  s-review  awaiting review  → pup review s-review then pup merge s-review --pr',
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
      // one of them, so what an inbox line says is sanitized before the
      // terminal sees it (decision 29).
      it('strips control characters out of an inbox line it prints', () => {
        const repo = initRepo();
        seedSession(repo, 's-asking');
        const { db } = resolveProject(repo);
        transitionSession(db, 's-asking', 'running');
        appendEvent(db, 's-asking', 'question', { text: '\u001b[2Jhijack?' });
        db.close();
        useCwd(tempDir('pup-cli-noproj-'));

        buildProgram().parse(['status'], { from: 'user' });

        const row = logs.find((line) => line.includes('s-asking')) ?? '';
        expect(row).toContain('[2Jhijack?');
        expect(row).not.toContain('\u001b');
      });

      // Both lines are printed straight from the snapshot rather than through
      // `sessionLine`, so both sanitize again at the print site (decision 68).
      it('strips control characters out of an overdue debt line', () => {
        const repo = initRepo();
        seedLedgerEntry(repo, {
          description: '\u001b[2Jshortcut',
          reviewBy: '2020-01-01T00:00:00.000Z',
        });
        useCwd(repo);

        buildProgram().parse(['status'], { from: 'user' });

        const row = logs.find((line) => line.includes('OVERDUE DEBT')) ?? '';
        expect(row).toContain('[2Jshortcut');
        expect(row).not.toContain('\u001b');
      });

      it('strips control characters out of a radar overlap line', () => {
        const repo = initRepo();
        for (const id of ['\u001b[2Js1', '\u001b[2Js2']) {
          seedSession(repo, id);
          const { db } = resolveProject(repo);
          transitionSession(db, id, 'running');
          db.close();
        }
        const { db } = resolveProject(repo);
        replaceOverlaps(db, [
          { sessionA: '\u001b[2Js1', sessionB: '\u001b[2Js2', files: ['src/a.ts'] },
        ]);
        db.close();
        useCwd(repo);

        buildProgram().parse(['status'], { from: 'user' });

        const row = logs.find((line) => line.includes('OVERLAP')) ?? '';
        expect(row).toContain('[2Js1 <-> [2Js2');
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

  // The custom adapter's depGraph is a gate child; the refusal must come out
  // as pup's one line, not wrapped as the operator's command failing.
  it('map off darwin refuses in one line when a custom adapter would run a child', () => {
    const repo = initRepo();
    useCwd(repo);
    mkdirSync(join(repo, '.pupitre'), { recursive: true });
    writeFileSync(join(repo, '.pupitre', 'adapter.yml'), "depGraph: echo '{}'\n");
    onPlatform('linux');
    vi.stubEnv('PUP_SANDBOX', undefined);

    buildProgram().parse(['map'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([expect.stringContaining('PUP_SANDBOX=vm')]);
    expect(errors[0]).not.toContain('Custom adapter');
    expect(logs).toEqual([]);
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

    // Decision 147: a killed session returns its task to the backlog, and the
    // drop retires it there while its session history stays.
    it('drops a task whose only session was killed, keeping the session', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      const { db, repoPath } = resolveProject(repo);
      transitionSession(db, 's1', 'killed');
      const taskId = 't-s1';
      expect(listBacklogTasks(db, projectId(repoPath)).map((t) => t.id)).toEqual([taskId]);

      buildProgram().parse(['plan', 'drop', taskId], { from: 'user' });

      expect(errors).toEqual([]);
      expect(logs).toContain(`Dropped ${taskId}.`);
      expect(listBacklogTasks(db, projectId(repoPath))).toEqual([]);
      expect(getSession(db, 's1')?.state).toBe('killed');
      buildProgram().parse(['plan'], { from: 'user' });
      expect(logs.some((line) => line.startsWith(taskId))).toBe(false);
    });

    it('refuses to drop a task a live session claims, naming the session', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      const { db } = resolveProject(repo);
      transitionSession(db, 's1', 'running');
      const taskId = 't-s1';

      buildProgram().parse(['plan', 'drop', taskId], { from: 'user' });

      expect(errors.join('\n')).toContain(`Task ${taskId} is claimed by session s1`);
      expect(process.exitCode).toBe(1);
      expect(getTask(db, taskId)?.dropped_at).toBeNull();
    });

    it('prints a claimed-drop refusal without the control characters of the session id', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's\u001b[31m1');
      const { db } = resolveProject(repo);
      transitionSession(db, 's\u001b[31m1', 'running');

      buildProgram().parse(['plan', 'drop', 't-s\u001b[31m1'], { from: 'user' });

      expect(errors.join('\n')).not.toContain('\u001b');
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
        scopeOut: [],
        acceptance: ['tests pass'],
      });
    });

    // Decision 92: the tier picks the ladder a task launches on, so the
    // listing the operator launches from shows it, and which ones they set.
    it('lists the tier each task launches on, marking the one --tier set', () => {
      const repo = initRepo();
      useCwd(repo);
      const { db, repoPath } = resolveProject();
      ensureProject(db, projectId(repoPath), repoPath);
      const plan = (id: string, scopeIn: unknown, tier?: 'critical' | 'standard') =>
        insertTask(db, {
          id,
          projectId: projectId(repoPath),
          spec: JSON.stringify({ goal: id, scopeIn }),
          tier,
        });
      plan('t-ui', ['src/cli/ui/**']);
      plan('t-gate', ['src/core/merge-gate.service.ts']);
      plan('t-set', ['docs/**'], 'critical');
      plan('t-torn', ['docs/**', 7]);

      buildProgram().parse(['plan'], { from: 'user' });

      const line = (id: string) => logs.find((entry) => entry.startsWith(`${id} `)) ?? '';
      expect(line('t-ui')).toMatch(/^t-ui +standard +t-ui/);
      expect(line('t-gate')).toMatch(/^t-gate +critical +t-gate/);
      expect(line('t-set')).toMatch(/^t-set +critical\* +t-set/);
      expect(line('t-torn')).toMatch(/^t-torn +standard +t-torn/);
      expect(logs).toContain('* tier set with --tier, over the one the scope-in implies');
    });

    it('stores the tier --tier gives an edit, and refuses any other word', () => {
      const repo = initRepo();
      useCwd(repo);
      const { db, repoPath } = resolveProject();
      ensureProject(db, projectId(repoPath), repoPath);
      insertTask(db, {
        id: 't-1',
        projectId: projectId(repoPath),
        spec: JSON.stringify({ id: 't-1', goal: 'g', scopeIn: ['docs/**'], acceptance: ['a'] }),
      });

      buildProgram().parse(['plan', 'edit', 't-1', '--tier', 'max'], { from: 'user' });
      expect(errors).toContain('--tier takes critical or standard.');
      expect(getTask(db, 't-1')?.tier).toBeNull();

      buildProgram().parse(['plan', 'edit', 't-1', '--tier', 'critical'], { from: 'user' });
      expect(logs).toContain('Updated t-1.');
      expect(getTask(db, 't-1')?.tier).toBe('critical');
    });

    it('hands the tier --tier gives an add to the planner, and refuses any other word', () => {
      useCwd(initRepo());
      vi.mocked(planTask).mockReturnValue('t-abc');

      buildProgram().parse(['plan', 'add', 'goal', '--scope', 'docs/**', '--tier', 'Critical'], {
        from: 'user',
      });
      expect(errors).toContain('--tier takes critical or standard.');
      expect(planTask).not.toHaveBeenCalled();

      buildProgram().parse(['plan', 'add', 'goal', '--scope', 'docs/**', '--tier', 'critical'], {
        from: 'user',
      });
      expect(firstCall(planTask)[1]).toMatchObject({ tier: 'critical' });
    });

    // The refusal quotes the glob that failed through JSON.stringify, which
    // escapes C0 controls and emits C1 raw; a stored glob is store text, so the
    // line is scrubbed like every other one (decision 68).
    it('scrubs the stored glob a refused edit quotes', () => {
      const repo = initRepo();
      useCwd(repo);
      const { db, repoPath } = resolveProject();
      ensureProject(db, projectId(repoPath), repoPath);
      insertTask(db, {
        id: 't-1',
        projectId: projectId(repoPath),
        spec: JSON.stringify({
          id: 't-1',
          goal: 'g',
          scopeIn: ['src/**\n\u009b2J'],
          acceptance: ['a'],
        }),
      });

      buildProgram().parse(['plan', 'edit', 't-1', '--goal', 'sharper'], { from: 'user' });

      expect(errors.join('\n')).toContain('Scope glob contains a control character');
      expect(errors.join('\n')).not.toContain('\u009b');
      expect(process.exitCode).toBe(1);
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

    it("prints a planned task's goal and scope-in before it launches", () => {
      const repo = initRepo();
      useCwd(repo);
      const { db, repoPath } = resolveProject();
      ensureProject(db, projectId(repoPath), repoPath);
      insertTask(db, {
        id: 't-abc',
        projectId: projectId(repoPath),
        spec: JSON.stringify({
          id: 't-abc',
          goal: 'queue the test runs',
          scopeIn: ['src/core/**', 'docs/**'],
          acceptance: ['tests pass'],
        }),
      });
      vi.mocked(launchTask).mockReturnValue('t-abc-0');

      buildProgram().parse(['launch', 't-abc'], { from: 'user' });

      expect(logs.slice(0, 3)).toEqual([
        'goal: queue the test runs',
        'scope-in: src/core/**, docs/**',
        'Launched session t-abc-0 (tmux: pup-t-abc-0).',
      ]);
    });

    it('hands an --effort to the launch, which records it as an override', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockReturnValue('t-abc-0');

      buildProgram().parse(['launch', 't-abc', '--effort', 'xhigh'], { from: 'user' });

      expect(firstCall(launchTask)[1]).toMatchObject({ model: undefined, effort: 'xhigh' });
    });

    // Decision 92: nothing is left to climb, so the next window is the operator's call.
    it('reports a launch refused at the top rung and exits 1 rather than throwing', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockImplementation(() => {
        throw new TopRungReachedError({ task: 't-abc' }, 'critical', 'gate-rejection');
      });

      buildProgram().parse(['launch', 't-abc'], { from: 'user' });

      expect(errors.join('\n')).toContain(
        'Task t-abc hit gate-rejection on the top rung of its critical ladder (claude-opus-5-5 xhigh)',
      );
      expect(process.exitCode).toBe(1);
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

    it('scrubs the refusal a launch error prints', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockImplementation(() => {
        throw new TaskAlreadyClaimedError('t-1', '\u001b[2Js1');
      });

      buildProgram().parse(['launch', 't-1'], { from: 'user' });

      expect(errors.join('\n')).not.toContain('\u001b');
      expect(errors.join('\n')).toContain('claimed by session [2Js1.');
      expect(process.exitCode).toBe(1);
    });

    // The kickoff delivers the compiled context through the same paste a steer
    // uses, so a launch whose context arrived as a tail is a launch that
    // failed, not a session to attach to (decision 45). `launchTask` undoes it
    // and answers with both halves; this command adds the retry — the task is
    // back in the backlog (decision 40), so the retry is a plain launch of it.
    it('prints the refusal, then what was undone and how to try again', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockImplementation(() => {
        throw rolledBackLaunch('t-abc-0');
      });

      buildProgram().parse(['launch', 't-abc'], { from: 'user' });

      expect(errors).toEqual([
        'Steer to session t-abc-0 did not land: 3000 chars',
        'Launch rolled back (session t-abc-0 killed). Re-run `pup launch t-abc`.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(logs.join('\n')).not.toContain('Launched session');
    });

    // The rollback line stands on its own when core had no refusal to hand
    // over: the window never said anything, and one line is the whole of it.
    it('prints the rollback alone when no refusal rode with it', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockImplementation(() => {
        throw new LaunchRolledBackError('Launch rolled back (session t-abc-0 killed)');
      });

      buildProgram().parse(['launch', 't-abc'], { from: 'user' });

      expect(errors).toEqual([
        'Launch rolled back (session t-abc-0 killed). Re-run `pup launch t-abc`.',
      ]);
      expect(process.exitCode).toBe(1);
    });

    // Decision 99: overlap is always allowed, and the flag is accepted for one
    // release so a script passing it keeps working, with a line saying so.
    it('accepts --allow-overlap with a one-line notice and launches as a plain launch would', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockReturnValue('t-abc-0');

      buildProgram().parse(['launch', 't-abc', '--allow-overlap'], { from: 'user' });

      expect(errors[0]).toMatch(/^--allow-overlap has no effect/);
      expect(firstCall(launchTask)[1]).not.toHaveProperty('allowOverlap');
      expect(logs).toContain('Launched session t-abc-0 (tmux: pup-t-abc-0).');
      expect(process.exitCode).toBeUndefined();
    });

    // Decision 96: the cap is the operator's to exceed, never the conductor's.
    it("hands the operator's --over-cap to the launch", () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockReturnValue('t-abc-0');

      buildProgram().parse(['launch', 't-abc', '--over-cap'], { from: 'user' });

      expect(firstCall(launchTask)[1]).toMatchObject({ overCap: true, overrideVia: 'operator' });
      expect(logs).toContain('Launched session t-abc-0 (tmux: pup-t-abc-0).');
    });

    it.each([
      ['launch', ['launch', 't-abc', '--over-cap']],
      ['new', ['new', 'a goal', '--scope', 'src/**', '--over-cap']],
    ])('refuses the conductor `pup %s --over-cap`, launching nothing', (command, argv) => {
      useCwd(initRepo());
      vi.stubEnv('PUP_CONDUCTOR', 'p1');

      buildProgram().parse(argv, { from: 'user' });

      expect(errors).toEqual([
        `\`pup ${command} --over-cap\` is operator-only; the conductor launches within the cap.`,
      ]);
      expect(process.exitCode).toBe(1);
      expect(launchTask).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    it('prints a launch refused at the cap and exits 1 rather than throwing', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockImplementation(() => {
        throw new SessionCapReachedError(4, 4);
      });

      buildProgram().parse(['launch', 't-abc'], { from: 'user' });

      expect(errors).toEqual([new SessionCapReachedError(4, 4).message]);
      expect(process.exitCode).toBe(1);
    });

    it('prints no notice for a plain launch', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockReturnValue('t-abc-0');

      buildProgram().parse(['launch', 't-abc'], { from: 'user' });

      expect([...logs, ...errors].join('\n')).not.toContain('--allow-overlap');
    });

    // Launching is operator- and conductor-only: a session launching one would
    // mint itself a fresh session past decision 7's reject cap, by the rule
    // that keeps `pup merge` and spec authoring so (decisions 26, 42).
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
        outcome: 'refused',
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

    // A malformed row the report survives used to kill `pup review` with a
    // SyntaxError; it is a refusal naming the task, its id scrubbed.
    it.each([[[]], [[NOISY_ID]]])(
      'refuses a spec that is not JSON, naming the task (%j)',
      (args) => {
        const repo = initRepo();
        useCwd(repo);
        seedReviewable(repo);
        const { db } = resolveProject(repo);
        db.prepare("UPDATE tasks SET spec = 'not json {'").run();
        db.close();

        buildProgram().parse(['review', ...args], { from: 'user' });

        const refusal = errors.join('\n');
        expect(refusal).toContain('Task t- [2Js1 has an unusable spec: it is not valid JSON.');
        expect(refusal).not.toContain('\u001b');
        expect(process.exitCode).toBe(1);
      },
    );

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

  /**
   * Escape, the steer that may ride behind it and both their records are
   * `interruptSession`'s (src/core/session-lifecycle.test.ts). This command
   * hands it the message, if any, and reports what came back.
   */
  describe('interrupt', () => {
    it('hands the message to the interrupt, so Escape lands before it', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');

      buildProgram().parse(['interrupt', 's1', 'retry the fetch'], { from: 'user' });

      expect(interruptSession).toHaveBeenCalledWith(
        expect.anything(),
        's1',
        'retry the fetch',
        'operator',
      );
      expect(steerSession).not.toHaveBeenCalled();
      expect(logs).toContain('Interrupted and steered session s1.');
      expect(process.exitCode).toBeUndefined();
    });

    it('sends Escape alone when no message is given', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');

      buildProgram().parse(['interrupt', 's1'], { from: 'user' });

      expect(interruptSession).toHaveBeenCalledWith(expect.anything(), 's1', undefined, 'operator');
      expect(logs).toContain('Interrupted session s1.');
      expect(process.exitCode).toBeUndefined();
    });

    // The steer behind Escape is someone's, named as pup steer names one: a
    // record naming nobody would show the session corrected by nobody
    // (decisions 44, 47).
    it.each([
      ['operator', '', ''],
      ['conductor', 'p1', ''],
      ['session:s1', 'p1', 's1'],
    ])('names the %s that sent the steer behind Escape', (by, conductor, session) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_CONDUCTOR', conductor);
      vi.stubEnv('PUP_SESSION_ID', session);

      buildProgram().parse(['interrupt', 's1', 'retry the fetch'], { from: 'user' });

      expect(interruptSession).toHaveBeenCalledWith(expect.anything(), 's1', 'retry the fetch', by);
      expect(logs).toContain('Interrupted and steered session s1.');
    });

    it.each([
      ['a session the store does not hold', () => new UnknownSessionError('s1'), 'No session s1.'],
      [
        'a session that has stopped',
        () => new TerminalSessionError('s1', 'killed', 'interrupt'),
        'Session s1 is killed; nothing to interrupt.',
      ],
      [
        'a pane that is gone before Escape',
        () => new SessionPaneMissingError('s1', '%3', 'gone'),
        "Session s1's pane %3 no longer exists; nothing was sent.",
      ],
      [
        'a message that never landed after Escape did',
        () => new SteerNotDeliveredError('s1', 3000),
        'Steer to session s1 did not land: 3000 chars',
      ],
    ])('reports %s, and exits 1', (_case, refusal, message) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.mocked(interruptSession).mockImplementation(() => {
        throw refusal();
      });

      buildProgram().parse(['interrupt', 's1', 'retry the fetch'], { from: 'user' });

      expect(errors).toEqual([message]);
      expect(process.exitCode).toBe(1);
      expect(logs).not.toContain('Interrupted and steered session s1.');
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

    it('hands the respawn the model and effort the operator names', () => {
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(true);

      buildProgram().parse(['respawn', 's1', '--effort', 'xhigh'], { from: 'user' });

      expect(firstCall(respawnSession)[5]).toEqual({ model: undefined, effort: 'xhigh' });
    });

    // Refused before the old window is touched, so the handoff waits on disk
    // for the respawn the operator runs with a model and effort of their own.
    it('reports a respawn refused at the top rung and exits 1 rather than throwing', () => {
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(true);
      vi.mocked(respawnSession).mockImplementation(() => {
        throw new TopRungReachedError({ session: 's1' }, 'standard', 'turn-death');
      });

      buildProgram().parse(['respawn', 's1'], { from: 'user' });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(
        /^Session s1 hit turn-death on the top rung of its standard ladder \(claude-opus-5-5 xhigh\)/,
      );
      expect(process.exitCode).toBe(1);
      expect(logs.join('\n')).not.toContain('Respawned s1');
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

  describe('dashboard', () => {
    const URL_WITH_TOKEN = 'http://127.0.0.1:41234/?token=t0k3n';

    /** The one listener the command added for `signal`, removed again so it outlives no test. */
    function addedListener(signal: 'SIGINT' | 'SIGTERM', before: unknown[]): () => void {
      const added = process.listeners(signal).filter((listener) => !before.includes(listener));
      onTestFinished(() => {
        for (const listener of added) process.off(signal, listener);
      });
      expect(added).toHaveLength(1);
      return added[0] as () => void;
    }

    it("serves this project's store, prints the url, and stops on Ctrl-C", async () => {
      const repo = initRepo();
      useCwd(repo);
      const close = vi.fn(() => Promise.resolve());
      vi.mocked(startWebDashboard).mockResolvedValue({ url: URL_WITH_TOKEN, close });
      const sigints = process.listeners('SIGINT');
      const sigterms = process.listeners('SIGTERM');

      await buildProgram().parseAsync(['dashboard'], { from: 'user' });
      const stop = addedListener('SIGINT', sigints);

      expect(firstCall(startWebDashboard)[1]).toBe(repo);
      expect(logs).toEqual([
        `Dashboard on ${URL_WITH_TOKEN}`,
        'Anyone holding this url reads the page; Ctrl-C stops the server.',
      ]);
      expect(addedListener('SIGTERM', sigterms)).toBe(stop);
      stop();
      expect(close).toHaveBeenCalledOnce();
      expect(process.exitCode).toBeUndefined();
    });

    const OPENER = process.platform === 'darwin' ? 'open' : 'xdg-open';

    /** `pup dashboard --open`, its signal listeners cleared after the test. */
    async function runOpen(): Promise<void> {
      vi.mocked(startWebDashboard).mockResolvedValue({
        url: URL_WITH_TOKEN,
        close: () => Promise.resolve(),
      });
      const sigints = process.listeners('SIGINT');
      const sigterms = process.listeners('SIGTERM');
      await buildProgram().parseAsync(['dashboard', '--open'], { from: 'user' });
      addedListener('SIGINT', sigints);
      addedListener('SIGTERM', sigterms);
    }

    /**
     * The opener as a fake child: `outcome` is how it ends, raised after the
     * action returns, as a real child's events are.
     */
    function stubOpener(outcome: 'opens' | 'missing' | 'fails'): { unref: () => void } {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      vi.mocked(spawn).mockImplementation((() => {
        setImmediate(() => {
          if (outcome === 'missing') child.emit('error', new Error('spawn xdg-open ENOENT'));
          else child.emit('exit', outcome === 'fails' ? 3 : 0);
        });
        return child as unknown as ChildProcess;
      }) as unknown as typeof spawn);
      return child;
    }

    /** One macrotask: the fake opener's exit or error has fired. */
    function openerSettled(): Promise<void> {
      return new Promise((resolve) => setImmediate(resolve));
    }

    it('hands the url to a detached opener it does not wait on, with --open', async () => {
      useCwd(initRepo());
      const child = stubOpener('opens');

      await runOpen();
      await openerSettled();

      expect(spawn).toHaveBeenCalledWith(OPENER, [URL_WITH_TOKEN], {
        detached: true,
        stdio: 'ignore',
      });
      expect(child.unref).toHaveBeenCalledOnce();
      expect(logs).not.toContain('Could not open a browser; open the url above.');
    });

    it.each([
      ['is missing', 'missing'],
      ['exits non-zero', 'fails'],
    ] as const)('says to open the url by hand when the opener %s', async (_how, outcome) => {
      useCwd(initRepo());
      stubOpener(outcome);

      await runOpen();
      await openerSettled();

      expect(logs).toContain('Could not open a browser; open the url above.');
    });

    it.each([
      ['a session', 'PUP_SESSION_ID', 's1'],
      ['the conductor', 'PUP_CONDUCTOR', 'p1'],
    ])('refuses %s before binding anything', async (_who, variable, value) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv(variable, value);

      await buildProgram().parseAsync(['dashboard'], { from: 'user' });

      expect(startWebDashboard).not.toHaveBeenCalled();
      expect(errors.join('\n')).toContain('`pup dashboard` is operator-only.');
      expect(process.exitCode).toBe(1);
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

    // Every column is a string the merge that accepted the debt wrote, and
    // `--accept-debt "<reason>"` is a session-reachable argument (decision 68).
    it('scrubs every stored string of an entry it prints', () => {
      const repo = initRepo();
      useCwd(repo);
      seedLedgerEntry(repo, {
        description: '\u001b[2Jshortcut',
        reason: '\u001b[2Jship it',
        reviewBy: '\u001b[2Jnext release',
        acceptedBy: '\u001b[2Jhuman',
      });

      buildProgram().parse(['debt'], { from: 'user' });

      const page = logs.join('\n');
      expect(page).toContain('[2Jshortcut');
      expect(page).toContain(
        'reason: [2Jship it  review by: [2Jnext release  accepted by: [2Jhuman',
      );
      expect(page).not.toContain('\u001b');
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

  describe('session', () => {
    // Decision 96: a session's tests run in one of the machine's test slots.
    describe('test', () => {
      it("runs the project's test command with the runner's own arguments, exiting as it did", async () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(worktreeOf(repo, 's1'));
        vi.stubEnv('PUP_SESSION_ID', 's1');
        vi.mocked(runSessionTest).mockResolvedValue(3);

        await buildProgram().parseAsync(['session', 'test', 'src/a.test.ts', '-t', 'slots'], {
          from: 'user',
        });

        expect(firstCall(runSessionTest)[0]).toMatchObject({
          command: { stage: 'test', command: 'pnpm', args: ['run', 'test'] },
          args: ['src/a.test.ts', '-t', 'slots'],
          cwd: process.cwd(),
          sessionId: 's1',
        });
        expect(process.exitCode).toBe(3);
      });

      it('prints once whom the run waits for', async () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(worktreeOf(repo, 's1'));
        vi.stubEnv('PUP_SESSION_ID', 's1');
        vi.mocked(runSessionTest).mockImplementationOnce(async ({ slots }) => {
          slots?.onWait?.(
            [{ kind: 'worker', label: 't-2', pid: 4242 }],
            [{ kind: 'gate', label: 't-3', pid: 4343 }],
          );
          return 0;
        });

        await buildProgram().parseAsync(['session', 'test'], { from: 'user' });

        expect(errors).toEqual([
          'Waiting for a test slot, held by session t-2 (pid 4242); the merge gate for t-3 (pid 4343) waits first.',
        ]);
        expect(process.exitCode).toBe(0);
      });

      it('exits 130 with nothing run when an interrupt ends the wait', async () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(worktreeOf(repo, 's1'));
        vi.stubEnv('PUP_SESSION_ID', 's1');
        vi.mocked(runSessionTest).mockRejectedValueOnce(new SlotWaitInterruptedError('SIGINT'));

        await buildProgram().parseAsync(['session', 'test'], { from: 'user' });

        expect(errors).toEqual([
          'Interrupted by SIGINT while waiting for a test slot; nothing ran.',
        ]);
        expect(process.exitCode).toBe(130);
      });

      it('lets any other failure of the run through', async () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(worktreeOf(repo, 's1'));
        vi.stubEnv('PUP_SESSION_ID', 's1');
        vi.mocked(runSessionTest).mockRejectedValueOnce(new Error('spawn pnpm ENOENT'));

        await expect(
          buildProgram().parseAsync(['session', 'test'], { from: 'user' }),
        ).rejects.toThrow('spawn pnpm ENOENT');
      });

      it('requires PUP_SESSION_ID', async () => {
        useCwd(initRepo());
        vi.stubEnv('PUP_SESSION_ID', '');

        await buildProgram().parseAsync(['session', 'test'], { from: 'user' });

        expect(errors).toEqual([
          'pup session test must run inside a Pupitre session (PUP_SESSION_ID unset).',
        ]);
        expect(runSessionTest).not.toHaveBeenCalled();
      });

      it('refuses when no adapter declares a test command', async () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(worktreeOf(repo, 's1'));
        vi.stubEnv('PUP_SESSION_ID', 's1');
        vi.mocked(sessionTestCommand).mockReturnValueOnce(undefined);

        await buildProgram().parseAsync(['session', 'test'], { from: 'user' });

        expect(errors[0]).toMatch(/^No test command to run/);
        expect(process.exitCode).toBe(1);
        expect(runSessionTest).not.toHaveBeenCalled();
      });
    });

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

    // Decision 76: guarded exactly like `done`, and the session stays running.
    describe('ask', () => {
      it('requires PUP_SESSION_ID', () => {
        useCwd(initRepo());
        vi.stubEnv('PUP_SESSION_ID', '');

        buildProgram().parse(['session', 'ask', 'which base?'], { from: 'user' });

        expect(process.exitCode).toBe(1);
        expect(errors).toEqual([
          'pup session ask must run inside a Pupitre session (PUP_SESSION_ID unset).',
        ]);
        expect(markSessionQuestion).not.toHaveBeenCalled();
      });

      it('records the question from inside its own worktree, scrubbing the echo', () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(worktreeOf(repo, 's1'));
        vi.stubEnv('PUP_SESSION_ID', 's1');

        buildProgram().parse(['session', 'ask', 'rebase\u001b[2J or\nmerge?'], { from: 'user' });

        expect(markSessionQuestion).toHaveBeenCalledTimes(1);
        const [, sessionId, question] = firstCall(markSessionQuestion);
        expect(sessionId).toBe('s1');
        expect(question).toEqual({ text: 'rebase\u001b[2J or\nmerge?' });
        expect(logs).toEqual(['Session s1 asked: rebase [2J or merge?']);
        expect(markSessionDone).not.toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
      });

      it('refuses a blank question and records nothing', () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(worktreeOf(repo, 's1'));
        vi.stubEnv('PUP_SESSION_ID', 's1');

        buildProgram().parse(['session', 'ask', '  '], { from: 'user' });

        expect(markSessionQuestion).not.toHaveBeenCalled();
        expect(errors).toEqual(['pup session ask needs the question itself.']);
        expect(process.exitCode).toBe(1);
      });

      it('refuses from the repo root, inside no worktree', () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        useCwd(repo);
        vi.stubEnv('PUP_SESSION_ID', 's1');

        buildProgram().parse(['session', 'ask', 'which base?'], { from: 'user' });

        expect(markSessionQuestion).not.toHaveBeenCalled();
        expect(errors).toEqual([
          "`pup session ask` reports only its own session; this directory is not inside s1's worktree.",
        ]);
        expect(process.exitCode).toBe(1);
      });

      it('refuses when the worktree around cwd belongs to another session', () => {
        const repo = initRepo();
        seedSession(repo, 's1');
        seedSession(repo, 's2');
        useCwd(worktreeOf(repo, 's2'));
        vi.stubEnv('PUP_SESSION_ID', 's1');

        buildProgram().parse(['session', 'ask', 'which base?'], { from: 'user' });

        expect(markSessionQuestion).not.toHaveBeenCalled();
        expect(errors).toEqual([
          '`pup session ask` reports only its own session; this worktree belongs to s2, not s1.',
        ]);
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
     * Under its lock the gate outlives a Ctrl-C and the SIGTERM `pup ui`'s `q`
     * sends this child: it stops every stage child and removes the lock in its
     * own `finally` (decision 95), so the command adds no handler of its own.
     */
    describe('an interrupted gate', () => {
      it('adds no signal handler of its own while the gate runs', async () => {
        useCwd(initRepoWithAdapter());
        const listening = () => ({
          int: process.listeners('SIGINT').length,
          term: process.listeners('SIGTERM').length,
        });
        const before = listening();
        let during: ReturnType<typeof listening> | undefined;
        vi.mocked(runMergeGate).mockImplementation(async () => {
          during = listening();
          return mergedOutcome();
        });

        await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

        expect(during).toEqual(before);
      });

      it.each([
        ['SIGINT', 130],
        ['SIGTERM', 143],
        ['SIGHUP', 129],
      ] as const)('leaves %s to the entry point, which exits %i', async (signal, code) => {
        useCwd(initRepoWithAdapter());
        vi.mocked(runMergeGate).mockRejectedValue(new GateInterruptedError(signal));

        const escaped = await buildProgram()
          .parseAsync(['merge', 's1'], { from: 'user' })
          .then(
            () => undefined,
            (error: unknown) => error,
          );

        expect(escaped).toBeInstanceOf(GateInterruptedError);
        expect(logs).toEqual([]);
        expect(fatalExitCode(escaped)).toBe(code);
        expect(errors).toEqual([expect.stringContaining(`Interrupted by ${signal}`)]);
      });
    });

    // A lock moved away while the gate ran let another run in alongside it: the
    // merge it made is reported, then the lost lock, and the run fails (decision 88).
    it('reports a merge made under a lock that was lost, and fails on it', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockRejectedValue(
        new MergeLockLostError('/repo/.git/pup-merge.lock', mergedOutcome()),
      );

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(logs).toContain('Merged s1; worktree and branch cleaned up.');
      expect(errors).toEqual([
        expect.stringMatching(
          /^The merge lock at \/repo\/\.git\/pup-merge\.lock was gone or replaced/,
        ),
      ]);
      expect(process.exitCode).toBe(1);
    });

    // The gate refuses before running a child (decision 78); the command turns
    // that into one line on stderr, like every other gate refusal.
    it('refuses in one line when the gate finds no sandbox and no declaration', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockImplementation(() => {
        throw new UndeclaredSandboxError();
      });

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('PUP_SANDBOX=vm')]);
      expect(logs).toEqual([]);
    });

    it('prints the declared label on the gate report', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue(
        mergedOutcome({
          report: {
            sessionId: 's1',
            passed: true,
            sandbox: 'vm (declared by operator)',
            stages: [],
          },
        }),
      );

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(logs).toContain(`  ${'sandbox'.padEnd(16)} vm (declared by operator)`);
    });

    it('prints each stage’s wall time beside its status, and none for a stage untimed', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue(
        mergedOutcome({
          report: {
            sessionId: 's1',
            passed: true,
            sandbox: 'none',
            stages: [
              { stage: 'build', status: 'pass', durationMs: 1234 },
              { stage: 'test', status: 'pass', detail: '12 files', durationMs: 41_000 },
              { stage: 'coverage', status: 'skipped', detail: 'not measured' },
            ],
          },
        }),
      );

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(logs).toContain(`  ${'build'.padEnd(16)} PASS 1.2s`);
      expect(logs).toContain(`  ${'test'.padEnd(16)} PASS 41.0s  12 files`);
      expect(logs).toContain(`  ${'coverage'.padEnd(16)} SKIPPED  not measured`);
    });

    it('rejects --accept-debt without --review-by', async () => {
      useCwd(initRepo());

      await buildProgram().parseAsync(['merge', 's1', '--accept-debt', 'shortcut taken'], {
        from: 'user',
      });

      expect(errors).toEqual(['--accept-debt and --review-by must be passed together.']);
      expect(process.exitCode).toBe(1);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    it('rejects --review-by without --accept-debt', async () => {
      useCwd(initRepo());

      await buildProgram().parseAsync(['merge', 's1', '--review-by', 'before v2'], {
        from: 'user',
      });

      expect(errors).toEqual(['--accept-debt and --review-by must be passed together.']);
      expect(process.exitCode).toBe(1);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    it('reports no adapter detected and exits 1', async () => {
      useCwd(initRepo());

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('No adapter detected')]);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    // Only `--pr` was guarded, so a session could merge or reject another
    // session's branch plainly and park it `blocked` (decisions 26, 44).
    it.each([
      ['', []],
      [' --pr', ['--pr']],
    ])('refuses `merge%s` when a session is calling', async (_label, flags) => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      seedSession(repo, 's1', repo);

      await buildProgram().parseAsync(['merge', 's2', ...flags], { from: 'user' });

      expect(errors).toEqual(['`pup merge` is operator-only; sessions cannot merge sessions.']);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    // The variable once counted only when it named a session that exists, to
    // keep garbage out of the ledger's acceptor; with the acceptor constant, a
    // variable naming no session is still a session, not an operator (decision 44).
    it('refuses when PUP_SESSION_ID names no session', async () => {
      useCwd(initRepoWithAdapter());
      vi.stubEnv('PUP_SESSION_ID', 'does-not-exist');

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(errors).toEqual(['`pup merge` is operator-only; sessions cannot merge sessions.']);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    it('forwards the repo, session, and detected adapter to the gate', async () => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      vi.mocked(runMergeGate).mockResolvedValue(mergedOutcome());

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(runMergeGate).toHaveBeenCalledTimes(1);
      const [, request] = firstCall(runMergeGate);
      expect(request.repoPath).toBe(repo);
      expect(request.sessionId).toBe('s1');
      expect(request.adapters.map((a) => a.id)).toEqual(['typescript']);
      expect(request.openPr).toBeUndefined();
    });

    // Whole but clean: pup's own refusals carry remediation steps past the
    // scrubber's 300-character cut, and an adapter command's stderr from the
    // session's worktree can ride in the same message (decision 68).
    it('reports a thrown gate error whole, with control characters stripped', async () => {
      useCwd(initRepoWithAdapter());
      const long = `worktree has a held lock; ${'run `git config --unset x`. '.repeat(14)}`;
      vi.mocked(runMergeGate).mockImplementation(() => {
        throw new Error(`${long}\u001b]52;c;payload\u0007 tail`);
      });

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(long.length).toBeGreaterThan(300);
      expect(errors).toEqual([`${long} ]52;c;payload  tail`]);
      expect(process.exitCode).toBe(1);
      expect(logs).toEqual([]);
    });

    // The gate reads the stored spec strictly, and its refusal quotes store
    // text: the task id, and the glob that failed (decision 68).
    it('scrubs a gate refusal that quotes the stored spec', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockImplementation(() => {
        throw new MalformedTaskSpecError(
          't-\u001b[2J1',
          'Scope glob contains a control character.',
        );
      });

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(errors.join('\n')).toContain('Task t- [2J1 has an unusable spec');
      expect(errors.join('\n')).not.toContain('\u001b');
      expect(process.exitCode).toBe(1);
    });

    it('merges and cleans up on a passing gate with no PR', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue(
        mergedOutcome({
          report: {
            sessionId: 's1',
            passed: true,
            sandbox: 'sandbox-exec (macOS)',
            stages: [{ stage: 'lint', status: 'pass' }],
          },
        }),
      );

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(logs.some((l) => /lint\s+PASS/.test(l))).toBe(true);
      expect(logs).toContain('Merged s1; worktree and branch cleaned up.');
      expect(process.exitCode).toBeUndefined();
    });

    it('reports an opened PR when merging with --pr', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue(
        mergedOutcome({ prUrl: 'https://github.com/acme/repo/pull/7', prWasAdopted: false }),
      );

      await buildProgram().parseAsync(['merge', 's1', '--pr'], { from: 'user' });

      expect(firstCall(runMergeGate)[1].openPr).toBe(true);
      expect(logs).toContain(
        'Gate passed; opened https://github.com/acme/repo/pull/7 — merge it there, then run `pup land s1`.',
      );
    });

    // The wording comes from the outcome the core returns, never from the
    // session's state: no merged session is seeded in these.
    it('reports a re-gate of a merged session as the PR vouching for its new head', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue(
        mergedOutcome({
          prUrl: 'https://github.com/acme/repo/pull/7',
          prWasAdopted: true,
          regated: true,
        }),
      );

      await buildProgram().parseAsync(['merge', 's1', '--pr'], { from: 'user' });

      expect(logs).toContain(
        'Re-gated s1; https://github.com/acme/repo/pull/7 now carries this gate report for its ' +
          'new head — merge it there, then run `pup land s1`.',
      );
      expect(process.exitCode).toBeUndefined();
    });

    it('reports a re-gate a hard stage refused, naming the stage and the retry', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue({
        status: 'refused',
        report: {
          sessionId: 's1',
          passed: false,
          sandbox: 'sandbox-exec (macOS)',
          stages: [{ stage: 'build', status: 'fail', detail: 'tsc exited 2' }],
        },
        rejectCount: 0,
        regated: true,
      });

      await buildProgram().parseAsync(['merge', 's1', '--pr'], { from: 'user' });

      expect(logs).toContain(
        'Re-gate refused: build failed on the new head, and the PR still vouches for the ' +
          'earlier pin only. Fix it on the branch, push, then re-run `pup merge s1 --pr`.',
      );
      expect(process.exitCode).toBe(1);
    });

    it('reports a re-gate refused only for a flag as needing --accept-debt, never a steer', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue({
        status: 'refused',
        report: {
          sessionId: 's1',
          passed: false,
          sandbox: 'sandbox-exec (macOS)',
          stages: [{ stage: 'diff-size', status: 'flagged', detail: 'big diff' }],
        },
        rejectCount: 0,
        regated: true,
      });

      await buildProgram().parseAsync(['merge', 's1', '--pr'], { from: 'user' });

      expect(logs).toContain(
        'Re-gate refused: diff-size flagged on the new head, and the PR still vouches for the ' +
          'earlier pin only. Re-run `pup merge s1 --pr` with --accept-debt "<reason>" ' +
          '--review-by "<condition>", or fix it on the branch, push, then re-gate.',
      );
      expect(logs.join('\n')).not.toContain('steer');
      expect(process.exitCode).toBe(1);
    });

    it('reports an adopted PR when one was already open', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue(
        mergedOutcome({ prUrl: 'https://github.com/acme/repo/pull/7', prWasAdopted: true }),
      );

      await buildProgram().parseAsync(['merge', 's1', '--pr'], { from: 'user' });

      expect(logs).toContain(
        'Gate passed; reused the open PR https://github.com/acme/repo/pull/7 and rewrote its ' +
          'description with this gate report — check it, merge it there, then run `pup land s1`.',
      );
    });

    it('surfaces debt candidates touched by the merge', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue(
        mergedOutcome({ debtCandidates: [{ id: 3, description: 'old shortcut' }] }),
      );

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(logs).toContain(
        'This merge touched files of open debt #3 (old shortcut) — if the shortcut is gone, ' +
          'run `pup debt close 3`.',
      );
    });

    // The merge's own review of the draft prints the same three fields
    // `pup log` does, through the same printer, so both scrub them (decision
    // 68). Only the print is exercised: the keystroke after it wants a real
    // tty, and the stub raises the ENOTTY a stdin that is not one raises.
    it('scrubs the decision record it offers for review', async () => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      seedSession(repo, 's1');
      const { db } = resolveProject(repo);
      const id = insertDecisionRecord(db, {
        sessionId: 's1',
        summary: '\u001b[2Jtook the short path',
        alternatives: '\u001b[2Jthe long one',
        conventions: '\u001b[2Jnone broken',
        files: ['src/a.ts'],
      });
      db.close();
      vi.mocked(runMergeGate).mockResolvedValue(mergedOutcome({ decisionRecordId: id }));
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: unknown };
      const wasTty = stdin.isTTY;
      const wasRawMode = stdin.setRawMode;
      stdin.isTTY = true;
      stdin.setRawMode = () => {
        throw new Error('ENOTTY: inappropriate ioctl for device');
      };

      try {
        await expect(buildProgram().parseAsync(['merge', 's1'], { from: 'user' })).rejects.toThrow(
          'ENOTTY',
        );
      } finally {
        stdin.isTTY = wasTty;
        stdin.setRawMode = wasRawMode;
      }

      const page = logs.join('\n');
      expect(page).toContain('[2Jtook the short path');
      expect(page).toContain('alternatives: [2Jthe long one');
      expect(page).toContain('conventions: [2Jnone broken');
      expect(page).not.toContain('\u001b');
    });

    it('does not crash when a decision record id has no matching row', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue(mergedOutcome({ decisionRecordId: 999 }));

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(logs).toContain('Merged s1; worktree and branch cleaned up.');
      expect(process.exitCode).toBeUndefined();
    });

    it('reports a refused gate and exits 1', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue({
        status: 'refused',
        report: {
          sessionId: 's1',
          passed: false,
          sandbox: 'sandbox-exec (macOS)',
          stages: [{ stage: 'diff-size', status: 'flagged', detail: 'big diff' }],
        },
        rejectCount: 0,
      });

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(logs).toContain(
        'Merge refused: diff-size flagged. Re-run with --accept-debt "<reason>" --review-by ' +
          '"<condition>", or steer the session to address the flags.',
      );
      expect(process.exitCode).toBe(1);
    });

    // The live report is the one the operator reads while the gate runs, and a
    // stage detail is a failing command's stderr out of the session's worktree.
    // `pup review`'s copy of the same report has been scrubbed since decision
    // 67; this one had not (decision 68).
    it('scrubs the gate report it prints', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue({
        status: 'refused',
        report: {
          sessionId: 's1',
          passed: false,
          sandbox: '\u001b[2Jnone',
          stages: [{ stage: '\u001b[2Jdiff-size', status: 'flagged', detail: '\u001b[2Jbig diff' }],
        },
        rejectCount: 0,
      });

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      const page = logs.join('\n');
      expect(page).toContain('[2Jdiff-size');
      expect(page).toContain('[2Jbig diff');
      expect(page).toContain('sandbox          [2Jnone');
      expect(page).not.toContain('\u001b');
    });

    // Why per line and not whole: `printGateStage`'s doc (decision 68).
    it('scrubs a multi-line stage detail line by line, keeping every line', async () => {
      useCwd(initRepoWithAdapter());
      const paths = Array.from({ length: 12 }, (_, i) => `\u001b[2Jsrc/out-of-scope-${i}.ts`);
      vi.mocked(runMergeGate).mockResolvedValue({
        status: 'refused',
        report: {
          sessionId: 's1',
          passed: false,
          sandbox: 'none',
          stages: [{ stage: 'scope-audit', status: 'flagged', detail: paths.join('\n') }],
        },
        rejectCount: 0,
      });

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      const shown = logs.filter((line) => line.includes('[2Jsrc/out-of-scope-'));
      expect(shown).toHaveLength(12);
      // The first path rides the stage line; the rest are indented under it.
      expect(shown[0]).toContain('scope-audit');
      expect(shown.at(-1)).toBe('    [2Jsrc/out-of-scope-11.ts');
      expect(logs.join('\n')).not.toContain('\u001b');
    });

    it('reports a rejected gate and exits 1', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue({
        status: 'rejected',
        report: { sessionId: 's1', passed: false, sandbox: 'sandbox-exec (macOS)', stages: [] },
        rejectCount: 1,
      });

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(logs).toContain('Gate failed; report re-injected into the session (rejection 1/2).');
      expect(process.exitCode).toBe(1);
    });

    it('reports a blocked gate and exits 1', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue({
        status: 'blocked',
        report: { sessionId: 's1', passed: false, sandbox: 'sandbox-exec (macOS)', stages: [] },
        rejectCount: 2,
      });

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(logs).toContain(
        'Gate failed; session parked as blocked — needs a human. Address it, then `pup unblock s1`.',
      );
      expect(process.exitCode).toBe(1);
    });

    it('forwards --accept-debt/--review-by, attributed to the human the guard admits', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue(mergedOutcome());

      await buildProgram().parseAsync(
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

    it('throws when run outside any git repo (no project to resolve)', async () => {
      useCwd(tempDir('pup-cli-noproj-'));

      await expect(buildProgram().parseAsync(['merge', 's1'], { from: 'user' })).rejects.toThrow();
    });

    it('records the approver an operator names instead of human', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockResolvedValue(mergedOutcome());

      await buildProgram().parseAsync(
        ['merge', 's1', '--accept-debt', 'r', '--review-by', 'c', '--approved-by', 'tg:alexis'],
        { from: 'user' },
      );

      expect(firstCall(runMergeGate)[1].acceptDebt?.acceptedBy).toBe('tg:alexis');
    });

    it('refuses --approved-by without --accept-debt', async () => {
      useCwd(initRepoWithAdapter());

      await buildProgram().parseAsync(['merge', 's1', '--approved-by', 'tg:alexis'], {
        from: 'user',
      });

      expect(errors).toEqual([
        '--approved-by names who accepted the debt; pass it with --accept-debt.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    // Scrubbing to nothing must not fall back to the operator's `human`.
    it.each([[''], ['\u001b\u0007 ']])(
      'refuses an --approved-by that scrubs to nothing (%j)',
      async (who) => {
        useCwd(initRepoWithAdapter());

        await buildProgram().parseAsync(
          ['merge', 's1', '--accept-debt', 'r', '--review-by', 'c', '--approved-by', who],
          { from: 'user' },
        );

        expect(errors).toEqual(['--approved-by needs a name, such as tg:<user>.']);
        expect(runMergeGate).not.toHaveBeenCalled();
      },
    );

    /**
     * The conductor gates with --pr and relays a human's debt approval, which
     * arrives from outside the VM (a Telegram click); the ledger names that
     * approver rather than the operator's `human` (decision 75).
     */
    describe('from the conductor', () => {
      beforeEach(() => {
        vi.stubEnv('PUP_CONDUCTOR', 'p1');
      });

      it('runs the gate and opens the PR with --pr', async () => {
        useCwd(initRepoWithAdapter());
        vi.mocked(runMergeGate).mockResolvedValue(
          mergedOutcome({ prUrl: 'https://github.com/acme/repo/pull/7', prWasAdopted: false }),
        );

        await buildProgram().parseAsync(['merge', 's1', '--pr'], { from: 'user' });

        expect(firstCall(runMergeGate)[1].openPr).toBe(true);
        expect(logs).toContain(
          'Gate passed; opened https://github.com/acme/repo/pull/7 — merge it there, then run `pup land s1`.',
        );
        expect(process.exitCode).toBeUndefined();
      });

      it('is refused accepting debt without naming the approver', async () => {
        useCwd(initRepoWithAdapter());

        await buildProgram().parseAsync(
          ['merge', 's1', '--pr', '--accept-debt', 'r', '--review-by', 'c'],
          {
            from: 'user',
          },
        );

        expect(errors).toEqual([
          'The conductor relays a debt approval, it does not give one: pass --approved-by <who> with --accept-debt.',
        ]);
        expect(process.exitCode).toBe(1);
        expect(runMergeGate).not.toHaveBeenCalled();
      });

      it.each(['human', 'Human'])(
        "is refused wearing the operator's own entry (%s)",
        async (who) => {
          useCwd(initRepoWithAdapter());

          await buildProgram().parseAsync(
            ['merge', 's1', '--pr', '--accept-debt', 'r', '--review-by', 'c', '--approved-by', who],
            { from: 'user' },
          );

          expect(errors).toEqual([
            '--approved-by names the person who approved, not `human`; use <channel>:<name>.',
          ]);
          expect(process.exitCode).toBe(1);
          expect(runMergeGate).not.toHaveBeenCalled();
        },
      );

      it('records the approver it names, and `pup debt` prints it', async () => {
        const repo = initRepoWithAdapter();
        useCwd(repo);
        // Stands in for the gate's ledger write, which merge-gate.test.ts
        // covers: the entry carries whatever acceptor the request names.
        vi.mocked(runMergeGate).mockImplementation(async (db, request) => {
          ensureProject(db, projectId(repo), repo);
          insertLedgerEntry(db, {
            projectId: projectId(repo),
            description: 'diff-size flagged',
            files: ['src/a.ts'],
            reason: request.acceptDebt?.reason ?? '',
            acceptedBy: request.acceptDebt?.acceptedBy ?? '',
            reviewBy: request.acceptDebt?.reviewBy ?? '',
          });
          return mergedOutcome();
        });

        await buildProgram().parseAsync(
          [
            'merge',
            's1',
            '--pr',
            '--accept-debt',
            'deadline',
            '--review-by',
            'before v2',
            '--approved-by',
            'tg:alexis',
          ],
          { from: 'user' },
        );
        logs.length = 0;
        buildProgram().parse(['debt'], { from: 'user' });

        expect(firstCall(runMergeGate)[1].acceptDebt).toEqual({
          reason: 'deadline',
          reviewBy: 'before v2',
          acceptedBy: 'tg:alexis',
        });
        expect(logs.some((l) => l.includes('accepted by: tg:alexis'))).toBe(true);
      });

      it('scrubs a control character out of the approver before the gate sees it', async () => {
        useCwd(initRepoWithAdapter());
        vi.mocked(runMergeGate).mockResolvedValue(mergedOutcome());

        await buildProgram().parseAsync(
          [
            'merge',
            's1',
            '--pr',
            '--accept-debt',
            'r',
            '--review-by',
            'c',
            '--approved-by',
            '\u001b[2Jtg:alexis\n',
          ],
          { from: 'user' },
        );

        expect(firstCall(runMergeGate)[1].acceptDebt?.acceptedBy).toBe('[2Jtg:alexis');
      });
    });
  });
});
