import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux boundary only: the profile compiler and the filesystem run for
// real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  conductorPane: vi.fn(),
  hasConductorWindow: vi.fn(() => true),
  readInputBox: vi.fn(),
  kickoff: vi.fn(() => true),
  killConductor: vi.fn(),
  launchConductor: vi.fn(({ projectId }: { projectId: string }) => ({
    sessionId: `conductor-${projectId}`,
    paneId: '%3',
    socket: `pup-conductor-${projectId}`,
  })),
  launchWatcher: vi.fn(() => ({ target: 'pup-watch-1' })),
  pasteIntoPane: vi.fn(),
  submitPane: vi.fn(),
}));

import {
  conductorPane,
  hasConductorWindow,
  kickoff,
  killConductor,
  launchConductor,
  launchWatcher,
  pasteIntoPane,
  readInputBox,
  SessionPaneMissingError,
  SteerNotDeliveredError,
  submitPane,
} from '../claude/session-runtime.service.js';
import { tempDir } from '../test/temp-dir.mock.js';
import {
  CI_REVIEW_LOOP,
  ConductorTellRefusedError,
  conductorCheckoutDir,
  DEFAULT_MAX_SESSIONS,
  isConductorRunning,
  maxSessions,
  startConductor,
  stopConductor,
  TELL_MAX_CHARS,
  tellConductor,
} from './conductor.service.js';
import { openStore } from './db.client.js';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { recordWatcherBeat } from './overlap.repository.js';
import { WATCH_STALE_AFTER_MS } from './overlap.service.js';
import { projectId, projectPaths } from './paths.utils.js';
import { LaunchRolledBackError } from './session-lifecycle.errors.js';

const REPO = '/repo';

// Test repos must not inherit the developer's global git config nor GIT_DIR & co.
// — when this suite runs inside a git hook (pre-commit), those would redirect
// every git call at the pupitre repo instead of the temp repo.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/**
 * A PATH with no `codegraph` on it, so the conductor's code graph is a property
 * of the test rather than of the machine running it (decision 51). `git` is
 * still reachable — the exclude line is written with it.
 */
const NO_CODEGRAPH_PATH = '/usr/bin:/bin';

describe('startConductor', () => {
  let home: string;
  let db: Database;
  beforeEach(() => {
    vi.clearAllMocks();
    // projectPaths writes the compiled profile under $HOME/.pupitre.
    home = tempDir('pup-conductor-home-');
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db = openStore(':memory:');
    // A radar sweeping right now, so the start that is under test here brings
    // none up; the radar has a describe of its own below.
    recordWatcherBeat(db, projectId(REPO), new Date());
  });
  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
    vi.mocked(console.error).mockRestore();
  });

  function start(
    overrides: { model?: string; effort?: string; workerModel?: string; maxSessions?: number } = {},
  ) {
    return startConductor({
      db,
      repoPath: REPO,
      base: DEFAULT_BASE_PROFILE,
      claudeUserDir: join(home, '.claude'),
      ...overrides,
    });
  }

  it('compiles the profile beside the sessions, opens the window on it, and kicks its context in', () => {
    const handle = start({ model: 'claude-sonnet-5-5', workerModel: 'opus' });

    const outDir = projectPaths(REPO).conductorCompiledDir;
    expect(handle).toEqual({
      name: `pup-conductor-${projectId(REPO)}`,
      paneId: '%3',
      radarTarget: undefined,
    });
    expect(existsSync(join(outDir, 'settings.json'))).toBe(true);
    expect(existsSync(join(outDir, 'hooks', 'edit-block.sh'))).toBe(true);
    expect(launchConductor).toHaveBeenCalledWith({
      projectId: projectId(REPO),
      repoPath: REPO,
      settingsPath: join(outDir, 'settings.json'),
      route: { model: 'claude-sonnet-5-5', effort: 'high' },
      mcpConfigPath: undefined,
    });
    // The kickoff goes to the pane the launch returned, with the compiled
    // context — the same shape a session's launch has (decision 46) — and
    // carries the socket that pane is on, or it would type into whatever wears
    // the id on the default server (decision 47).
    const [pane, prompt] = vi.mocked(kickoff).mock.calls[0] ?? [];
    expect(pane).toEqual({
      sessionId: `conductor-${projectId(REPO)}`,
      paneId: '%3',
      socket: `pup-conductor-${projectId(REPO)}`,
    });
    expect(prompt).toBe(`${readFileSync(join(outDir, 'context.md'), 'utf8')}\n\n${CI_REVIEW_LOOP}`);
    expect(prompt).toContain('pup launch <task> --model opus');
  });

  // Named in the argv even when the operator named neither, so the user
  // settings the window inherits never decide them (decision 92).
  it('opens the window on Opus 5.5 at high effort by default', () => {
    start();

    expect(vi.mocked(launchConductor).mock.calls[0]?.[0].route).toEqual({
      model: 'claude-opus-5-5',
      effort: 'high',
    });
  });

  it("opens the window on the operator's effort when one is named", () => {
    start({ effort: 'xhigh' });

    expect(vi.mocked(launchConductor).mock.calls[0]?.[0].route).toEqual({
      model: 'claude-opus-5-5',
      effort: 'xhigh',
    });
  });

  // A window with no context is a bypass-permissions agent in the main
  // checkout that has read none of its tier, so the start undoes itself rather
  // than hand back a window to inspect. No refusal rides with this one: the
  // window never said anything, and the rollback line is the whole of it.
  it('kills a window that never became ready, and says so in one line', () => {
    // Once, so the mock's `true` is back for the describes that follow: a
    // `clearAllMocks` clears the calls, not the implementation.
    vi.mocked(kickoff).mockReturnValueOnce(false);

    const error = caught(start) as LaunchRolledBackError;

    expect(error).toBeInstanceOf(LaunchRolledBackError);
    expect(killConductor).toHaveBeenCalledWith(projectId(REPO));
    expect(error.refusal).toBeUndefined();
    expect(error.rolledBack).toBe(
      `Conductor window pup-conductor-${projectId(REPO)} never became ready, so its context ` +
        'was not delivered and the window was killed',
    );
  });

  // The same rollback for a kickoff the window refused: the paste never landed
  // whole (decision 45), or the pane was gone before it could be typed into
  // (decision 46). The refusal rides along — it is why the launch failed — and
  // each front end adds its own retry hint to the rollback clause.
  it.each([
    ['the paste never landed whole', () => new SteerNotDeliveredError('conductor-1', 900)],
    ['the pane was gone', () => new SessionPaneMissingError('conductor-1', '%3', 'gone')],
  ])('kills the window and answers with the refusal when %s', (_case, refusal) => {
    const thrown = refusal();
    vi.mocked(kickoff).mockImplementationOnce(() => {
      throw thrown;
    });

    const error = caught(start) as LaunchRolledBackError;

    expect(error).toBeInstanceOf(LaunchRolledBackError);
    expect(killConductor).toHaveBeenCalledWith(projectId(REPO));
    expect(error.refusal).toBe(thrown);
    expect(error.rolledBack).toBe('Conductor launch rolled back (window killed)');
  });

  // Decision 103: the worker protocol carries the foreground rule, so the
  // conductor neither repeats it per launch nor nudges a turn that ended on one.
  it('kicks off without the per-launch finish-protocol note, and waits out a background shell', () => {
    start();

    const context = String(vi.mocked(kickoff).mock.calls[0]?.[1]);
    expect(context).not.toMatch(/finish (your|the) protocol/i);
    expect(context).toContain('do not repeat that in a launch or a steer');
    expect(context).toContain(
      '`working on a background shell`: it is not idle, so subscribe again and wait for its ' +
        'next notice rather than nudging it.',
    );
  });

  // Decision 96: the start stores the cap every launch is held to, and the
  // kickoff names it with the rule the conductor fills free places by.
  describe('the session cap', () => {
    it('stores the cap it was given, and the kickoff names it', () => {
      start({ maxSessions: 7 });

      expect(maxSessions(REPO)).toBe(7);
      expect(String(vi.mocked(kickoff).mock.calls[0]?.[1])).toContain('Keep 7 sessions live');
    });

    it('stores the default on a start without one, replacing an earlier cap', () => {
      start({ maxSessions: 7 });
      start();

      expect(maxSessions(REPO)).toBe(DEFAULT_MAX_SESSIONS);
      expect(DEFAULT_MAX_SESSIONS).toBe(4);
    });

    it('reads the default before any start, and for a file holding no positive whole number', () => {
      expect(maxSessions(REPO)).toBe(4);

      start();
      for (const garbage of ['0', '-3', '2.5', 'lots', '']) {
        writeFileSync(join(projectPaths(REPO).root, 'conductor', 'max-sessions'), garbage);
        expect(maxSessions(REPO)).toBe(4);
      }
    });

    it('reads the default for a fifo planted as the cap, never blocking on it', () => {
      start({ maxSessions: 7 });
      const file = join(projectPaths(REPO).root, 'conductor', 'max-sessions');
      rmSync(file);
      execFileSync('mkfifo', [file]);

      expect(maxSessions(REPO)).toBe(4);
    });

    it('reads the default for a symlink planted as the cap, never following it', () => {
      start({ maxSessions: 7 });
      const file = join(projectPaths(REPO).root, 'conductor', 'max-sessions');
      const target = join(tempDir('pup-planted-'), 'cap');
      writeFileSync(target, '9\n');
      rmSync(file);
      symlinkSync(target, file);

      expect(maxSessions(REPO)).toBe(4);
    });
  });

  it('writes nothing to the store: the conductor is not a session', () => {
    start();

    expect(existsSync(projectPaths(REPO).dbFile)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  // The radar is the turn watchdog's host, and the conductor is the thing the
  // watchdog exists to keep going: its own waiting turn dies with the worker's,
  // and then nobody resumes either (addendum to decision 35). Whether one is up
  // is the store's beat, not a window name a session could mint.
  describe('the conflict radar it brings with it', () => {
    it.each([
      ['none has ever swept', undefined],
      ['the last beat is stale', WATCH_STALE_AFTER_MS + 1_000],
    ])('starts one when %s, and names the window', (_when, beatAgeMs) => {
      db.prepare('DELETE FROM watcher_beats').run();
      if (beatAgeMs !== undefined) {
        recordWatcherBeat(db, projectId(REPO), new Date(Date.now() - beatAgeMs));
      }

      expect(start().radarTarget).toBe('pup-watch-1');
      expect(launchWatcher).toHaveBeenCalledWith(projectId(REPO), REPO);
    });

    it('leaves a radar that is already sweeping alone', () => {
      expect(start().radarTarget).toBeUndefined();
      expect(launchWatcher).not.toHaveBeenCalled();
    });

    it('starts none for a window that was rolled back', () => {
      db.prepare('DELETE FROM watcher_beats').run();
      vi.mocked(kickoff).mockReturnValueOnce(false);

      expect(start).toThrow(LaunchRolledBackError);
      expect(launchWatcher).not.toHaveBeenCalled();
    });
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

describe('stopConductor and isConductorRunning', () => {
  it('kills and probes the window by the project id', () => {
    stopConductor(REPO);

    expect(killConductor).toHaveBeenCalledWith(projectId(REPO));
    expect(isConductorRunning(REPO)).toBe(true);
    expect(hasConductorWindow).toHaveBeenCalledWith(projectId(REPO));
  });
});

/**
 * The conductor's graph is the main checkout's, indexed at `pup conductor start`
 * and served the way a session's worktree graph is (decision 51). The binary is
 * faked per docs/conventions/testing.md: what is under test is what pup asks
 * codegraph to index and what it then hands `claude`.
 */
describe('startConductor code graph', () => {
  let home: string;
  let repo: string;
  let cgLog: string;
  let db: Database;

  function gitIn(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
  }

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

  const start = () =>
    startConductor({
      db,
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      claudeUserDir: join(home, '.claude'),
    });

  const launchedWith = () => vi.mocked(launchConductor).mock.calls.at(-1)?.[0];
  const kickoffContext = () => vi.mocked(kickoff).mock.calls.at(-1)?.[1];

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    home = tempDir('pup-cg-cond-home-');
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    repo = tempDir('pup-cg-cond-');
    gitIn(repo, 'init', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 't@t');
    gitIn(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'tracked.ts'), 'export const tracked = 1;\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-qm', 'init');
  });

  const checkout = () => conductorCheckoutDir(repo);

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
    vi.mocked(console.error).mockRestore();
  });

  // A detached checkout of the merge target, cut under the project's own state
  // dir — tracked content and nothing else.
  it('cuts a private detached checkout of the merge target', () => {
    fakeCodegraph(INDEXES);

    start();

    expect(existsSync(join(checkout(), 'tracked.ts'))).toBe(true);
    expect(gitIn(checkout(), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(gitIn(checkout(), 'rev-parse', 'HEAD')).toBe(gitIn(repo, 'rev-parse', 'main'));
  });

  // The finding, in one test: a session's Bash is only guarded against
  // `.claude/`, so it can write into the repo root from its own worktree. An
  // untracked source file is returned VERBATIM into the context of the agent
  // that plans, launches and steers every other one, and an untracked
  // `codegraph.json` steers the indexer itself — `{"include":[".worktrees/**"]}`
  // pulls every session's tree in, an `exclude` blinds it. Neither can reach a
  // checkout made of tracked content.
  it('leaves a session-planted root file and codegraph.json out of the checkout', () => {
    fakeCodegraph(INDEXES);
    writeFileSync(join(repo, 'codegraph.json'), '{"include":[".worktrees/**"]}\n');
    writeFileSync(join(repo, 'planted.ts'), 'export const readMe = 1;\n');

    start();

    expect(existsSync(join(checkout(), 'codegraph.json'))).toBe(false);
    expect(existsSync(join(checkout(), 'planted.ts'))).toBe(false);
    expect(existsSync(join(checkout(), 'tracked.ts'))).toBe(true);
  });

  // And the same property is what keeps session worktrees out in a repo whose
  // `.gitignore` does not list `.worktrees/` — without adding a `/.worktrees/`
  // exclude line, which would hide a session-created `<worktree>/.worktrees/`
  // from the gate's clean stage.
  it('leaves session worktrees out even when .gitignore does not list them', () => {
    fakeCodegraph(INDEXES);
    mkdirSync(join(repo, '.worktrees', 's-1'), { recursive: true });
    writeFileSync(join(repo, '.worktrees', 's-1', 'secret.ts'), 'export const s = 1;\n');

    start();

    expect(existsSync(join(checkout(), '.worktrees'))).toBe(false);
  });

  // Refreshed, not re-cut: a second start moves the existing checkout to the
  // target's current tip.
  it('refreshes the checkout on a later start instead of failing on it', () => {
    fakeCodegraph(INDEXES);
    start();
    writeFileSync(join(repo, 'second.ts'), 'export const second = 2;\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-qm', 'second');

    start();

    expect(existsSync(join(checkout(), 'second.ts'))).toBe(true);
    expect(gitIn(checkout(), 'rev-parse', 'HEAD')).toBe(gitIn(repo, 'rev-parse', 'main'));
  });

  // Clearing `~/.pupitre` leaves the worktree registration behind, and
  // `worktree add` refuses the path forever once it does. Without the prune the
  // conductor silently never gets a graph again.
  it('re-cuts the checkout after its directory is deleted out from under it', () => {
    fakeCodegraph(INDEXES);
    start();
    rmSync(checkout(), { recursive: true, force: true });

    start();

    expect(existsSync(join(checkout(), 'tracked.ts'))).toBe(true);
    expect(launchedWith()?.mcpConfigPath).toBeDefined();
  });

  it('indexes the checkout and never the live repo, and leaves both clean', () => {
    fakeCodegraph(INDEXES);

    start();

    expect(cgCalls()).toEqual([`init ${checkout()} --yes`]);
    expect(cgCalls().some((call) => call.includes(` ${repo} `))).toBe(false);
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
    expect(gitIn(checkout(), 'status', '--porcelain')).toBe('');
  });

  it('launches claude against a compiled mcp.json pinned to the checkout', () => {
    const binary = fakeCodegraph(INDEXES);

    start();

    const mcpConfigPath = launchedWith()?.mcpConfigPath as string;
    expect(mcpConfigPath).toBe(join(projectPaths(repo).conductorCompiledDir, 'mcp.json'));
    const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
    expect(config.mcpServers.codegraph.command).toBe(binary);
    expect(config.mcpServers.codegraph.args).toContain(checkout());
    expect(config.mcpServers.codegraph.args).not.toContain(repo);
  });

  // And it is told what it is reading: a snapshot of a pristine copy, not the
  // tree it sits in. An answer out of one checkout believed to be about another
  // is the failure this decision is shaped around.
  it("names the pristine snapshot in the conductor's code-graph section", () => {
    fakeCodegraph(INDEXES);

    start();

    expect(kickoffContext()).toContain('## Code graph');
    expect(kickoffContext()).toContain('codegraph_explore');
    expect(kickoffContext()).toContain('A pristine copy of the merge target');
  });

  // No graph, never the wrong one — and never at the cost of the window.
  it('withholds the mcp config when the index fails, and still opens the window', () => {
    fakeCodegraph('echo "out of disk" >&2\nexit 1');

    expect(start().paneId).toBe('%3');

    expect(launchedWith()?.mcpConfigPath).toBeUndefined();
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('without a code graph');
  });

  it('compiles no mcp.json and no section when the operator has no codegraph', () => {
    start();

    expect(existsSync(join(projectPaths(repo).conductorCompiledDir, 'mcp.json'))).toBe(false);
    expect(launchedWith()?.mcpConfigPath).toBeUndefined();
    expect(kickoffContext()).not.toContain('## Code graph');
  });
});

describe('tellConductor', () => {
  const PANE = { sessionId: `conductor-${projectId(REPO)}`, paneId: '%3', socket: 'sock' };
  /** What reached the pane, in order: each paste's text, each Enter, each look at the box. */
  let typed: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    typed = [];
    vi.mocked(conductorPane).mockReturnValue(PANE);
    vi.mocked(pasteIntoPane).mockImplementation((_pane, message) => {
      typed.push(`paste ${message}`);
      return true;
    });
    vi.mocked(submitPane).mockImplementation(() => {
      typed.push('Enter');
    });
  });

  /** The box answers each look in turn. */
  function box(...answers: Array<'empty' | 'holds' | 'absent'>): void {
    for (const answer of answers) {
      vi.mocked(readInputBox).mockImplementationOnce(() => {
        typed.push(`look ${answer}`);
        return answer;
      });
    }
  }

  it('checks the box is empty, pastes, presses Enter once, and stops once the box is empty again', () => {
    box('empty', 'empty');

    expect(tellConductor(REPO, 'merge t-1 next')).toBe(true);

    expect(conductorPane).toHaveBeenCalledWith(projectId(REPO));
    expect(typed).toEqual(['look empty', 'paste merge t-1 next', 'Enter', 'look empty']);
    expect(vi.mocked(pasteIntoPane).mock.calls[0]?.[0]).toBe(PANE);
  });

  it('presses Enter a second time only while text is still in the box', () => {
    box('empty', 'holds', 'empty');

    expect(tellConductor(REPO, 'merge t-1 next')).toBe(true);

    expect(typed).toEqual([
      'look empty',
      'paste merge t-1 next',
      'Enter',
      'look holds',
      'Enter',
      'look empty',
    ]);
  });

  it('says it did not land when the second Enter leaves text in the box, and stops there', () => {
    box('empty', 'holds', 'holds');

    expect(tellConductor(REPO, 'merge t-1 next')).toBe(false);

    expect(typed.filter((step) => step === 'Enter')).toHaveLength(2);
  });

  it('presses no second Enter on a dialog that replaced the box, and says it did not land', () => {
    box('empty', 'absent');

    expect(tellConductor(REPO, 'merge t-1 next')).toBe(false);

    expect(typed.filter((step) => step === 'Enter')).toHaveLength(1);
  });

  it('presses nothing when the paste never shows whole, and says it did not land', () => {
    box('empty');
    vi.mocked(pasteIntoPane).mockReturnValueOnce(false);

    expect(tellConductor(REPO, 'merge t-1 next')).toBe(false);

    expect(submitPane).not.toHaveBeenCalled();
  });

  it.each(['holds', 'absent'] as const)(
    'refuses, sending nothing, when the box %s before the paste',
    (state) => {
      box(state);

      expect(() => tellConductor(REPO, 'merge t-1 next')).toThrow(
        /holds unsent text.*`pup attach`/,
      );

      expect(pasteIntoPane).not.toHaveBeenCalled();
      expect(submitPane).not.toHaveBeenCalled();
    },
  );

  it('takes a message of exactly the limit', () => {
    box('empty', 'empty');

    expect(tellConductor(REPO, 'x'.repeat(TELL_MAX_CHARS))).toBe(true);
  });

  it.each([
    ['an empty message', ''],
    ['a blank message', '  \n '],
    ['a message over the limit', 'x'.repeat(TELL_MAX_CHARS + 1)],
  ])('refuses %s before looking for a pane or typing anything', (_what, message) => {
    expect(() => tellConductor(REPO, message)).toThrow(ConductorTellRefusedError);

    expect(conductorPane).not.toHaveBeenCalled();
    expect(pasteIntoPane).not.toHaveBeenCalled();
    expect(submitPane).not.toHaveBeenCalled();
  });

  it('names the truncation and the length in the over-limit refusal', () => {
    expect(() => tellConductor(REPO, 'x'.repeat(801))).toThrow(/801 characters.*truncated/);
  });

  it('refuses when no conductor runs, naming `pup conductor start`', () => {
    vi.mocked(conductorPane).mockReturnValue(undefined);

    expect(() => tellConductor(REPO, 'hello')).toThrow(/`pup conductor start`/);

    expect(pasteIntoPane).not.toHaveBeenCalled();
    expect(submitPane).not.toHaveBeenCalled();
  });
});
