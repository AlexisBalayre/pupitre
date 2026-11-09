import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import Database from 'better-sqlite3';
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
// So is the retire's, in session-retire.test.ts.
vi.mock('../core/session-retire.service.js', () => ({ retireSession: vi.fn() }));
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
  GIT_ENV,
  initRepo,
  initRepoWithAdapter,
  rolledBackLaunch,
  seedBlockedSession,
  seedKilledSession,
  seedSession,
  seedStalledSession,
  stubCodegraph,
} from '@test/helpers/cli-index.mock.js';
import {
  attachWindow,
  hasSessionWindow,
  readSessionEnv,
  SessionPaneMissingError,
  SteerNotDeliveredError,
} from '../claude/session-runtime.service.js';
import { isConductorRunning } from '../core/conductor.service.js';
import type { SessionState } from '../core/db.client.js';
import { insertDecisionRecord } from '../core/decision-record.repository.js';
import { DEFAULT_BASE_PROFILE } from '../core/default-profile.constants.js';
import { ciReviewLookup, startFixRound } from '../core/fix-round.service.js';
import { landSession } from '../core/land.service.js';
import { MergeLockLostError } from '../core/merge-gate.errors.js';
import { projectId, projectPaths } from '../core/paths.utils.js';
import { InvalidProfileError } from '../core/profile.errors.js';
import {
  appendEvent,
  ensureProject,
  getSession,
  listEvents,
  transitionSession,
} from '../core/session.repository.js';
import {
  LaunchRolledBackError,
  TerminalSessionError,
  UnknownSessionError,
} from '../core/session-lifecycle.errors.js';
import {
  createSession,
  recordSteerMessage,
  steerSession,
} from '../core/session-lifecycle.service.js';
import { retireSession } from '../core/session-retire.service.js';
import type { LandOutcome } from '../core/types/land.types.js';
import { buildProgram } from './index.js';
import { resolveProject } from './project.utils.js';

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

  // Off darwin with no declaration, both refuse in one line before measuring
  // anything; with it, both print the declared label (decision 78).
  describe.each(['init', 'audit'])('%s off darwin', (command) => {
    it('refuses in one line naming PUP_SANDBOX=vm, and stores nothing', async () => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', undefined);

      await buildProgram().parseAsync([command], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('PUP_SANDBOX=vm')]);
      expect(errors[0]).toContain('unconfined');
      expect(logs).toEqual([]);
    });

    it('runs under the declaration and prints the declared label', async () => {
      useCwd(initRepoWithAdapter());
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', 'vm');

      await buildProgram().parseAsync([command], { from: 'user' });

      expect(logs).toContain('sandbox: vm (declared by operator)');
    });
  });

  describe('init', () => {
    it('reports the NoAdapterError and exits 1 when no adapter detects the repo', async () => {
      useCwd(initRepo());

      await buildProgram().parseAsync(['init'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('No adapter detected')]);
      expect(logs).toEqual([]);
    });

    it('throws when run outside any git repo (no project to resolve)', async () => {
      useCwd(tempDir('pup-cli-noproj-'));

      await expect(buildProgram().parseAsync(['init'], { from: 'user' })).rejects.toThrow();
    });

    // Beside the sandbox line and for the same reason (decision 36): an
    // operator who never sees it cannot tell a fleet whose sessions get a code
    // graph from one whose sessions grep.
    it('reports the installed codegraph version beside the sandbox line', async () => {
      useCwd(initRepoWithAdapter());
      stubCodegraph('codegraph 1.6.0');

      await buildProgram().parseAsync(['init'], { from: 'user' });

      expect(logs).toContain('codegraph: codegraph 1.6.0');
      expect(logs.indexOf('codegraph: codegraph 1.6.0')).toBe(
        logs.findIndex((line) => line.startsWith('sandbox: ')) + 1,
      );
    });

    it('says so when the operator has none — detected like gh and tmux, never required', async () => {
      useCwd(initRepoWithAdapter());
      stubCodegraph();

      await buildProgram().parseAsync(['init'], { from: 'user' });

      expect(logs).toContain('codegraph: not installed');
    });

    it('prints each stage’s wall time (decision 95)', async () => {
      const repo = initRepo();
      useCwd(repo);
      mkdirSync(join(repo, '.pupitre'), { recursive: true });
      writeFileSync(join(repo, '.pupitre', 'adapter.yml'), 'id: probe\nbuild: sleep 0.2\n');

      await buildProgram().parseAsync(['init'], { from: 'user' });

      expect(logs).toContainEqual(
        expect.stringMatching(/^ {2}build {4}PASS {5}(0\.[2-9]|[1-9]\d*\.\d)s$/),
      );
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
    it("records origin's URL and prints it beside the sandbox line", async () => {
      const repo = initRepoWithOrigin();
      useCwd(repo);

      await buildProgram().parseAsync(['init'], { from: 'user' });

      expect(recordedOrigin(repo)).toBe(ORIGIN_URL);
      expect(logs).toContain(`push target: ${ORIGIN_URL}`);
      expect(logs.indexOf(`push target: ${ORIGIN_URL}`)).toBe(
        logs.findIndex((line) => line.startsWith('sandbox: ')) + 2,
      );
    });

    it('says the push target is unrecorded when the repo has no origin to record', async () => {
      useCwd(initRepoWithAdapter());

      await buildProgram().parseAsync(['init'], { from: 'user' });

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
    ])('refuses `init%s` when a session is calling', async (_label, flags) => {
      const repo = initRepoWithOrigin();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');

      await buildProgram().parseAsync(['init', ...flags], { from: 'user' });

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
    // What a window may be handed is the operator's to widen, and never with
    // the peer channel, the credentials or what says what a window is: refused
    // whole, naming the variable, before anything measures (decision 106).
    it.each([
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'PUP_SESSION_ID',
      'TMUX',
      'NODE_OPTIONS',
      'CLAUDECODE',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'LD_PRELOAD',
      'GIT_DIR',
    ])('refuses `init --session-env` naming %s, and stores nothing', async (name) => {
      const repo = initRepoWithOrigin();
      useCwd(repo);

      await buildProgram().parseAsync(['init', '--session-env', `CLAUDE_CONFIG_DIR,${name}`], {
        from: 'user',
      });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([
        `--session-env cannot pass ${name}: it takes only CLAUDE_CONFIG_DIR, ` +
          'CLAUDE_CODE_EFFORT_LEVEL, CLAUDE_CODE_SUBAGENT_MODEL, CLAUDE_CODE_SUBAGENT_MODEL_FORCE, ' +
          'CLAUDE_CODE_ENABLE_TELEMETRY.',
      ]);
      expect(logs).toEqual([]);
      expect(readSessionEnv(repo)).toEqual([]);
      expect(recordedOrigin(repo)).toBeNull();
    });

    it('records the --session-env names, keeps them over a plain `init`, and clears them on ""', async () => {
      const repo = initRepoWithOrigin();
      useCwd(repo);

      await buildProgram().parseAsync(
        ['init', '--session-env', 'CLAUDE_CONFIG_DIR, CLAUDE_CODE_ENABLE_TELEMETRY'],
        { from: 'user' },
      );
      expect(errors).toEqual([]);
      expect(readSessionEnv(repo)).toEqual(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENABLE_TELEMETRY']);
      expect(logs).toContain(
        'Session windows get CLAUDE_CONFIG_DIR, CLAUDE_CODE_ENABLE_TELEMETRY from the launching shell.',
      );

      await buildProgram().parseAsync(['init'], { from: 'user' });
      expect(readSessionEnv(repo)).toEqual(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENABLE_TELEMETRY']);

      await buildProgram().parseAsync(['init', '--session-env', ''], { from: 'user' });
      expect(readSessionEnv(repo)).toEqual([]);
      expect(logs).toContain('Session windows get no extra variables.');
    });

    it('lets the conductor run `init`', async () => {
      const repo = initRepoWithOrigin();
      useCwd(repo);
      vi.stubEnv('PUP_CONDUCTOR', 'p1');

      await buildProgram().parseAsync(['init'], { from: 'user' });

      expect(errors).toEqual([]);
      expect(recordedOrigin(repo)).toBe(ORIGIN_URL);
      const { db } = resolveProject(repo);
      expect(
        db.prepare('SELECT baseline FROM projects WHERE id = ?').get(projectId(repo)),
      ).not.toEqual({ baseline: null });
      db.close();
    });

    it('prints a recorded push target through the sanitizer', async () => {
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

      await buildProgram().parseAsync(['init'], { from: 'user' });

      expect(logs).toContain(`push target: ${ORIGIN_URL} [2Aowned`);
    });

    // The record is made before the stages so a stage that dies cannot lose it
    // (decision 55); the line reporting it has to survive the same death, or a
    // first record lands with no output at all.
    it('prints the recorded push target when a broken toolchain kills the capture', async () => {
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

      await expect(buildProgram().parseAsync(['init'], { from: 'user' })).rejects.toThrow(
        'toolchain cache',
      );

      expect(recordedOrigin(repo)).toBe(ORIGIN_URL);
      expect(logs).toEqual([`push target: ${ORIGIN_URL}`]);
    });

    /** Writes `.pupitre/adapter.yml`, the one way a test repo names its commands. */
    function writeCustomAdapter(repoPath: string, yaml: string): void {
      mkdirSync(join(repoPath, '.pupitre'), { recursive: true });
      writeFileSync(join(repoPath, '.pupitre', 'adapter.yml'), yaml);
    }

    // A finding names the adapter that could not measure, and a custom
    // adapter's id comes out of `.pupitre/adapter.yml` — a file the repo
    // carries, not a constant pup owns (decision 68).
    it('scrubs the findings and the sandbox line of the tail', async () => {
      const repo = initRepo();
      useCwd(repo);
      writeCustomAdapter(repo, 'id: "fa\\e[2Jke"\ncoverage: exit 3\n');

      await buildProgram().parseAsync(['init'], { from: 'user' });

      const page = logs.join('\n');
      expect(page).toContain('adapters: fa [2Jke');
      expect(page).toContain('fa [2Jke: coverage not measured');
      expect(page).not.toContain('\u001b');
    });

    // The stage detail is the last line of a failing command's own output,
    // written by whatever the repo's build script runs (decision 68).
    it("scrubs a failing stage's output", async () => {
      const repo = initRepo();
      useCwd(repo);
      writeCustomAdapter(repo, 'build: \'printf "bo\\033[2Jom" >&2; exit 1\'\n');

      await buildProgram().parseAsync(['init'], { from: 'user' });

      const page = logs.join('\n');
      expect(page).toContain('bo [2Jom');
      expect(page).not.toContain('\u001b');
    });

    it('re-records a moved origin when the operator says it moved', async () => {
      const repo = initRepoWithOrigin();
      useCwd(repo);
      await buildProgram().parseAsync(['init'], { from: 'user' });
      execFileSync('git', ['config', 'remote.origin.url', 'git@github.com:owner/renamed.git'], {
        cwd: repo,
        env: GIT_ENV,
        encoding: 'utf8',
      });

      await buildProgram().parseAsync(['init', '--origin-moved'], { from: 'user' });

      expect(recordedOrigin(repo)).toBe('git@github.com:owner/renamed.git');
      expect(logs).toContain('push target: git@github.com:owner/renamed.git');
    });
  });

  describe('attach', () => {
    it('refuses when no conductor runs, naming `pup conductor start`', () => {
      useCwd(initRepo());
      vi.mocked(isConductorRunning).mockReturnValue(false);

      buildProgram().parse(['attach'], { from: 'user' });

      expect(attachWindow).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
      expect(errors.join('\n')).toContain('`pup conductor start`');
      expect(process.exitCode).toBe(1);
    });

    it('prints the detach hint, then attaches to the conductor of this project', () => {
      const repo = initRepo();
      useCwd(repo);
      vi.mocked(isConductorRunning).mockReturnValue(true);
      let printedBeforeAttach: string[] = [];
      vi.mocked(attachWindow).mockImplementationOnce(() => {
        printedBeforeAttach = [...logs];
        return 0;
      });

      buildProgram().parse(['attach'], { from: 'user' });

      expect(printedBeforeAttach).toEqual([
        'Ctrl-b d detaches and leaves the conductor running; Ctrl-c or /exit would kill it',
      ]);
      expect(attachWindow).toHaveBeenCalledWith({ conductorOf: projectId(repo) });
      expect(process.exitCode).toBeUndefined();
    });

    it("exits with tmux's status when the attach fails", () => {
      useCwd(initRepo());
      vi.mocked(isConductorRunning).mockReturnValue(true);
      vi.mocked(attachWindow).mockReturnValueOnce(1);

      buildProgram().parse(['attach'], { from: 'user' });

      expect(process.exitCode).toBe(1);
    });

    // As `pup status` keeps the socket from them (decision 47).
    it.each([
      ['a session', 'PUP_SESSION_ID', 's1'],
      ['the conductor', 'PUP_CONDUCTOR', 'p1'],
    ])('refuses %s', (_who, variable, value) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.mocked(isConductorRunning).mockReturnValue(true);
      vi.stubEnv(variable, value);

      buildProgram().parse(['attach'], { from: 'user' });

      expect(attachWindow).not.toHaveBeenCalled();
      expect(errors).toEqual(['`pup attach` is operator-only.']);
      expect(process.exitCode).toBe(1);
    });

    describe('<session>', () => {
      it("prints the detach hint, then attaches to that session's window", () => {
        const repo = initRepo();
        useCwd(repo);
        seedSession(repo, 's1');
        let printedBeforeAttach: string[] = [];
        vi.mocked(attachWindow).mockImplementationOnce(() => {
          printedBeforeAttach = [...logs];
          return 0;
        });

        buildProgram().parse(['attach', 's1'], { from: 'user' });

        expect(hasSessionWindow).toHaveBeenCalledWith('s1');
        expect(printedBeforeAttach).toEqual([
          'Ctrl-b d detaches and leaves the session running; Ctrl-c or /exit would kill it',
        ]);
        expect(attachWindow).toHaveBeenCalledWith({ sessionId: 's1' });
        expect(isConductorRunning).not.toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
      });

      it('refuses a session with no live window, attaching nothing', () => {
        const repo = initRepo();
        useCwd(repo);
        seedSession(repo, 's1');
        vi.mocked(hasSessionWindow).mockReturnValueOnce(false);

        buildProgram().parse(['attach', 's1'], { from: 'user' });

        expect(attachWindow).not.toHaveBeenCalled();
        expect(logs).toEqual([]);
        expect(errors).toEqual([
          'Session s1 has no live window to attach to: it has ended, or its window was killed. ' +
            '`pup status --history` shows its state.',
        ]);
        expect(process.exitCode).toBe(1);
      });

      it('refuses a session this project does not hold, before asking tmux', () => {
        useCwd(initRepo());

        buildProgram().parse(['attach', 's-elsewhere'], { from: 'user' });

        expect(hasSessionWindow).not.toHaveBeenCalled();
        expect(attachWindow).not.toHaveBeenCalled();
        expect(errors).toEqual(['No session s-elsewhere.']);
        expect(process.exitCode).toBe(1);
      });

      it("exits with tmux's status when the attach fails", () => {
        const repo = initRepo();
        useCwd(repo);
        seedSession(repo, 's1');
        vi.mocked(attachWindow).mockReturnValueOnce(1);

        buildProgram().parse(['attach', 's1'], { from: 'user' });

        expect(process.exitCode).toBe(1);
      });

      // A session handed another's window could type into it as the operator.
      it.each([
        ['a session', 'PUP_SESSION_ID', 's1'],
        ['the conductor', 'PUP_CONDUCTOR', 'p1'],
      ])('refuses %s', (_who, variable, value) => {
        const repo = initRepo();
        useCwd(repo);
        seedSession(repo, 's1');
        seedSession(repo, 's2');
        vi.stubEnv(variable, value);

        buildProgram().parse(['attach', 's2'], { from: 'user' });

        expect(hasSessionWindow).not.toHaveBeenCalled();
        expect(attachWindow).not.toHaveBeenCalled();
        expect(errors).toEqual(['`pup attach` is operator-only.']);
        expect(process.exitCode).toBe(1);
      });
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
      expect(logs).toContain("Attach with: tmux attach -t '=pup-t-abc-0:'");
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

    it('accepts --allow-overlap on `new` too, with the same notice', () => {
      useCwd(initRepo());
      vi.mocked(createSession).mockReturnValue('t-abc-0');

      buildProgram().parse(['new', 'do the thing', '--scope', 'src/**', '--allow-overlap'], {
        from: 'user',
      });

      expect(errors[0]).toMatch(/^--allow-overlap has no effect/);
      expect(firstCall(createSession)[1]).not.toHaveProperty('allowOverlap');
    });

    it('reports the launch that rolled itself back', () => {
      useCwd(initRepo());
      vi.mocked(createSession).mockImplementation(() => {
        throw rolledBackLaunch('t-new-0');
      });

      buildProgram().parse(['new', 'do the thing', '--scope', 'src/**'], { from: 'user' });

      expect(errors[0]).toBe('Steer to session t-new-0 did not land: 3000 chars');
      expect(errors[1]).toMatch(
        /^Launch rolled back \(session t-new-0 killed\)\. Re-run `pup launch t-[a-z0-9]+`\.$/,
      );
      expect(process.exitCode).toBe(1);
      expect(logs.join('\n')).not.toContain('Launched session');
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

  /**
   * The steer itself, its refusals and its record all live in
   * `steerSession` (src/core/session-lifecycle.test.ts). What this command
   * still owns is reaching it, naming the sender a `--sent` record is
   * attributed to, and turning each refusal into a line and a failing exit
   * rather than a stack.
   */
  describe('steer', () => {
    it('steers an existing session by id', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');

      buildProgram().parse(['steer', 's1', 'do X instead'], { from: 'user' });

      // By session id through the lifecycle, which resolves the pane recorded
      // at launch; the CLI never forms a tmux target itself (decision 46).
      expect(steerSession).toHaveBeenCalledWith(expect.anything(), 's1', 'do X instead', {
        kind: 'manual',
        by: 'operator',
      });
      expect(recordSteerMessage).not.toHaveBeenCalled();
      expect(logs).toContain('Steered session s1.');
      expect(process.exitCode).toBeUndefined();
    });

    // Whoever typed it: a steer is the conductor's or a session's whether it
    // went into the input box or over the peer socket, and a record naming the
    // operator for all three would make the report's account of who corrected
    // a session worthless (decisions 44, 47).
    it.each([
      ['operator', '', ''],
      ['conductor', 'p1', ''],
      // A session pup can identify is named as one, whatever else it exports.
      ['session:s1', 'p1', 's1'],
    ])('names the %s that typed the steer', (by, conductor, session) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.stubEnv('PUP_CONDUCTOR', conductor);
      vi.stubEnv('PUP_SESSION_ID', session);

      buildProgram().parse(['steer', 's1', 'do X instead'], { from: 'user' });

      expect(steerSession).toHaveBeenCalledWith(expect.anything(), 's1', 'do X instead', {
        kind: 'manual',
        by,
      });
    });

    // A message over the peer socket lands whole and never touches the input
    // box, so nothing is typed; the record is what the report and the
    // last-steer queries read, and it names the same sender.
    it.each([
      ['operator', '', ''],
      ['conductor', 'p1', ''],
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
        expect(recordSteerMessage).toHaveBeenCalledWith(expect.anything(), 's1', by);
        expect(logs).toContain('Recorded a message steer to session s1.');
      },
    );

    // Every refusal core throws for a steer, read back as the operator sees
    // it: one line, a failing exit, and no claim that anything was steered.
    it.each([
      ['a session the store does not hold', () => new UnknownSessionError('s1'), 'No session s1.'],
      [
        'a session that has stopped',
        () => new TerminalSessionError('s1', 'killed', 'steer'),
        'Session s1 is killed; nothing to steer.',
      ],
      [
        'a paste that never landed whole',
        () => new SteerNotDeliveredError('s1', 3000),
        'Steer to session s1 did not land: 3000 chars',
      ],
      [
        'a pane that is gone',
        () => new SessionPaneMissingError('s1', '%3', 'gone'),
        "Session s1's pane %3 no longer exists; nothing was sent.",
      ],
    ])('reports %s, and exits 1', (_case, refusal, message) => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.mocked(steerSession).mockImplementation(() => {
        throw refusal();
      });

      buildProgram().parse(['steer', 's1', 'do X instead'], { from: 'user' });

      expect(errors).toEqual([message]);
      expect(process.exitCode).toBe(1);
      expect(logs).not.toContain('Steered session s1.');
    });

    // The same refusals on the record-only path, where nothing was typed.
    it('reports a refused `--sent` record, and exits 1', () => {
      const repo = initRepo();
      useCwd(repo);
      seedKilledSession(repo, 's1');
      vi.mocked(recordSteerMessage).mockImplementation(() => {
        throw new TerminalSessionError('s1', 'killed', 'steer');
      });

      buildProgram().parse(['steer', 's1', 'do X instead', '--sent'], { from: 'user' });

      expect(errors).toEqual(['Session s1 is killed; nothing to steer.']);
      expect(process.exitCode).toBe(1);
      expect(logs).not.toContain('Recorded a message steer to session s1.');
    });

    // A bug is not a refusal: it keeps its stack rather than being printed as
    // a line the operator is meant to act on.
    it('rethrows anything that is not a refusal', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      vi.mocked(steerSession).mockImplementation(() => {
        throw new TypeError('undefined is not a function');
      });

      expect(() => buildProgram().parse(['steer', 's1', 'do X'], { from: 'user' })).toThrow(
        TypeError,
      );
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

  // A decision record is prose the merging session drafted about its own work,
  // and the merge stores it verbatim: `pup log` is where it reaches a terminal.
  describe('log', () => {
    it('scrubs every stored string of a record it prints', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, '\u001b[2Js1');
      const { db } = resolveProject(repo);
      insertDecisionRecord(db, {
        sessionId: '\u001b[2Js1',
        summary: '\u001b[2Jtook the short path',
        alternatives: '\u001b[2Jthe long one',
        conventions: '\u001b[2Jnone broken',
        files: ['src/a.ts'],
      });
      db.close();

      buildProgram().parse(['log'], { from: 'user' });

      const page = logs.join('\n');
      expect(page).toContain('session [2Js1');
      expect(page).toContain('[2Jtook the short path');
      expect(page).toContain('alternatives: [2Jthe long one');
      expect(page).toContain('conventions: [2Jnone broken');
      expect(page).not.toContain('\u001b');
    });

    // A record's prose is whatever the merging session wrote, newlines
    // included, so it is scrubbed line by line and indented under its label
    // rather than folded into one line (decision 68).
    it('keeps a record field that runs to several lines on several lines', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      const { db } = resolveProject(repo);
      insertDecisionRecord(db, {
        sessionId: 's1',
        summary: 'took the short path\n\u001b[2Jand said why',
        alternatives: 'the long one\n\u001b[2Jand the longer one',
        files: ['src/a.ts'],
      });
      db.close();

      buildProgram().parse(['log'], { from: 'user' });

      expect(logs).toContain('  took the short path');
      expect(logs).toContain('  [2Jand said why');
      expect(logs).toContain('  alternatives: the long one');
      expect(logs).toContain('                [2Jand the longer one');
      expect(logs.join('\n')).not.toContain('\u001b');
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

    /**
     * Writes `yaml` as `profiles/<fileName>` in the repo's store: a layer file
     * under `~/.pupitre/<id>/profiles/`, which a session's shell reaches through
     * decision 28's HOME — so every field of one is text a session can write
     * and the operator's terminal then renders (decision 69).
     */
    function plantLayer(repoPath: string, fileName: string, yaml: string): void {
      const { profilesDir } = projectPaths(repoPath);
      mkdirSync(profilesDir, { recursive: true });
      writeFileSync(join(profilesDir, fileName), yaml);
    }

    // Only `name` and `extends` can still carry an escape: decision 71 types
    // `contextBudget` at the parser, so a budget that is not a positive integer
    // never reaches this row.
    it('scrubs the layer fields `profile list` prints in its row', () => {
      const repo = initRepo();
      plantLayer(
        repo,
        'evil.yml',
        'name: "ev\u001b[2Jil"\nextends: "ba\u001b[2Jse"\ncontextBudget: 6000\n',
      );
      useCwd(repo);

      buildProgram().parse(['profile', 'list'], { from: 'user' });

      const row = logs.find((line) => line.startsWith('ev'));
      expect(row).toBe(`${'ev [2Jil'.padEnd(18)}${'ba [2Jse'.padEnd(18)}6000`);
      expect(row).not.toContain('\u001b');
    });

    /**
     * `ProfileLayer` says `extends?: string` and `contextBudget?: number`, and
     * since decision 71 `parseProfileLayer` holds the layer to that instead of
     * printing whatever the YAML held. The refusal reaches the terminal through
     * `loadLayerFile`'s wrap, so it is prefixed with the file name — which is
     * not a field any producer saw, and is scrubbed here like the message. The
     * parser checks `extends` first, so the bad `contextBudget` beside it is
     * inert here; it is the fixture the old row-printing test planted.
     */
    it('refuses a layer whose fields are not the types the interface claims', () => {
      const repo = initRepo();
      plantLayer(repo, 'o\u001b[31mdd.yml', 'name: odd\nextends: 5\ncontextBudget: nine\n');
      useCwd(repo);

      buildProgram().parse(['profile', 'list'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual(['o [31mdd.yml: Profile field `extends` must be a non-empty string.']);
      expect(logs).not.toContain(`${'odd'.padEnd(18)}${'5'.padEnd(18)}nine`);
    });

    /**
     * `yaml.stringify` escapes C0 controls itself — a planted `\u001b` comes
     * out as a literal `\e` — but it emits DEL and the C1 block raw, and
     * `\u009b` is the 8-bit CSI, an escape sequence on its own. So this plants
     * one of those: without the scrub it reaches the terminal intact.
     */
    it('scrubs `profile show` line by line, keeping the dump multi-line', () => {
      const repo = initRepo();
      plantLayer(
        repo,
        'evil.yml',
        'name: evil\nextends: "ba\u009b2Jse"\nconventions: |-\n  first line\n  second line\n',
      );
      useCwd(repo);

      buildProgram().parse(['profile', 'show', 'evil'], { from: 'user' });

      // One call carrying the whole dump, so the lines and the indentation
      // that is a YAML layer's nesting have to survive inside it.
      expect(logs).toEqual([
        [
          'name: evil',
          'extends: "ba 2Jse"',
          'conventions: |-',
          '  first line',
          '  second line',
        ].join('\n'),
      ]);
      expect(logs.join('\n')).not.toContain('\u009b');
    });

    /**
     * The file name reaches the refusal too, and a file name is not a field any
     * producer ever saw, so the source scan cannot stand in for this test.
     */
    it('scrubs a malformed layer refusal line by line, keeping its lines', () => {
      const repo = initRepo();
      plantLayer(repo, 'e\u001b[31m.yml', 'name: [x\u001b[2Jy');
      useCwd(repo);

      buildProgram().parse(['profile', 'list'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toHaveLength(1);
      const [refusal = ''] = errors;
      expect(refusal).not.toContain('\u001b');
      // The parser's report keeps its shape: the offending line under the
      // message, and the caret still under the column it names.
      expect(refusal.split('\n')).toEqual([
        expect.stringContaining('e [31m.yml: '),
        '',
        'name: [x [2Jy',
        '         ^',
      ]);
    });
  });

  describe('land', () => {
    const PR = 'https://github.com/o/r/pull/7';

    function landedOutcome(): LandOutcome {
      return {
        prUrl: PR,
        mergeCommit: 'a'.repeat(40),
        target: 'main',
        targetSha: 'a'.repeat(40),
        fastForwarded: true,
        removedWorktree: true,
        audit: {
          projectId: 'p',
          previous: null,
          baseline: {
            adapters: [],
            capturedAt: '2026-10-14T00:00:00Z',
            stages: [],
          } as unknown as NonNullable<LandOutcome['audit']>['baseline'],
          transitions: [],
          debtTransitions: [],
          hasRegression: false,
          findings: [],
          sandbox: 'sandbox-exec (macOS)',
          unmeasured: [],
          heldOnRegression: false,
        },
      };
    }

    /** A session merged with --pr whose sha the repo's unborn main cannot hold. */
    function seedOpenPr(repo: string): void {
      seedSession(repo, 's1');
      const { db } = resolveProject(repo);
      transitionSession(db, 's1', 'running');
      transitionSession(db, 's1', 'awaiting-review');
      transitionSession(db, 's1', 'merged');
      appendEvent(db, 's1', 'merge', {
        branch: 'pup/s1',
        sha: 'f'.repeat(40),
        target: 'main',
        files: [],
        prUrl: PR,
      });
      db.close();
    }

    // A session landing a branch picks the moment the baseline moves, which is
    // why it may not run the audit either (decision 84).
    it('refuses when a session is calling, landing nothing', async () => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      seedOpenPr(repo);
      vi.stubEnv('PUP_SESSION_ID', 's1');

      await buildProgram().parseAsync(['land', 's1'], { from: 'user' });

      expect(errors).toEqual([
        '`pup land` is refused to sessions; the operator or the conductor runs it.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(landSession).not.toHaveBeenCalled();
    });

    // The human merged the PR on GitHub; what is left is the conductor's to run.
    it('lands from the conductor and reports what moved', async () => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      vi.stubEnv('PUP_CONDUCTOR', projectId(repo));
      vi.mocked(landSession).mockResolvedValue(landedOutcome());

      await buildProgram().parseAsync(['land', 's1'], { from: 'user' });

      expect(firstCall(landSession)[1]).toMatchObject({ repoPath: repo, sessionId: 's1' });
      expect(logs).toContain(
        `Landed s1: ${PR} merged as ${'a'.repeat(40)}; main fast-forwarded to ${'a'.repeat(40)}.`,
      );
      expect(logs).toContain('Removed the session worktree.');
      expect(process.exitCode).toBeUndefined();
    });

    it('names a kept branch and a target that already held the merge', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(landSession).mockResolvedValue({
        ...landedOutcome(),
        fastForwarded: false,
        removedWorktree: false,
        keptBranch: 'pup/s1',
      });

      await buildProgram().parseAsync(['land', 's1'], { from: 'user' });

      expect(logs).toContain(
        `Landed s1: ${PR} merged as ${'a'.repeat(40)}; main already held it at ${'a'.repeat(40)}.`,
      );
      expect(logs).toContain('Kept pup/s1: it holds commits main does not.');
      expect(logs).not.toContain('Removed the session worktree.');
    });

    // It ends on the audit, which runs children: refused before anything moves (decision 78).
    it('refuses off darwin with no sandbox declared, landing nothing', async () => {
      useCwd(initRepoWithAdapter());
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', undefined);

      await buildProgram().parseAsync(['land', 's1'], { from: 'user' });

      expect(errors).toEqual([expect.stringContaining('PUP_SANDBOX=vm')]);
      expect(process.exitCode).toBe(1);
      expect(landSession).not.toHaveBeenCalled();
    });

    // The land named each peer it could not steer before its audit started; the
    // command adds no second line for them and exits as the audit says (decision 99).
    it('exits 0 with its audit outcome when a peer went unsteered', async () => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      vi.mocked(landSession).mockResolvedValue({
        ...landedOutcome(),
        unsteered: [{ sessionId: 's2', reason: 'tmux: server exited' }],
      });

      await buildProgram().parseAsync(['land', 's1'], { from: 'user' });

      expect(logs).toContain('No stored baseline yet — captured one now, like `pup init`.');
      expect(logs).toContain(`Project p (${repo})`);
      expect(errors).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    });

    // Landed and steered, and a re-run refuses it, but another run may have run
    // alongside: reported as landed, then failed on the lost lock (decision 88).
    it('reports a land made under a lock that was lost, and fails on it', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(landSession).mockRejectedValue(
        new MergeLockLostError('/repo/.git/pup-merge.lock', landedOutcome()),
      );

      await buildProgram().parseAsync(['land', 's1'], { from: 'user' });

      expect(logs).toContain(
        `Landed s1: ${PR} merged as ${'a'.repeat(40)}; main fast-forwarded to ${'a'.repeat(40)}.`,
      );
      expect(logs).toContain('No stored baseline yet — captured one now, like `pup init`.');
      expect(errors).toEqual([
        expect.stringMatching(
          /^The merge lock at \/repo\/\.git\/pup-merge\.lock was gone or replaced/,
        ),
      ]);
      expect(process.exitCode).toBe(1);
    });

    it('prints a refusal on one line with its control characters gone', async () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(landSession).mockImplementation(() => {
        throw new Error('PR is OPEN\u001b[2J on GitHub, not MERGED. Nothing was landed.');
      });

      await buildProgram().parseAsync(['land', 's1'], { from: 'user' });

      expect(errors).toEqual(['PR is OPEN [2J on GitHub, not MERGED. Nothing was landed.']);
      expect(process.exitCode).toBe(1);
    });

    it('drops the PR from the status inbox once the landed event exists', () => {
      const repo = initRepo();
      useCwd(repo);
      seedOpenPr(repo);

      buildProgram().parse(['status'], { from: 'user' });
      expect(logs).toContain(`  s1  PR opened, not landed  → ${PR}`);

      logs.length = 0;
      const { db } = resolveProject(repo);
      appendEvent(db, 's1', 'landed', { sha: 'a'.repeat(40), target: 'main', prUrl: PR });
      db.close();
      buildProgram().parse(['status'], { from: 'user' });

      expect(logs.join('\n')).not.toContain('PR opened');
    });
  });

  describe('retire', () => {
    const PR = 'https://github.com/o/r/pull/7';
    const SUPERSEDING = 'https://github.com/o/r/pull/9';

    it('refuses a session running it from its worktree, retiring nothing', async () => {
      const repo = initRepo();
      const worktree = join(repo, '.worktrees', 's1');
      mkdirSync(worktree, { recursive: true });
      seedSession(repo, 's1', worktree);
      useCwd(worktree);

      await buildProgram().parseAsync(['retire', 's1', '--superseded-by', '9'], { from: 'user' });

      expect(errors).toEqual([
        '`pup retire` is operator-only; sessions and the conductor cannot run it.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(retireSession).not.toHaveBeenCalled();
    });

    it('refuses the conductor, retiring nothing', async () => {
      const repo = initRepo();
      useCwd(repo);
      vi.stubEnv('PUP_CONDUCTOR', projectId(repo));

      await buildProgram().parseAsync(['retire', 's1', '--superseded-by', '9'], { from: 'user' });

      expect(errors).toEqual([
        '`pup retire` is operator-only; sessions and the conductor cannot run it.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(retireSession).not.toHaveBeenCalled();
    });

    it('refuses without --superseded-by, retiring nothing', async () => {
      useCwd(initRepo());

      await buildProgram().parseAsync(['retire', 's1'], { from: 'user' });

      expect(errors).toEqual([
        '`pup retire` needs `--superseded-by <pr>`, the merged PR that re-landed the work.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(retireSession).not.toHaveBeenCalled();
    });

    it('retires and reports what it removed and kept', async () => {
      const repo = initRepo();
      useCwd(repo);
      vi.mocked(retireSession).mockResolvedValue({
        prUrl: PR,
        supersededBy: SUPERSEDING,
        removedWorktree: true,
        keptBranch: 'pup/s1',
      });

      await buildProgram().parseAsync(['retire', 's1', '--superseded-by', '9'], { from: 'user' });

      expect(firstCall(retireSession)[1]).toEqual({
        repoPath: repo,
        sessionId: 's1',
        supersededBy: '9',
        wait: true,
      });
      expect(logs).toEqual([
        `Retired s1: ${PR} was closed, superseded by ${SUPERSEDING}.`,
        'Removed the session worktree.',
        'Kept pup/s1: it holds commits past the sha its PR carried.',
      ]);
      expect(process.exitCode).toBeUndefined();
    });

    it('prints a refusal on one line with its control characters gone', async () => {
      useCwd(initRepo());
      vi.mocked(retireSession).mockImplementation(() => {
        throw new Error('PR is OPEN\u001b[2J on GitHub, not CLOSED. Nothing was retired.');
      });

      await buildProgram().parseAsync(['retire', 's1', '--superseded-by', '9'], { from: 'user' });

      expect(errors).toEqual(['PR is OPEN [2J on GitHub, not CLOSED. Nothing was retired.']);
      expect(process.exitCode).toBe(1);
    });
  });

  describe('fix', () => {
    const PR = 'https://github.com/o/r/pull/7';
    const HEAD = 'c'.repeat(40);

    /** A session merged with --pr, its PR open. */
    function seedOpenPr(repo: string): void {
      seedSession(repo, 's1');
      const { db } = resolveProject(repo);
      transitionSession(db, 's1', 'running');
      transitionSession(db, 's1', 'awaiting-review');
      transitionSession(db, 's1', 'merged');
      appendEvent(db, 's1', 'merge', {
        branch: 'pup/s1',
        sha: 'f'.repeat(40),
        target: 'main',
        files: [],
        prUrl: PR,
      });
      db.close();
    }

    // A fix round kicks a worker off with what a reviewer wrote about session
    // code (decision 90): a session does not start one.
    it('refuses when a session is calling, starting nothing', async () => {
      const repo = initRepo();
      useCwd(repo);
      seedOpenPr(repo);
      vi.stubEnv('PUP_SESSION_ID', 's1');

      await buildProgram().parseAsync(['fix', 's1'], { from: 'user' });

      expect(errors).toEqual([
        '`pup fix` is refused to sessions; the operator or the conductor runs it.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(startFixRound).not.toHaveBeenCalled();
    });

    it("starts the operator's round with its route and says what is next", async () => {
      const repo = initRepo();
      useCwd(repo);
      vi.mocked(startFixRound).mockResolvedValue({
        prUrl: PR,
        head: HEAD,
        threads: 2,
      });

      await buildProgram().parseAsync(
        ['fix', 's1', '--model', 'claude-opus-5-5', '--effort', 'xhigh'],
        { from: 'user' },
      );

      expect(firstCall(startFixRound)[1]).toEqual({
        repoPath: repo,
        sessionId: 's1',
        override: { model: 'claude-opus-5-5', effort: 'xhigh' },
        overrideVia: 'operator',
        base: DEFAULT_BASE_PROFILE,
        windowEnv: { vars: {}, configDir: join(home, '.claude') },
      });
      expect(logs).toEqual([
        `Fix round started for s1: the 2 open threads the CI review left on ${PR} at ${HEAD} went to a fresh window.`,
        'When it is done: `pup review s1`, then `pup merge s1 --pr`.',
      ]);
      expect(process.exitCode).toBeUndefined();
    });

    it('runs from the conductor, whose override never lifts a top-rung refusal', async () => {
      const repo = initRepo();
      useCwd(repo);
      vi.stubEnv('PUP_CONDUCTOR', projectId(repo));
      vi.mocked(startFixRound).mockResolvedValue({
        prUrl: PR,
        head: HEAD,
        threads: 1,
      });

      await buildProgram().parseAsync(['fix', 's1'], { from: 'user' });

      expect(firstCall(startFixRound)[1]).toMatchObject({ overrideVia: 'conductor' });
      expect(logs[0]).toContain('the 1 open thread the CI review left');
    });

    it('prints a refusal on one line with its control characters gone', async () => {
      useCwd(initRepo());
      vi.mocked(startFixRound).mockRejectedValue(
        new Error('PR is CLOSED\u001b[2J on GitHub, not OPEN. No fix round was started.'),
      );

      await buildProgram().parseAsync(['fix', 's1'], { from: 'user' });

      expect(errors).toEqual(['PR is CLOSED [2J on GitHub, not OPEN. No fix round was started.']);
      expect(process.exitCode).toBe(1);
    });

    it('prints a rolled-back round with its refusal and the command to retry', async () => {
      useCwd(initRepo());
      vi.mocked(startFixRound).mockRejectedValue(
        new LaunchRolledBackError(
          'Fix round rolled back (session s1 merged again, its window and worktree gone)',
          new Error('The paste never landed.'),
        ),
      );

      await buildProgram().parseAsync(['fix', 's1'], { from: 'user' });

      expect(errors).toEqual([
        'The paste never landed.',
        'Fix round rolled back (session s1 merged again, its window and worktree gone). Re-run `pup fix s1`.',
      ]);
      expect(process.exitCode).toBe(1);
    });

    // Decision 90: only `pup status` asks GitHub, and the line answers with `pup fix`.
    it('shows what the CI review left in the status inbox', () => {
      const repo = initRepo();
      useCwd(repo);
      seedOpenPr(repo);
      vi.mocked(ciReviewLookup).mockReturnValue(() => ({ openThreads: 2 }));

      buildProgram().parse(['status'], { from: 'user' });

      expect(vi.mocked(ciReviewLookup).mock.calls[0]?.[1]).toBe(repo);
      expect(logs).toContain('  s1  CI review left 2 open threads on its head  → pup fix s1');

      logs.length = 0;
      vi.mocked(ciReviewLookup).mockReturnValue(() => ({ openThreads: 0 }));
      buildProgram().parse(['status'], { from: 'user' });

      expect(logs).toContain(
        '  s1  CI review status reads clean on its head (any repo workflow can set it): read ' +
          `the PR, then your merge click  → ${PR}`,
      );
    });
  });
});
