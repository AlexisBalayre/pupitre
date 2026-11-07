import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';

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
  deadTurnError,
  launchWatcher,
  SessionPaneMissingError,
  SteerNotDeliveredError,
  saveSessionEnv,
  transcriptDir,
} from '../claude/session-runtime.service.js';
import { waitForCiReview } from '../core/ci-wait.service.js';
import {
  ConductorTellRefusedError,
  isConductorRunning,
  startConductor,
  stopConductor,
  tellConductor,
} from '../core/conductor.service.js';
import { DEFAULT_BASE_PROFILE } from '../core/default-profile.constants.js';
import { startFixRound } from '../core/fix-round.service.js';
import { gitDiffPaths } from '../core/git-diff.client.js';
import { intentTemplate } from '../core/intent.service.js';
import { runMergeGate } from '../core/merge-gate.service.js';
import { projectId } from '../core/paths.utils.js';
import { InvalidProfileError } from '../core/profile.errors.js';
import { getSession, listEvents, transitionSession } from '../core/session.repository.js';
import { STALLED_AFTER_MS } from '../core/session-activity.constants.js';
import {
  hardRespawnSession,
  requestHandoff,
  respawnSession,
} from '../core/session-handoff.service.js';
import { LaunchRolledBackError } from '../core/session-lifecycle.errors.js';
import {
  createSession,
  killSession,
  launchTask,
  planTask,
  sessionPane,
  steerSession,
} from '../core/session-lifecycle.service.js';
import { RESUME_MESSAGE } from '../core/turn-watchdog.service.js';
import {
  firstCall,
  GIT_ENV,
  initRepo,
  initRepoWithAdapter,
  markDormant,
  registerProject,
  rolledBackLaunch,
  seedBacklogTask,
  seedBlockedSession,
  seedEventsFile,
  seedKilledSession,
  seedLedgerEntry,
  seedSession,
  seedStalledSession,
  stubCodegraph,
  worktreeOf,
} from '../test/helpers/cli-index.mock.js';
import { buildProgram } from './index.js';
import { ProjectResolutionError, resolveProject } from './project.utils.js';

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

  describe('watch', () => {
    // The radar is a window like any other: its attach line is pinned against
    // a stale prefix match and quoted for the shell it is pasted into.
    it('prints a pasteable attach line for the radar it started', () => {
      const repo = initRepo();
      useCwd(repo);
      const target = `pup-watch-${projectId(repo)}`;
      vi.mocked(launchWatcher).mockReturnValue({ target });

      buildProgram().parse(['watch', '--start'], { from: 'user' });

      expect(logs).toEqual([
        `Conflict radar running (tmux: ${target}). Watch it: tmux attach -t '=${target}:'`,
      ]);
    });

    it('says the radar is paused on a detached main checkout, never clear', () => {
      const repo = initRepo();
      useCwd(repo);
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
      git('commit', '-q', '--allow-empty', '-m', 'base');
      git('checkout', '-q', '--detach');

      buildProgram().parse(['watch', '--once'], { from: 'user' });

      expect(logs).toEqual([expect.stringContaining('radar paused — main checkout is detached')]);
      expect(logs.join('\n')).not.toContain('clear');
    });

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

    // The radar prints the pair itself rather than through the snapshot the
    // dashboard scrubs, so the ids get the sanitizer here too (decision 68).
    it('scrubs both session ids of an overlapping pair', () => {
      const repo = initRepo();
      useCwd(repo);
      for (const id of ['\u001b[2Js1', '\u001b[2Js2']) {
        seedSession(repo, id);
        const { db } = resolveProject(repo);
        transitionSession(db, id, 'running');
        db.close();
      }
      vi.mocked(gitDiffPaths).mockReturnValue(['src/a.ts']);

      buildProgram().parse(['watch', '--once'], { from: 'user' });

      const line = logs.find((l) => l.includes('OVERLAP')) ?? '';
      expect(line).toContain('[2Js1');
      expect(line).toContain('[2Js2');
      expect(line).not.toContain('\u001b');
    });
  });

  describe('usage', () => {
    it('refuses a session running it from its worktree', () => {
      const own = initRepo();
      const worktree = join(own, '.worktrees', 's1');
      mkdirSync(worktree, { recursive: true });
      seedSession(own, 's1', worktree);
      useCwd(worktree);

      buildProgram().parse(['usage'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('operator-only')]);
      expect(logs).toEqual([]);
    });

    it('refuses the conductor', () => {
      useCwd(initRepo());
      vi.stubEnv('PUP_CONDUCTOR', 'p1');

      buildProgram().parse(['usage'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('operator-only')]);
      expect(logs).toEqual([]);
    });

    it('prints the report as text, or as JSON with --json', () => {
      useCwd(initRepo());
      vi.stubEnv('HOME', tempDir('pup-cli-usage-home-'));

      buildProgram().parse(['usage', '--since', '2026-10-21'], { from: 'user' });
      buildProgram().parse(['usage', '--json'], { from: 'user' });

      expect(logs[0]).toContain('Usage since 2026-10-21T00:00:00.000Z: $0.00 over 0 calls');
      expect(JSON.parse(logs[1] as string)).toMatchObject({ rows: [], totalCost: 0 });
      expect(process.exitCode).toBeUndefined();
    });

    it('reads the transcripts of the config dir --session-env names', () => {
      const repo = initRepo();
      useCwd(repo);
      const configDir = tempDir('pup-cli-usage-config-');
      saveSessionEnv(repo, ['CLAUDE_CONFIG_DIR']);
      vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
      vi.stubEnv('HOME', tempDir('pup-cli-usage-home-'));
      const dir = transcriptDir(join(repo, '.worktrees', 's1'), configDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'a.jsonl'),
        `${JSON.stringify({
          type: 'assistant',
          requestId: 'r1',
          timestamp: '2026-10-22T10:00:00Z',
          message: { model: 'claude-opus-5-5', usage: { input_tokens: 5 } },
        })}\n`,
      );

      buildProgram().parse(['usage', '--since', '2026-10-21', '--json'], { from: 'user' });

      expect(JSON.parse(logs[0] as string).rows).toMatchObject([{ class: 'worker', calls: 1 }]);
    });

    it('escapes DEL and C1 in a planted name under --json', () => {
      const repo = initRepo();
      useCwd(repo);
      const configDir = tempDir('pup-cli-usage-config-');
      saveSessionEnv(repo, ['CLAUDE_CONFIG_DIR']);
      vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
      vi.stubEnv('HOME', tempDir('pup-cli-usage-home-'));
      const dir = transcriptDir(join(repo, '.worktrees', 's1'), configDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'a.jsonl'),
        `${JSON.stringify({
          type: 'assistant',
          requestId: 'r1',
          timestamp: '2026-10-22T10:00:00Z',
          effort: 'hi\u009b2J\u007f',
          message: { model: 'claude-opus-5-5', usage: { input_tokens: 5 } },
        })}\n`,
      );

      buildProgram().parse(['usage', '--since', '2026-10-21', '--json'], { from: 'user' });

      const out = logs[0] as string;
      expect(out).not.toMatch(/[\u007f-\u009f]/);
      expect(out).toContain('hi\\u009b2J\\u007f');
      expect(JSON.parse(out).rows).toMatchObject([{ effort: 'hi\u009b2J\u007f' }]);
    });

    it('refuses a relative CLAUDE_CONFIG_DIR that --session-env passes', () => {
      const repo = initRepo();
      useCwd(repo);
      saveSessionEnv(repo, ['CLAUDE_CONFIG_DIR']);
      vi.stubEnv('CLAUDE_CONFIG_DIR', '~/w4b');

      buildProgram().parse(['usage'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('it must be an absolute path')]);
      expect(logs).toEqual([]);
    });

    it('refuses a date it cannot read', () => {
      useCwd(initRepo());

      buildProgram().parse(['usage', '--since', 'last tuesday-ish'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('--since needs a date')]);
    });
  });

  describe('audit', () => {
    it('reports the NoAdapterError and exits 1 when no adapter detects the repo', async () => {
      useCwd(initRepo());

      await buildProgram().parseAsync(['audit'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('No adapter detected')]);
      expect(logs).toEqual([]);
    });

    it('throws when run outside any git repo (no project to resolve)', async () => {
      useCwd(tempDir('pup-cli-noproj-'));

      await expect(buildProgram().parseAsync(['audit'], { from: 'user' })).rejects.toThrow();
    });

    // The repeat path prints it too, or the capability goes quiet on every run
    // after the first (decision 29).
    it('reports the codegraph capability on the re-run path as well', async () => {
      useCwd(initRepoWithAdapter());
      stubCodegraph('1.6.0');

      await buildProgram().parseAsync(['audit'], { from: 'user' });

      expect(logs).toContain('codegraph: 1.6.0');
    });

    it('reports an absent codegraph on the re-run path too', async () => {
      useCwd(initRepoWithAdapter());
      stubCodegraph();

      await buildProgram().parseAsync(['audit'], { from: 'user' });

      expect(logs).toContain('codegraph: not installed');
    });

    // The repeat path prints its own stage lines rather than `pup init`'s, and
    // a regressed stage carries the failing command's output with it
    // (decision 68).
    it('scrubs the transition lines and the regressed stage output', async () => {
      const repo = initRepo();
      useCwd(repo);
      const adapterYml = join(repo, '.pupitre', 'adapter.yml');
      mkdirSync(join(repo, '.pupitre'), { recursive: true });
      writeFileSync(adapterYml, 'id: probe\nbuild: exit 0\n');
      await buildProgram().parseAsync(['init'], { from: 'user' });
      writeFileSync(adapterYml, 'build: \'printf "bo\\033[2Jom" >&2; exit 1\'\n');
      logs.length = 0;

      await buildProgram().parseAsync(['audit'], { from: 'user' });

      const page = logs.join('\n');
      expect(page).toContain('build    PASS -> FAIL');
      expect(page).toContain('bo [2Jom');
      expect(page).not.toContain('\u001b');
      expect(process.exitCode).toBe(1);
    });

    it('prints every line of a regressed stage, not only the last', async () => {
      const repo = initRepo();
      useCwd(repo);
      const adapterYml = join(repo, '.pupitre', 'adapter.yml');
      mkdirSync(join(repo, '.pupitre'), { recursive: true });
      writeFileSync(adapterYml, 'id: probe\nbuild: exit 0\n');
      await buildProgram().parseAsync(['init'], { from: 'user' });
      writeFileSync(
        adapterYml,
        'build: \'printf "FAIL named test\\nexpected 1\\n[1/1]\\n" >&2; exit 1\'\n',
      );
      logs.length = 0;

      await buildProgram().parseAsync(['audit'], { from: 'user' });

      expect(logs).toContain('    FAIL named test');
      expect(logs).toContain('    expected 1');
      expect(logs).toContain('    [1/1]');
    });

    it('keeps the baseline and exits 1 when a debt metric was not measured', async () => {
      const repo = initRepo();
      useCwd(repo);
      const adapterYml = join(repo, '.pupitre', 'adapter.yml');
      mkdirSync(join(repo, '.pupitre'), { recursive: true });
      writeFileSync(
        adapterYml,
        `id: probe\nbuild: exit 0\ndeadCode: echo '[]'\ncoverage: echo '{"files":{"a.ts":{"covered":[1],"instrumented":[1]}}}'\n`,
      );
      await buildProgram().parseAsync(['init'], { from: 'user' });
      const before = baselineRows(repo);
      writeFileSync(
        adapterYml,
        "id: probe\nbuild: exit 0\ndeadCode: echo '[]'\ncoverage: echo boom >&2; exit 1\n",
      );
      logs.length = 0;

      await buildProgram().parseAsync(['audit'], { from: 'user' });

      expect(errors[0]).toMatch(/^probe: coverage not measured — coverage command failed: .*boom/);
      expect(errors).toHaveLength(2);
      expect(errors[1]).toMatch(/^Baseline kept: a debt metric was not measured/);
      expect(logs.join('\n')).toContain('build    PASS');
      // With its wall time, as `pup init` prints it (decision 95).
      expect(logs).toContainEqual(expect.stringMatching(/^ {2}build {4}PASS {13}\d+\.\ds$/));
      // The drift of what did measure still prints, above the refusal.
      expect(logs).toContainEqual(expect.stringMatching(/^ {2}dead-code 0 -> 0\s*$/));
      expect(logs.join('\n')).not.toContain('debt baseline:');
      expect(logs.join('\n')).not.toContain('Baseline refreshed');
      expect(process.exitCode).toBe(1);
      expect(baselineRows(repo)).toEqual(before);
    });

    it('launches no sweep when a debt metric was not measured', async () => {
      const repo = initRepo();
      useCwd(repo);
      const adapterYml = join(repo, '.pupitre', 'adapter.yml');
      mkdirSync(join(repo, '.pupitre'), { recursive: true });
      writeFileSync(
        adapterYml,
        `id: probe\nbuild: exit 0\ncoverage: echo '{"files":{"a.ts":{"covered":[1],"instrumented":[1]}}}'\n`,
      );
      await buildProgram().parseAsync(['init'], { from: 'user' });
      writeFileSync(adapterYml, 'id: probe\nbuild: exit 0\ncoverage: echo boom >&2; exit 1\n');

      await buildProgram().parseAsync(['audit', '--sweep'], { from: 'user' });

      expect(errors.at(-1)).toMatch(/^Baseline kept: a debt metric was not measured/);
      expect(createSession).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('refreshes the baseline when every metric measured', async () => {
      const repo = initRepo();
      useCwd(repo);
      mkdirSync(join(repo, '.pupitre'), { recursive: true });
      writeFileSync(join(repo, '.pupitre', 'adapter.yml'), 'id: probe\nbuild: exit 0\n');
      await buildProgram().parseAsync(['init'], { from: 'user' });

      await buildProgram().parseAsync(['audit'], { from: 'user' });

      expect(logs).toContain('Baseline refreshed.');
      expect(errors).toEqual([]);
      expect(baselineRows(repo).history).toBe(2);
    });

    /** The stored baseline and how many history rows stand behind it. */
    function baselineRows(repo: string): { baseline: string | null; history: number } {
      const { db } = resolveProject(repo);
      const id = projectId(repo);
      const row = db.prepare('SELECT baseline FROM projects WHERE id = ?').get(id) as {
        baseline: string | null;
      };
      const { n } = db
        .prepare('SELECT COUNT(*) AS n FROM baseline_history WHERE project_id = ?')
        .get(id) as { n: number };
      db.close();
      return { baseline: row.baseline, history: n };
    }

    // A sweep is scoped to the whole repo, so it collides with every live
    // session there is; refusing it would make `--sweep` unrunnable whenever
    // anything else runs, and there is no flag to say otherwise (decision 41).
    it('reports the sweep launch that rolled itself back', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(createSession).mockImplementation(() => {
        throw rolledBackLaunch('sweep-abc');
      });

      await buildProgram().parseAsync(['audit', '--sweep'], { from: 'user' });

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

    it('launches a sweep recorded as the audit, with no overlap flag to pass', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(createSession).mockReturnValue('sweep-abc');

      await buildProgram().parseAsync(['audit', '--sweep'], { from: 'user' });

      expect(firstCall(createSession)[1]).toMatchObject({ origin: 'audit' });
      expect(firstCall(createSession)[1]).not.toHaveProperty('allowOverlap');
    });

    // The compile reads the project brief, so a brief over the cap refuses the
    // sweep in one line. The sweep's expected-error list was empty, which made
    // it the one launch path that crashed on it instead (decision 57).
    it('refuses a sweep in one line when the project brief is over the cap', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(createSession).mockImplementation(() => {
        throw new InvalidProfileError('The project brief at /s/brief.md is 9000 characters.');
      });

      await buildProgram().parseAsync(['audit', '--sweep'], { from: 'user' });

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
    ])('refuses `audit%s` when a session is calling', async (_label, flags) => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');

      await buildProgram().parseAsync(['audit', ...flags], { from: 'user' });

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
      vi.mocked(startConductor).mockReturnValue({ name: 'pup-conductor-p1', paneId: '%3' });

      buildProgram().parse(['conductor', '--model', 'fable', '--worker-model', 'opus'], {
        from: 'user',
      });

      expect(firstCall(startConductor)[0]).toMatchObject({
        base: DEFAULT_BASE_PROFILE,
        model: 'fable',
        workerModel: 'opus',
      });
      expect(logs[0]).toBe('Conductor running (tmux: pup-conductor-p1).');
      // Socket and target are both the project's, not the name the stub
      // returned: the window is not on the default server, and the attach has
      // to say so — pinned, and quoted for the shell it is pasted into.
      expect(logs[1]).toMatch(
        /^Attach with: tmux -L pup-conductor-([0-9a-f]{12}) attach -t '=pup-conductor-\1:'$/,
      );
      expect(logs[2]).toBe(
        "Session cap: 4; `pup launch` and `pup new` refuse past it, and only the operator's --over-cap goes beyond.",
      );
      expect(logs).toHaveLength(3);
      expect(process.exitCode).toBeUndefined();
    });

    // Without flags the core picks Opus 5.5 at high (src/core/conductor.test.ts).
    it('hands the conductor an --effort, and leaves both unset without flags', () => {
      useCwd(initRepo());
      vi.mocked(startConductor).mockReturnValue({ name: 'pup-conductor-p1', paneId: '%3' });

      buildProgram().parse(['conductor', 'start'], { from: 'user' });
      buildProgram().parse(['conductor', 'start', '--effort', 'xhigh'], { from: 'user' });

      const calls = vi.mocked(startConductor).mock.calls;
      expect(calls[0]?.[0]).toMatchObject({ model: undefined, effort: undefined });
      expect(calls[1]?.[0]).toMatchObject({ model: undefined, effort: 'xhigh' });
    });

    // The start brings a radar up with it unless one is already sweeping —
    // `startConductor`'s call (src/core/conductor.test.ts), since the store's
    // beat is what decides it. This command is where it is said out loud.
    it('names the conflict radar the start brought up with it', () => {
      useCwd(initRepo());
      vi.mocked(startConductor).mockReturnValue({
        name: 'pup-conductor-p1',
        paneId: '%3',
        radarTarget: 'pup-watch-p1',
      });

      buildProgram().parse(['conductor', 'start'], { from: 'user' });

      expect(logs[3]).toBe(
        'Conflict radar started with it (tmux: pup-watch-p1) — it runs the turn watchdog.',
      );
      expect(logs).toHaveLength(4);
    });

    // Decision 96: the start stores the cap every launch is held to.
    it('hands the start the --max-sessions cap, and 4 without the flag', () => {
      useCwd(initRepo());
      vi.mocked(startConductor).mockReturnValue({ name: 'pup-conductor-p1', paneId: '%3' });

      buildProgram().parse(['conductor', 'start', '--max-sessions', '7'], { from: 'user' });
      buildProgram().parse(['conductor', 'start'], { from: 'user' });

      const calls = vi.mocked(startConductor).mock.calls;
      expect(calls[0]?.[0]).toMatchObject({ maxSessions: 7 });
      expect(calls[1]?.[0]).toMatchObject({ maxSessions: 4 });
      expect(logs).toContain(
        "Session cap: 7; `pup launch` and `pup new` refuse past it, and only the operator's --over-cap goes beyond.",
      );
    });

    it.each(['0', '-2', '2.5', 'many'])('refuses --max-sessions %s, starting nothing', (cap) => {
      useCwd(initRepo());

      buildProgram().parse(['conductor', 'start', '--max-sessions', cap], { from: 'user' });

      expect(errors).toEqual(['--max-sessions takes a whole number of at least 1.']);
      expect(process.exitCode).toBe(1);
      expect(startConductor).not.toHaveBeenCalled();
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

    it('names an unknown action as unknown even when a message follows it', () => {
      useCwd(initRepo());

      buildProgram().parse(['conductor', 'restart', 'now'], { from: 'user' });

      expect(errors.join('\n')).toContain('Unknown conductor action');
      expect(errors.join('\n')).not.toContain('takes no message');
    });

    // `startConductor` kills the window itself and answers with both halves
    // (src/core/conductor.test.ts); this command adds the retry, which on a
    // terminal is the command to type again.
    it('prints the refusal, then what was undone and how to try again', () => {
      useCwd(initRepo());
      vi.mocked(startConductor).mockImplementation(() => {
        throw new LaunchRolledBackError(
          'Conductor launch rolled back (window killed)',
          new SteerNotDeliveredError('conductor-p1', 900),
        );
      });

      buildProgram().parse(['conductor'], { from: 'user' });

      expect(errors).toEqual([
        'Steer to session conductor-p1 did not land: 900 chars',
        'Conductor launch rolled back (window killed). Re-run `pup conductor`.',
      ]);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
    });

    // A window that never became ready took no context, so there is no
    // refusal to read: the rollback line is the whole of what happened.
    it('prints the rollback alone when it never became ready to take its context', () => {
      useCwd(initRepo());
      vi.mocked(startConductor).mockImplementation(() => {
        throw new LaunchRolledBackError(
          'Conductor window pup-conductor-p1 never became ready, so its context was not ' +
            'delivered and the window was killed',
        );
      });

      buildProgram().parse(['conductor'], { from: 'user' });

      expect(errors).toEqual([
        'Conductor window pup-conductor-p1 never became ready, so its context was not ' +
          'delivered and the window was killed. Re-run `pup conductor`.',
      ]);
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

    describe('tell', () => {
      it('hands the message to the conductor and says it landed', () => {
        const repo = initRepo();
        useCwd(repo);

        buildProgram().parse(['conductor', 'tell', 'merge t-1 next'], { from: 'user' });

        expect(tellConductor).toHaveBeenCalledWith(repo, 'merge t-1 next');
        expect(logs).toEqual(['Told the conductor; the message landed.']);
        expect(process.exitCode).toBeUndefined();
      });

      it('says so, and fails, when the message did not land', () => {
        useCwd(initRepo());
        vi.mocked(tellConductor).mockReturnValueOnce(false);

        buildProgram().parse(['conductor', 'tell', 'merge t-1 next'], { from: 'user' });

        expect(logs).toEqual([]);
        expect(errors.join('\n')).toContain('The message did not land');
        expect(process.exitCode).toBe(1);
      });

      // Core's refusals (empty, over the limit, no conductor) and a pane gone
      // under it are each the operator's to read, and sent nothing.
      it.each([
        ['a refusal', new ConductorTellRefusedError('No conductor is running for this project.')],
        ['a gone pane', new SessionPaneMissingError('conductor-p1', '%3', 'gone')],
      ])('prints %s as a refusal', (_what, error) => {
        useCwd(initRepo());
        vi.mocked(tellConductor).mockImplementationOnce(() => {
          throw error;
        });

        buildProgram().parse(['conductor', 'tell', 'hello'], { from: 'user' });

        expect(errors).toEqual([error.message]);
        expect(process.exitCode).toBe(1);
      });

      it('hands core an empty message when none was given, for it to refuse', () => {
        const repo = initRepo();
        useCwd(repo);

        buildProgram().parse(['conductor', 'tell'], { from: 'user' });

        expect(tellConductor).toHaveBeenCalledWith(repo, '');
      });

      it.each([
        ['a session', 'PUP_SESSION_ID', 's1'],
        ['the conductor', 'PUP_CONDUCTOR', 'p1'],
      ])('refuses %s', (_who, variable, value) => {
        const repo = initRepo();
        useCwd(repo);
        seedSession(repo, 's1');
        vi.stubEnv(variable, value);

        buildProgram().parse(['conductor', 'tell', 'hello'], { from: 'user' });

        expect(tellConductor).not.toHaveBeenCalled();
        expect(errors).toEqual(['`pup conductor tell` is operator-only.']);
        expect(process.exitCode).toBe(1);
      });

      it('refuses a message given to another action', () => {
        useCwd(initRepo());

        buildProgram().parse(['conductor', 'stop', 'now'], { from: 'user' });

        expect(stopConductor).not.toHaveBeenCalled();
        expect(errors).toEqual([
          '`pup conductor stop` takes no message; `pup conductor tell` does.',
        ]);
        expect(process.exitCode).toBe(1);
      });
    });
  });

  // Decision 126: intents under the repo's docs/intent/, accepted by the operator alone.
  describe('intent', () => {
    function writeIntent(repo: string, name: string, text: string): string {
      const dir = join(repo, 'docs', 'intent');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), text);
      return join(dir, name);
    }

    function draftWith(questions: string[]): string {
      return `${intentTemplate('0001', 'Ship the gate')}\n${questions.join('\n')}\n`;
    }

    it('drafts intents and lists each one by id, status and title', () => {
      const repo = initRepo();
      useCwd(repo);

      buildProgram().parse(['intent', 'new', 'Ship', 'the', 'gate'], { from: 'user' });
      buildProgram().parse(['intent', 'new', 'Second one'], { from: 'user' });
      buildProgram().parse(['intent', 'list'], { from: 'user' });

      expect(logs[0]).toMatch(
        /^Drafted \/.*\/docs\/intent\/0001-ship-the-gate\.md\. Fill it in, then run `pup intent accept 0001`\.$/,
      );
      expect(logs.slice(2)).toEqual([
        `0001  ${'draft'.padEnd(10)}  Ship the gate`,
        `0002  ${'draft'.padEnd(10)}  Second one`,
      ]);
      expect(readFileSync(join(repo, 'docs', 'intent', '0001-ship-the-gate.md'), 'utf8')).toBe(
        intentTemplate('0001', 'Ship the gate'),
      );
      expect(process.exitCode).toBeUndefined();
    });

    it('says so when there is no intent', () => {
      useCwd(initRepo());

      buildProgram().parse(['intent', 'list'], { from: 'user' });

      expect(logs).toEqual([
        'No intents yet; `pup intent new <title>` drafts one in docs/intent/.',
      ]);
    });

    // A title and a refusal both quote a file a session's shell can write.
    it('lists a malformed intent as unreadable, and scrubs every title', () => {
      const repo = initRepo();
      useCwd(repo);
      writeIntent(repo, '0001-a.md', intentTemplate('0001', 'Ship\u009b2J the gate'));
      writeIntent(repo, '0002-b.md', '# 0002. No status\n');

      buildProgram().parse(['intent', 'list'], { from: 'user' });

      expect(logs).toEqual([
        `0001  ${'draft'.padEnd(10)}  Ship2J the gate`,
        `0002  ${'unreadable'.padEnd(10)}  docs/intent/0002-b.md needs exactly one "- Status: draft|accepted|closed" line above its first section, outside any code fence or HTML comment.`,
      ]);
    });

    it('shows an intent', () => {
      const repo = initRepo();
      useCwd(repo);
      writeIntent(repo, '0001-ship.md', draftWith(['- Why?']));

      buildProgram().parse(['intent', 'show', '0001'], { from: 'user' });

      expect(logs).toEqual([draftWith(['- Why?']).trimEnd()]);
    });

    it.each([['show'], ['accept']])('refuses an id that is a path on `intent %s`', (verb) => {
      const repo = initRepo();
      useCwd(repo);
      writeIntent(repo, '0001-ship.md', draftWith(['- a?', '- b?']));

      buildProgram().parse(['intent', verb, '../../0001'], { from: 'user' });

      expect(errors).toEqual([
        'An intent id is four digits, like 0001: never a path, a link or a name.',
      ]);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
    });

    it('accepts a draft with two questions, and names them', () => {
      const repo = initRepo();
      useCwd(repo);
      const path = writeIntent(
        repo,
        '0001-ship.md',
        draftWith(['1. What does the gate pin?', '2. Why re-run it?']),
      );

      buildProgram().parse(['intent', 'accept', '0001'], { from: 'user' });

      expect(logs).toEqual([
        'Accepted intent 0001: Ship the gate.',
        'After review, you must be able to answer:',
        '  - What does the gate pin?',
        '  - Why re-run it?',
      ]);
      expect(readFileSync(path, 'utf8')).toContain('\n- Status: accepted\n');
      expect(process.exitCode).toBeUndefined();
    });

    it('refuses to accept a draft lacking two questions, and leaves it a draft', () => {
      const repo = initRepo();
      useCwd(repo);
      const path = writeIntent(repo, '0001-ship.md', draftWith(['- Why?']));

      buildProgram().parse(['intent', 'accept', '0001'], { from: 'user' });

      expect(errors).toEqual([
        'Intent 0001 has 1 question under "## What I must understand after review"; accepting it ' +
          'takes 2 or 3, one list item each, ending in "?".',
      ]);
      expect(readFileSync(path, 'utf8')).toBe(draftWith(['- Why?']));
      expect(process.exitCode).toBe(1);
    });

    // Drafting and reading are anyone's; accepting is the operator's word.
    it.each([
      ['a session', 'PUP_SESSION_ID', 's1'],
      ['the conductor', 'PUP_CONDUCTOR', 'p1'],
    ])('refuses %s running `intent accept`, and lets it list', (_who, variable, value) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      const path = writeIntent(repo, '0001-ship.md', draftWith(['- a?', '- b?']));
      vi.stubEnv(variable, value);

      buildProgram().parse(['intent', 'accept', '0001'], { from: 'user' });
      buildProgram().parse(['intent', 'list'], { from: 'user' });

      expect(errors).toEqual([
        '`pup intent accept` is operator-only; the operator accepts an intent once they have read it.',
      ]);
      expect(logs).toEqual([`0001  ${'draft'.padEnd(10)}  Ship the gate`]);
      expect(readFileSync(path, 'utf8')).toBe(draftWith(['- a?', '- b?']));
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

    it('launches a task, recorded as the launcher of any overlap it makes', () => {
      useCwd(initRepo());
      vi.mocked(launchTask).mockReturnValue('t-abc-0');

      buildProgram().parse(['launch', 't-abc'], { from: 'user' });

      expect(firstCall(launchTask)[1]).toMatchObject({
        taskId: 't-abc',
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

      buildProgram().parse(['new', 'fix the thing', '--scope', 'src/**'], {
        from: 'user',
      });

      expect(firstCall(createSession)[1]).toMatchObject({
        origin: 'conductor',
        overlapVia: 'conductor',
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

    // The fast-forward moves main; the conductor gates through --pr and the
    // human merges the PR (decision 75).
    it('is refused the local merge, and told to use --pr', async () => {
      useCwd(initRepoWithAdapter());

      await buildProgram().parseAsync(['merge', 's1'], { from: 'user' });

      expect(runMergeGate).not.toHaveBeenCalled();
      expect(errors).toEqual([
        '`pup merge` is operator-only; the conductor reports a finished branch and the operator merges it. Use --pr to gate it and open a pull request.',
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

  // A config dir `--session-env` passes is the launching shell's, and a quoted
  // `~` reaches pup unexpanded: every command that opens a window refuses it in
  // one scrubbed line, before anything is planned, killed or launched — a
  // respawn before its handoff steer and its kill (decision 106).
  describe('a relative CLAUDE_CONFIG_DIR', () => {
    it.each([
      {
        command: 'new',
        args: ['new', 'do the thing', '--scope', 'src/**'],
        opens: [createSession],
      },
      { command: 'launch', args: ['launch', 't-abc'], opens: [launchTask] },
      { command: 'conductor start', args: ['conductor', 'start'], opens: [startConductor] },
      { command: 'fix', args: ['fix', 's1'], opens: [startFixRound] },
      { command: 'respawn', args: ['respawn', 's1'], opens: [requestHandoff, respawnSession] },
      { command: 'kill --respawn', args: ['kill', 's1', '--respawn'], opens: [hardRespawnSession] },
    ])('refuses `pup $command`, opening nothing', async ({ args, opens }) => {
      const repo = initRepo();
      useCwd(repo);
      saveSessionEnv(repo, ['CLAUDE_CONFIG_DIR']);
      vi.stubEnv('CLAUDE_CONFIG_DIR', '~/w4b\u009b');

      await buildProgram().parseAsync(args, { from: 'user' });

      expect(errors).toEqual([
        'CLAUDE_CONFIG_DIR is "~/w4b ", which --session-env passes to every window: ' +
          'it must be an absolute path.',
      ]);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
      for (const open of opens) expect(open).not.toHaveBeenCalled();
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

    it('hands a hard respawn the model and effort the operator names', () => {
      useCwd(initRepo());

      buildProgram().parse(
        ['kill', 's1', '--respawn', '--model', 'claude-opus-5-5', '--effort', 'xhigh'],
        { from: 'user' },
      );

      expect(firstCall(hardRespawnSession)[4]).toEqual({
        model: 'claude-opus-5-5',
        effort: 'xhigh',
      });
    });

    it.each([
      ['--model', 'claude-opus-5-5'],
      ['--effort', 'xhigh'],
    ])('refuses %s on a plain kill, which opens no window', (flag, value) => {
      useCwd(initRepo());

      buildProgram().parse(['kill', 's1', flag, value], { from: 'user' });

      expect(killSession).not.toHaveBeenCalled();
      expect(errors).toEqual([
        '`--model` and `--effort` go with `--respawn`; a plain kill opens no window.',
      ]);
      expect(process.exitCode).toBe(1);
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

  describe('ci wait', () => {
    it('prints the one digest line, with the timeout in minutes', async () => {
      const repo = initRepo();
      useCwd(repo);
      vi.mocked(waitForCiReview).mockResolvedValue({ finished: true, line: 'digest → pup fix s1' });

      await buildProgram().parseAsync(['ci', 'wait', 's1', '--timeout', '2'], { from: 'user' });

      expect(firstCall(waitForCiReview)[1]).toEqual({
        repoPath: repo,
        target: 's1',
        timeoutMs: 120_000,
      });
      expect(logs).toEqual(['digest → pup fix s1']);
      expect(process.exitCode).toBeUndefined();
    });

    it('refuses with the scrubbed reason when the wait cannot start', async () => {
      useCwd(initRepo());
      vi.mocked(waitForCiReview).mockRejectedValue(new Error('No session s9.\u001b[2J'));

      await buildProgram().parseAsync(['ci', 'wait', 's9'], { from: 'user' });

      expect(errors).toEqual(['No session s9. [2J']);
      expect(logs).toEqual([]);
    });

    it('exits non-zero when the wait timed out', async () => {
      useCwd(initRepo());
      vi.mocked(waitForCiReview).mockResolvedValue({
        finished: false,
        line: 'No finished CI review',
      });

      await buildProgram().parseAsync(['ci', 'wait', 's1'], { from: 'user' });

      expect(firstCall(waitForCiReview)[1]).toMatchObject({ timeoutMs: 540_000 });
      expect(logs).toEqual(['No finished CI review']);
      expect(process.exitCode).toBe(1);
    });

    it('is refused to sessions, and refuses a timeout that is no positive number', async () => {
      useCwd(initRepo());
      await buildProgram().parseAsync(['ci', 'wait', 's1', '--timeout', '0'], { from: 'user' });
      expect(errors).toEqual(['--timeout takes a positive number of minutes.']);

      errors.length = 0;
      vi.stubEnv('PUP_SESSION_ID', 's1');
      await buildProgram().parseAsync(['ci', 'wait', 's1'], { from: 'user' });

      expect(errors).toEqual([
        '`pup ci wait` is refused to sessions; the operator or the conductor runs it.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(waitForCiReview).not.toHaveBeenCalled();
    });
  });
});

// `npm link` installs `bin/pup` as a symlink; `process.argv[1]` is that link
// while `import.meta.url` is the resolved file, so without a realpath the
// entry point decides it is being imported and exits 0 without parsing argv.
describe('executable entry point', () => {
  // It spawns a whole `pup` through tsx, which a host other suites load can
  // take past the default 5 s; 20 s as decision 46's kickoff test (decision 94).
  it('parses argv when invoked through a symlink, as the linked `pup` binary is', {
    timeout: 20_000,
  }, () => {
    const link = join(tempDir('pup-bin-'), 'pup');
    symlinkSync(join(process.cwd(), 'src', 'cli', 'index.ts'), link);

    const out = execFileSync(process.execPath, ['--import', 'tsx', link, '--help'], {
      encoding: 'utf8',
      env: GIT_ENV,
      cwd: process.cwd(),
    });

    expect(out).toContain('Usage:');
  });

  // The binary path, not parseAsync from a test: an async action's rejection
  // must reach the entry point's catch, not escape as an unhandled one.
  it("prints a failed async action's refusal on one line, as every other command does", {
    timeout: 20_000,
  }, () => {
    const home = tempDir('pup-home-');
    const env: NodeJS.ProcessEnv = { ...GIT_ENV, HOME: home };
    delete env.PUP_SESSION_ID;
    delete env.PUP_CONDUCTOR;

    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        join(process.cwd(), 'src', 'cli', 'index.ts'),
        'dashboard',
        '--project',
        'ghost',
      ],
      { encoding: 'utf8', env, cwd: process.cwd() },
    );

    expect(run.status).toBe(1);
    expect(run.stderr.trim().split('\n')).toHaveLength(1);
    expect(run.stderr).not.toContain('    at ');
  });
});

/**
 * Store- and adapter-written fields: their text was written by a session, a
 * hook, the conductor or an adapter probe, so none of it may reach the
 * operator's terminal without decision 29's sanitizer (decision 68).
 */
const STORE_WRITTEN_FIELDS = [
  'accepted_by',
  'acceptance',
  'adapters',
  'alternatives',
  'branch',
  'contextBudget',
  'conventions',
  'created_at',
  'description',
  'detail',
  'extends',
  'files',
  'finding',
  'goal',
  'id',
  'move',
  'name',
  'path',
  'reason',
  'repo_path',
  'repoPath',
  'review_by',
  'reviewBy',
  'sandbox',
  'session_id',
  'sessionA',
  'sessionB',
  'sessionId',
  'stage',
  'state',
  'status',
  'summary',
  'worktreePath',
] as const;

/**
 * The two interpolations where a listed name appears only inside a quoted
 * constant — a column label and a fallback sentence — and so is printed rather
 * than read out of a store. Listed whole rather than by a pattern: a sink that
 * grows out of one stops matching and is flagged again.
 */
const CONSTANT_INTERPOLATIONS = [
  "'sandbox'.padEnd(16)",
  "blockedReason(db, session) ?? '(no reason recorded)'",
  // `pup review`'s four counters, reached through a local called `detail`:
  // numbers off the risk row (risk keeps one decimal), not text anything wrote.
  'detail.entry.risk',
  'detail.entry.rejectCount',
  'detail.entry.scopeViolations',
  'detail.entry.overlaps',
  // Integer primary keys, not text: `id INTEGER PRIMARY KEY AUTOINCREMENT` is a
  // rowid alias, and SQLite refuses a non-integer for one whatever wrote the row.
  'entry.id',
  'record.id',
  'c.id',
  // Derivations of the repo path, not the path: a label pup composes and a
  // store path pup built. The path itself prints scrubbed.
  'codegraphLabel(repoPath)',
  'briefPath(repoPath)',
];

type Interpolation = { line: number; expression: string };

/** The 1-based line `at` falls on. */
function lineOf(source: string, at: number): number {
  return source.slice(0, at).split('\n').length;
}

/** Past the closing `quote`, over backslash escapes. */
function skipQuoted(source: string, at: number, quote: string): number {
  for (let i = at; i < source.length; i += 1) {
    if (source[i] === '\\') i += 1;
    else if (source[i] === quote) return i + 1;
  }
  return source.length;
}

/**
 * Past the closing backtick, pushing each top-level `${…}` onto `found`. A
 * nested template is walked with no collector, so an interpolation is reported
 * once, whole, rather than also in pieces.
 */
function skipTemplate(source: string, at: number, found?: Interpolation[]): number {
  let i = at;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
    } else if (source[i] === '`') {
      return i + 1;
    } else if (source.startsWith('${', i)) {
      const end = skipBalanced(source, i + 2, '}');
      found?.push({ line: lineOf(source, i), expression: source.slice(i + 2, end - 1) });
      i = end;
    } else {
      i += 1;
    }
  }
  return i;
}

/**
 * Past the `close` that balances the bracket already opened at `at`, stepping
 * over string, template and comment bodies so a `)` inside one never ends the
 * call early. Hand-rolled rather than a regex: these expressions nest — a
 * ternary whose branch is another template — and a regex that stops at the
 * first `}` reads half of one.
 */
function skipBalanced(source: string, at: number, close: string, found?: Interpolation[]): number {
  let i = at;
  while (i < source.length) {
    const char = source[i];
    if (char === close) return i + 1;
    if (char === "'" || char === '"') i = skipQuoted(source, i + 1, char);
    else if (char === '`') i = skipTemplate(source, i + 1, found);
    else if (char === '(') i = skipBalanced(source, i + 1, ')', found);
    else if (char === '{') i = skipBalanced(source, i + 1, '}', found);
    else if (source.startsWith('//', i)) i = source.indexOf('\n', i) + 1 || source.length;
    else if (source.startsWith('/*', i)) i = source.indexOf('*/', i) + 2;
    else i += 1;
  }
  return i;
}

/** Every top-level `${…}` of every template literal a `console.log` call takes. */
function loggedInterpolations(source: string): Interpolation[] {
  const found: Interpolation[] = [];
  const call = 'console.log(';
  for (let at = source.indexOf(call); at !== -1; at = source.indexOf(call, at + 1)) {
    skipBalanced(source, at + call.length, ')', found);
  }
  return found;
}

/** Those that print a store-written field with neither sanitizer on them. */
function rawStoreSinks(source: string): string[] {
  return (
    loggedInterpolations(source)
      .filter(({ expression }) => !CONSTANT_INTERPOLATIONS.includes(expression))
      // `(?!\()` only: a name followed by `(` is a function, not a field, but a
      // name followed by `.` is often the field itself — `detail.split('\\n')`
      // is the adapter's own text, and an earlier `(?![.(])` here let both of
      // its sinks regress silently.
      .filter(({ expression }) =>
        STORE_WRITTEN_FIELDS.some((field) => new RegExp(`\\b${field}\\b(?!\\()`).test(expression)),
      )
      .filter(({ expression }) => !/sanitizeReason\(|goalHeadline\(/.test(expression))
      .map(({ line, expression }) => `index.ts:${line}: \${${expression}}`)
  );
}

/**
 * Decision 67 left the raw sinks a ceiling rather than a rule, and the ceiling
 * was re-breached twice by ordinary print statements. This reads the CLI's own
 * source so the next one fails the suite instead of shipping (decision 68).
 */
describe('the raw-sink guard over the CLI source', () => {
  it('finds no console.log printing a store-written field raw', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(rawStoreSinks(source)).toEqual([]);
  });

  // Removing a `sanitizeReason` from index.ts is how this was proven by hand;
  // the synthetic source keeps the proof in the suite, and pins what the scan
  // must not flag as well as what it must.
  it('flags a raw interpolation, and leaves the sanitized and constant ones alone', () => {
    // Escaped `\${` throughout: these lines are CLI source under scan, not
    // interpolations of this test's own.
    const source = [
      `console.log(\`  reason: \${entry.reason}\`);`,
      `console.log(\`  reason: \${sanitizeReason(entry.reason)}\`);`,
      `console.log(\`  \${'sandbox'.padEnd(16)} \${sanitizeReason(report.sandbox)}\`);`,
      `console.log(\`  \${stage.detail ? \`  \${sanitizeReason(stage.detail)}\` : ''}\`);`,
      `console.log(\`  goal: \${goalHeadline(spec.goal)} (\${task.summary})\`);`,
      `console.log(\`  rejections: \${detail.entry.rejectCount}\`);`,
      `console.log(\`was blocked: \${blockedReason(db, session) ?? '(no reason recorded)'}\`);`,
      `console.log(\`#\${entry.id}  \${sanitizeReason(entry.created_at)}\`);`,
      `console.log(\`#\${record.id}  session \${sanitizeReason(record.session_id)}\`);`,
      `console.log(\`open debt #\${c.id} (\${sanitizeReason(c.description)})\`);`,
      `console.error(\`  reason: \${entry.reason}\`);`,
      `console.log(\`  files: \${sanitizeReason(record.files)}\`);`,
      `console.log(\`    \${detail.split('\\n').at(-1)}\`);`,
      // `pup profile list`'s row, raw and scrubbed: three layer fields off a
      // YAML file a session's shell can write (decision 69).
      `console.log(\`\${layer.name.padEnd(18)}\${(layer.extends ?? '-').padEnd(18)}\${layer.contextBudget ?? '-'}\`);`,
      `console.log(\`\${sanitizeReason(layer.name).padEnd(18)}\${sanitizeReason(String(layer.extends ?? '-'))}\`);`,
    ].join('\n');

    expect(rawStoreSinks(source)).toEqual([
      `index.ts:1: \${entry.reason}`,
      `index.ts:5: \${task.summary}`,
      `index.ts:13: \${detail.split('\\n').at(-1)}`,
      `index.ts:14: \${layer.name.padEnd(18)}`,
      `index.ts:14: \${(layer.extends ?? '-').padEnd(18)}`,
      `index.ts:14: \${layer.contextBudget ?? '-'}`,
    ]);
  });
});
