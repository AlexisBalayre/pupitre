import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fakes `tmux`/`which` so this suite never spawns a real tmux pane or shells
// out to resolve `claude` and `nice` on PATH — spawning a tmux pane is
// explicitly out of scope for a test process (docs/conventions/testing.md).
// Every other execFileSync call — git, in particular — still runs for real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fakeExecFileSync = vi.fn((file: string, args?: readonly string[], options?: unknown) => {
    // new-session is asked to print the pane it opened (-P -F '#{pane_id}').
    // tmux's own `-L <socket>` comes before the command, so the conductor's
    // calls carry two arguments the default server's do not (decision 47).
    if (file === 'tmux') {
      return (args?.[0] === '-L' ? args[2] : args?.[0]) === 'new-session' ? '%7\n' : '';
    }
    if (file === 'which') return `/fake/bin/${args?.[0]}\n`;
    return (actual.execFileSync as (...callArgs: unknown[]) => unknown)(file, args, options);
  });
  // The attach hands this terminal to tmux; here it hands it to nothing.
  const fakeSpawnSync = vi.fn(() => ({ status: 0 }));
  return { ...actual, execFileSync: fakeExecFileSync, spawnSync: fakeSpawnSync };
});

// Fakes existsSync/writeFileSync for the operator's real ~/.claude.json only —
// launchSession calls preseedTrust internally with no path override, and this
// suite must never read or mutate the developer's live trust config. Every
// other fs call, including the temp-repo fixtures below, still runs for real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const os = await import('node:os');
  const path = await import('node:path');
  const realClaudeJson = path.join(os.homedir(), '.claude.json');
  const fakeExistsSync = vi.fn((target: unknown) =>
    target === realClaudeJson ? false : (actual.existsSync as (t: unknown) => boolean)(target),
  );
  const fakeWriteFileSync = vi.fn((target: unknown, ...rest: unknown[]) => {
    if (target === realClaudeJson) return;
    (actual.writeFileSync as (...callArgs: unknown[]) => void)(target, ...rest);
  });
  return { ...actual, existsSync: fakeExistsSync, writeFileSync: fakeWriteFileSync };
});

import { verifiedWorktreeGitEnv, WorktreeRepointedError } from '../core/git-diff.client.js';
import { tempDir } from '../test/temp-dir.mock.js';
import { CONDUCTOR_ROUTE, LADDERS, type ModelRoute } from './model-ladder.constants.js';
import {
  attachArgs,
  attachCommand,
  attachWindow,
  conductorName,
  conductorPane,
  deadTurnError,
  hasConductorWindow,
  hasSessionWindow,
  interruptPane,
  kickoff,
  killConductor,
  killSession,
  launchArgs,
  launchConductor,
  launchSession,
  launchWatcher,
  pasteIntoPane,
  preseedTrust,
  readInputBox,
  type SessionPane,
  SessionPaneMissingError,
  SteerNotDeliveredError,
  steerPane,
  submitPane,
  transcriptDir,
  windowLabel,
} from './session-runtime.service.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// Test repos must not inherit the developer's global git config nor GIT_DIR & co.
// — when this suite runs inside a git hook (pre-commit), those would redirect
// every git call at the pupitre repo instead of the temp repo.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cwd: string, ...args: string[]): void {
  execFileSync(args[0] as string, args.slice(1), { cwd, encoding: 'utf8', env: GIT_ENV });
}

function initRepoWithWorktree(): { repo: string; worktree: string } {
  const repo = tempDir('pup-trust-');
  sh(repo, 'git', 'init', '-b', 'main');
  sh(repo, 'git', 'config', 'user.email', 'trust@test');
  sh(repo, 'git', 'config', 'user.name', 'trust-test');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  sh(repo, 'git', 'add', '.');
  sh(repo, 'git', 'commit', '-m', 'init');
  sh(repo, 'git', 'worktree', 'add', join(repo, '.worktrees', 'wt'), '-b', 'feature/wt');
  return { repo, worktree: join(repo, '.worktrees', 'wt') };
}

function readProjects(claudeJsonPath: string): Record<string, Record<string, unknown>> {
  return (JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as Record<string, unknown>)
    .projects as Record<string, Record<string, unknown>>;
}

describe('preseedTrust', () => {
  it('seeds trust for the worktree AND the main repo root', () => {
    // Claude Code keys the trust dialog on the git common-dir root, so seeding
    // only the worktree path still leaves the dialog blocking kickoff.
    const { repo, worktree } = initRepoWithWorktree();
    const claudeJson = join(tempDir('pup-cfg-'), 'claude.json');

    preseedTrust(worktree, claudeJson);

    const projects = readProjects(claudeJson);
    expect(projects[worktree]?.hasTrustDialogAccepted).toBe(true);
    expect(projects[repo]?.hasTrustDialogAccepted).toBe(true);
  });

  it('preserves existing project entries and flips declined trust to accepted', () => {
    const { repo, worktree } = initRepoWithWorktree();
    const claudeJson = join(tempDir('pup-cfg-'), 'claude.json');
    writeFileSync(
      claudeJson,
      JSON.stringify({
        numStartups: 3,
        projects: { [repo]: { hasTrustDialogAccepted: false, allowedTools: ['Read'] } },
      }),
    );

    preseedTrust(worktree, claudeJson);

    const config = JSON.parse(readFileSync(claudeJson, 'utf8')) as Record<string, unknown>;
    expect(config.numStartups).toBe(3);
    const projects = readProjects(claudeJson);
    expect(projects[repo]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Read'] });
  });

  // A session window passes its pins: asked of git, the root would be the repo
  // the worktree's pointers name, which the session can choose (decision 101).
  it("seeds the pins' repo root, whatever the worktree's gitfile names", () => {
    const { repo, worktree } = initRepoWithWorktree();
    const pins = verifiedWorktreeGitEnv(repo, worktree);
    const elsewhere = tempDir('pup-elsewhere-');
    sh(elsewhere, 'git', 'init', '-q');
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(elsewhere, '.git')}\n`);
    const claudeJson = join(tempDir('pup-cfg-'), 'claude.json');

    preseedTrust(worktree, claudeJson, pins);

    expect(Object.keys(readProjects(claudeJson)).sort()).toEqual([repo, worktree].sort());
  });

  it('seeds only the launch path when it is not a git checkout', () => {
    const plainDir = tempDir('pup-plain-');
    const claudeJson = join(tempDir('pup-cfg-'), 'claude.json');

    preseedTrust(plainDir, claudeJson);

    const projects = readProjects(claudeJson);
    expect(projects[plainDir]?.hasTrustDialogAccepted).toBe(true);
    expect(Object.keys(projects)).toHaveLength(1);
  });

  it('writes a single entry when launching at the repo root itself', () => {
    const { repo } = initRepoWithWorktree();
    const claudeJson = join(tempDir('pup-cfg-'), 'claude.json');

    preseedTrust(repo, claudeJson);

    const projects = readProjects(claudeJson);
    expect(projects[repo]?.hasTrustDialogAccepted).toBe(true);
    expect(Object.keys(projects)).toHaveLength(1);
  });
});

const OPTS = {
  sessionId: 's-1',
  worktreePath: '/tmp/repo/.worktrees/s-1',
  settingsPath: '/tmp/compiled/settings.json',
  route: LADDERS.standard[0] as ModelRoute,
};

describe('launchArgs', () => {
  it('restricts setting sources to user so repo ask-rules cannot wedge a session (decision 19)', () => {
    const args = launchArgs(OPTS);

    const flag = args.indexOf('--setting-sources');
    expect(flag).toBeGreaterThan(-1);
    expect(args[flag + 1]).toBe('user');
  });

  it('keeps bypass permissions and the compiled settings file', () => {
    const args = launchArgs(OPTS);

    expect(args).toContain('--dangerously-skip-permissions');
    const flag = args.indexOf('--settings');
    expect(args[flag + 1]).toBe(OPTS.settingsPath);
  });

  // Every rung names both, so the user settings the window inherits never
  // decide a worker's model or effort; only the Sonnet rungs fall back, to
  // Opus (decision 92).
  it.each([
    [
      'standard',
      0,
      ['--model', 'claude-sonnet-5-5', '--effort', 'medium', '--fallback-model', 'claude-opus-5-5'],
    ],
    [
      'standard',
      1,
      ['--model', 'claude-sonnet-5-5', '--effort', 'high', '--fallback-model', 'claude-opus-5-5'],
    ],
    ['standard', 2, ['--model', 'claude-opus-5-5', '--effort', 'high']],
    ['standard', 3, ['--model', 'claude-opus-5-5', '--effort', 'xhigh']],
    ['critical', 0, ['--model', 'claude-opus-5-5', '--effort', 'high']],
    ['critical', 1, ['--model', 'claude-opus-5-5', '--effort', 'xhigh']],
  ] as const)('opens a %s rung %i window on exactly its model and effort', (tier, rung, flags) => {
    const args = launchArgs({ ...OPTS, route: LADDERS[tier][rung] as ModelRoute });

    expect(args.slice(0, flags.length)).toEqual(flags);
    expect(args.slice(flags.length)).not.toContain('--model');
    expect(args.slice(flags.length)).not.toContain('--effort');
    expect(args.slice(flags.length)).not.toContain('--fallback-model');
  });

  it("passes an operator's override as given, with no fallback", () => {
    const args = launchArgs({ ...OPTS, route: { model: 'claude-opus-5-5', effort: 'low' } });

    expect(args.slice(0, 4)).toEqual(['--model', 'claude-opus-5-5', '--effort', 'low']);
    expect(args).not.toContain('--fallback-model');
  });

  it('passes --mcp-config only when the session has a code graph (decision 51)', () => {
    expect(launchArgs(OPTS)).not.toContain('--mcp-config');

    const args = launchArgs({ ...OPTS, mcpConfigPath: '/state/s-1/compiled/mcp.json' });

    const flag = args.indexOf('--mcp-config');
    expect(args[flag + 1]).toBe('/state/s-1/compiled/mcp.json');
  });

  // Strict mode would drop the operator's own MCP servers, and sessions inherit
  // user config (decision 9) — the code graph is added to it, not swapped for it.
  it('never restricts MCP to the compiled config', () => {
    expect(launchArgs({ ...OPTS, mcpConfigPath: '/state/s-1/compiled/mcp.json' })).not.toContain(
      '--strict-mcp-config',
    );
  });

  // The peer name is what the conductor sees in ListAgents and addresses with
  // SendMessage; it is the tmux name so one id reaches the session everywhere
  // (decision 47).
  it('names the session after its tmux window so a peer can address it', () => {
    const args = launchArgs(OPTS);

    const flag = args.indexOf('--name');
    expect(flag).toBeGreaterThan(-1);
    expect(args[flag + 1]).toBe('pup-s-1');
  });
});

// Both must match the 'which' branch faked in the node:child_process mock above.
const FAKE_CLAUDE_BIN = '/fake/bin/claude';
const FAKE_NICE_BIN = '/fake/bin/nice';

/**
 * The arguments `spawnDetachedSession` opens every window with, before the
 * per-window ones. Written once: three windows assert the same seven, and
 * three literal copies of them read as a clone of the production call itself
 * (addendum to decision 47).
 */
/** The `-e` pairs of a session window's git config (decision 101). */
const WINDOW_GIT_CONFIG_ARGS = [
  'GIT_CONFIG_COUNT=2',
  'GIT_CONFIG_KEY_0=diff.ignoreSubmodules',
  'GIT_CONFIG_VALUE_0=all',
  'GIT_CONFIG_KEY_1=status.submoduleSummary',
  'GIT_CONFIG_VALUE_1=false',
].flatMap((pair) => ['-e', pair]);

function spawnPrefix(name: string): string[] {
  return ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', name];
}

describe('launchSession', () => {
  // A real linked worktree: the launch checks its git pointers before the
  // window opens (decision 101).
  let repo: string;
  let opts: typeof OPTS;

  beforeEach(() => {
    const made = initRepoWithWorktree();
    repo = made.repo;
    opts = { ...OPTS, worktreePath: made.worktree };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The `-e` pairs the launch handed tmux, as the window's process sees them. */
  function launchedWindowEnv(): Record<string, string> {
    const spawn =
      vi
        .mocked(execFileSync)
        .mock.calls.find(([file, args]) => file === 'tmux' && args?.includes('new-session'))?.[1] ??
      [];
    return Object.fromEntries(
      spawn.flatMap((arg, i) => (spawn[i - 1] === '-e' ? [arg.split(/=(.*)/s).slice(0, 2)] : [])),
    ) as Record<string, string>;
  }

  it('kills any stale session, then spawns tmux with the window size, env, and resolved claude binary under nice -n 10, and returns the pane it printed', () => {
    const pane = launchSession(opts);

    // The pane id, not the session name: it is what every later steer,
    // interrupt and capture is addressed to (decision 46).
    expect(pane).toEqual({ sessionId: 's-1', paneId: '%7' });
    const tmuxCalls = vi.mocked(execFileSync).mock.calls.filter(([file]) => file === 'tmux');
    expect(tmuxCalls).toHaveLength(2);
    expect(tmuxCalls[0]).toEqual([
      'tmux',
      ['kill-session', '-t', '=pup-s-1:'],
      // Its environment too, less the variables no tmux call here inherits.
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }),
    ]);
    expect(tmuxCalls[1]?.[1]).toEqual([
      ...spawnPrefix('pup-s-1'),
      '-x',
      '220',
      '-y',
      '50',
      '-c',
      opts.worktreePath,
      '-e',
      `PUP_SESSION_ID=${opts.sessionId}`,
      // The submodule config, and never GIT_DIR, GIT_COMMON_DIR or
      // GIT_WORK_TREE, which every process the window runs would inherit
      // (decision 101).
      ...WINDOW_GIT_CONFIG_ARGS,
      '-e',
      `PUP_BIN=${process.argv[1] ?? 'pup'}`,
      FAKE_NICE_BIN,
      '-n',
      '10',
      FAKE_CLAUDE_BIN,
      ...launchArgs(opts),
    ]);
  });

  // A respawn opens a window on a worktree the last one could write: one whose
  // pointers name another repo would have Claude Code's startup git run that
  // repo's filters, so nothing is opened at all.
  it.each([
    ['a repointed gitfile', '.git', (elsewhere: string) => `gitdir: ${elsewhere}\n`],
    ['a rewritten commondir', '', (elsewhere: string) => `${elsewhere}\n`],
  ])('opens no window over %s', (_, pointer, content) => {
    const elsewhere = tempDir('pup-elsewhere-');
    sh(elsewhere, 'git', 'init', '-q');
    const target = pointer
      ? join(opts.worktreePath, pointer)
      : join(repo, '.git', 'worktrees', 'wt', 'commondir');
    writeFileSync(target, content(join(elsewhere, '.git')));

    expect(() => launchSession(opts)).toThrow(WorktreeRepointedError);
    const tmuxCalls = vi.mocked(execFileSync).mock.calls.filter(([file]) => file === 'tmux');
    expect(tmuxCalls).toEqual([]);
  });

  // Claude Code's startup git and the code graph's run on the window's
  // environment alone, outside the Bash sandbox. A gitlink over a `.git` the
  // session made would have their status and diff run a child git there, so
  // the window skips submodules (decision 101).
  // The window's config narrows the exposure and does not close it: a
  // `.gitmodules` override outranks it, and only a command-line flag beats that.
  it("runs no child git in a gitlink under the window's own environment, until .gitmodules overrides it", () => {
    launchSession(opts);
    const windowEnv = launchedWindowEnv();
    const marker = join(tempDir('pup-marker-'), 'fired');
    const sub = join(opts.worktreePath, 'sub');
    mkdirSync(sub);
    sh(sub, 'git', 'init', '-q');
    writeFileSync(join(sub, 'f'), 'a\n');
    sh(sub, 'git', 'add', 'f');
    sh(sub, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'sub');
    sh(sub, 'git', 'config', 'filter.pwn.clean', `sh -c 'echo pwned >> ${marker}; cat'`);
    writeFileSync(join(sub, '.git/info/attributes'), '* filter=pwn\n');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sub,
      env: GIT_ENV,
      encoding: 'utf8',
    });
    sh(
      opts.worktreePath,
      'git',
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${head.trim()},sub`,
    );
    const later = () => new Date(Date.now() + 60_000);
    const asWindow = { ...GIT_ENV, ...windowEnv };
    for (const args of [
      ['status', '--short'],
      ['diff', '--stat'],
    ]) {
      // The plant is live: plain git in the worktree runs it.
      utimesSync(join(sub, 'f'), later(), later());
      execFileSync('git', args, {
        cwd: opts.worktreePath,
        env: { ...asWindow, GIT_CONFIG_COUNT: '0' },
      });
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      utimesSync(join(sub, 'f'), later(), later());
      execFileSync('git', args, { cwd: opts.worktreePath, env: asWindow });
      expect(existsSync(marker)).toBe(false);
    }
    writeFileSync(
      join(opts.worktreePath, '.gitmodules'),
      '[submodule "sub"]\n\tpath = sub\n\tignore = none\n',
    );
    utimesSync(join(sub, 'f'), later(), later());
    execFileSync('git', ['status', '--short'], { cwd: opts.worktreePath, env: asWindow });
    expect(existsSync(marker)).toBe(true);
  });

  // Every process the session runs inherits the window's environment: a test
  // or a package manager that runs `git init` in a dir of its own must act on
  // that dir. Under GIT_DIR, GIT_COMMON_DIR and GIT_WORK_TREE it would write
  // `core.worktree` into the config the main checkout and every session share.
  it("lets a child git init in a temp dir leave the repo's shared config untouched", () => {
    launchSession(opts);
    const asWindow = { ...GIT_ENV, ...launchedWindowEnv() };
    const config = join(repo, '.git', 'config');
    const before = readFileSync(config, 'utf8');

    // The exposure is live: with the three variables set, the init writes there.
    execFileSync('git', ['init', '-q'], {
      cwd: tempDir('pup-child-'),
      env: { ...asWindow, ...verifiedWorktreeGitEnv(repo, opts.worktreePath) },
    });
    expect(readFileSync(config, 'utf8')).toContain(`worktree = ${opts.worktreePath}`);
    writeFileSync(config, before);

    const child = tempDir('pup-child-');
    execFileSync('git', ['init', '-q'], { cwd: child, env: asWindow });
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(existsSync(join(child, '.git', 'HEAD'))).toBe(true);
  });

  // `pup launch` and `pup new` are the conductor's to run, and they run in its
  // pane, where $TMUX names its private socket: without this the session would
  // open on the conductor's own server, back inside send-keys reach of it, and
  // a default server first started from there would put PUP_CONDUCTOR in its
  // global environment for every window after (decision 47).
  it('opens the session on the default server when run from inside the conductor', () => {
    vi.stubEnv('TMUX', '/private/tmp/tmux-501/pup-conductor-proj-1,84321,0');
    vi.stubEnv('PUP_CONDUCTOR', 'proj-1');
    vi.stubEnv('PUP_SESSION_ID', 'someone-else');

    const pane = launchSession(opts);

    expect(pane.socket).toBeUndefined();
    for (const [, args, options] of vi
      .mocked(execFileSync)
      .mock.calls.filter(([file]) => file === 'tmux')) {
      expect(args).not.toContain('-L');
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      expect(env?.TMUX).toBeUndefined();
      expect(env?.PUP_CONDUCTOR).toBeUndefined();
      expect(env?.PUP_SESSION_ID).toBeUndefined();
      // The rest of the environment is the caller's, untouched.
      expect(env?.PATH).toBe(process.env.PATH);
    }
    // What the session IS is the window's own `-e`, never what it inherited.
    const spawn = vi
      .mocked(execFileSync)
      .mock.calls.find(([file, args]) => file === 'tmux' && args?.includes('new-session'))?.[1];
    expect(spawn).toContain('PUP_SESSION_ID=s-1');
  });

  // A client that STARTS a server hands it that environment as the server's
  // global one, which every later window inherits and any client can read back
  // with `show-environment -g`. The conductor's Bash carries the peer channel's
  // socket and token: a session that read those could speak on the channel as
  // the conductor, past the tier entirely (decision 47).
  it('hands tmux none of the agent credentials, and everything else the caller has', () => {
    vi.stubEnv('CLAUDE_CODE_MESSAGING_TOKEN', 'peer-token');
    vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/tmp/cc-socks/1.sock');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'sess-uuid');
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_EXECPATH', '/usr/local/bin/claude');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-secret');
    vi.stubEnv('NODE_OPTIONS', '--require /tmp/evil.js');
    vi.stubEnv('TMUX_TMPDIR', '/private/tmp');

    launchSession(opts);

    for (const [, , options] of vi
      .mocked(execFileSync)
      .mock.calls.filter(([file]) => file === 'tmux')) {
      const env = (options as { env?: NodeJS.ProcessEnv }).env ?? {};
      expect(Object.keys(env).filter((key) => /^CLAUDE|^ANTHROPIC_/.test(key))).toEqual([]);
      expect(env.NODE_OPTIONS).toBeUndefined();
      // Kept: tmux needs its own tmpdir to find the socket at all, and the
      // scrub is about the caller's identity, not its shell.
      expect(env.TMUX_TMPDIR).toBe('/private/tmp');
      expect(env.HOME).toBe(process.env.HOME);
    }
  });

  it('fails the launch when tmux prints anything but a pane id', () => {
    // The id is checked where it is minted: every later command trusts it,
    // and a launch is the one place a bad one can fail loudly rather than late.
    const original = vi.mocked(execFileSync).getMockImplementation();
    vi.mocked(execFileSync).mockImplementation((file, args, options) =>
      file === 'tmux' && args?.[0] === 'new-session'
        ? ''
        : ((original as (...callArgs: unknown[]) => unknown)(file, args, options) as string),
    );
    try {
      expect(() => launchSession(opts)).toThrow('tmux new-session printed "", not a pane id.');
    } finally {
      vi.mocked(execFileSync).mockImplementation(original as never);
    }
  });
});

const PANE: SessionPane = { sessionId: 's-1', paneId: '%7' };

describe('interruptPane', () => {
  it('sends Escape to the pane id and spawns nothing else', () => {
    // Skip the real post-Escape settle — spying (not restoreAllMocks) so the
    // module-level execFileSync fake survives for the rest of the suite.
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    try {
      interruptPane(PANE);
    } finally {
      wait.mockRestore();
    }

    // Full call list, not a tmux-filtered one — a future non-tmux spawn here
    // must fail this test too. The pane id is load-bearing: a session target
    // resolves to the active pane, which a split from inside the session moves.
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('tmux');
    expect(calls[0]?.[1]).toEqual(['send-keys', '-t', '%7', 'Escape']);
  });

  // Every steer, interrupt and capture goes through the same call, and the
  // conductor is the caller for most of them: from its pane, an inherited
  // $TMUX would aim each one at its own server, where the session is not
  // (decision 47).
  it("reaches the session's server, not the conductor's, when sent from the conductor's pane", () => {
    vi.stubEnv('TMUX', '/private/tmp/tmux-501/pup-conductor-proj-1,84321,0');
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    try {
      interruptPane(PANE);
    } finally {
      wait.mockRestore();
      vi.unstubAllEnvs();
    }

    const [, args, options] = vi.mocked(execFileSync).mock.calls[0] ?? [];
    expect(args).toEqual(['send-keys', '-t', '%7', 'Escape']);
    expect((options as { env?: NodeJS.ProcessEnv }).env?.TMUX).toBeUndefined();
  });

  it('refuses a recorded target that is not a pane id before touching tmux', () => {
    // A row from before panes were pinned holds the session NAME, which tmux
    // would resolve to the active pane — the hole this closes. Nothing is sent.
    const legacy: SessionPane = { sessionId: 's-1', paneId: 'pup-s-1' };

    expect(() => interruptPane(legacy)).toThrow(SessionPaneMissingError);
    expect(() => steerPane(legacy, 'do X')).toThrow(
      'Session s-1 recorded "pup-s-1" as its pane, which is not a tmux pane id (it was ' +
        'launched before panes were pinned); nothing was sent. Respawn it: ' +
        '`pup kill --respawn s-1`.',
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('killSession', () => {
  it('kills the session holding the launch pane, then any session still wearing the name', () => {
    killSession('s-1', '%7');

    // By pane first: kill-session resolves a pane id to the session it is in,
    // so a rename-session from inside cannot leave the window running under
    // another name. By pinned name second, for what the pane kill could not
    // reach (verified on tmux 3.7b: the pane kill survives a rename).
    expect(vi.mocked(execFileSync).mock.calls.map(([, args]) => args)).toEqual([
      ['kill-session', '-t', '%7'],
      ['kill-session', '-t', '=pup-s-1:'],
    ]);
  });

  it('kills by name alone when no pane was recorded, or the record is not a pane id', () => {
    killSession('s-1', null);
    killSession('s-1', 'pup-s-1');

    expect(vi.mocked(execFileSync).mock.calls.map(([, args]) => args)).toEqual([
      ['kill-session', '-t', '=pup-s-1:'],
      ['kill-session', '-t', '=pup-s-1:'],
    ]);
  });
});

describe('windowLabel, attachArgs and attachCommand', () => {
  it('spells every window pup opens, so nothing outside this module has to', () => {
    expect(windowLabel({ sessionId: 't-abc' })).toBe('pup-t-abc');
    expect(windowLabel({ conductorOf: 'proj-1' })).toBe('pup-conductor-proj-1');
    expect(windowLabel({ watcherOf: 'proj-1' })).toBe('pup-watch-proj-1');
  });

  it("pins the session's attach target, and asks the default server for it", () => {
    expect(attachArgs({ sessionId: 't-abc' })).toEqual(['attach', '-t', '=pup-t-abc:']);
  });

  it("pins the radar's too, on that same default server", () => {
    expect(attachArgs({ watcherOf: 'proj-1' })).toEqual(['attach', '-t', '=pup-watch-proj-1:']);
  });

  it("names the conductor's own server, where its window is (decision 47)", () => {
    expect(attachArgs({ conductorOf: 'proj-1' })).toEqual([
      '-L',
      'pup-conductor-proj-1',
      'attach',
      '-t',
      '=pup-conductor-proj-1:',
    ]);
  });

  // The operator pastes this line into a shell; in zsh a bare `=pup-t-abc:`
  // is an equals-expansion and dies as `pup-t-abc: not found` before tmux runs.
  it('quotes the pinned target, which zsh would otherwise expand', () => {
    expect(attachCommand({ sessionId: 't-abc' })).toBe("tmux attach -t '=pup-t-abc:'");
    expect(attachCommand({ conductorOf: 'proj-1' })).toBe(
      "tmux -L pup-conductor-proj-1 attach -t '=pup-conductor-proj-1:'",
    );
  });
});

describe('attachWindow', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs the argv the attach line prints, on the terminal it was called from', () => {
    expect(attachWindow({ conductorOf: 'proj-1' })).toBe(0);

    expect(spawnSync).toHaveBeenCalledWith('tmux', attachArgs({ conductorOf: 'proj-1' }), {
      stdio: 'inherit',
      env: expect.anything(),
    });
  });

  // An attach that finds the server gone starts one on that socket, and its
  // global environment is whatever the attach was spawned with.
  it('spawns tmux with the scrubbed environment every tmux call gets', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-operator');
    vi.stubEnv('TMUX', '/private/tmp/tmux-501/default,1,0');

    attachWindow({ conductorOf: 'proj-1' });

    const env = vi.mocked(spawnSync).mock.calls.at(-1)?.[2]?.env ?? {};
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('TMUX');
    expect(env.PATH).toBe(process.env.PATH);
  });

  // `pup attach <session>` and `pup ui`'s attach: the default server, named by
  // the pinned window, never a socket (decision 87).
  it("attaches to a session's window on the default server with the same scrubbed environment", () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-operator');
    vi.stubEnv('TMUX', '/private/tmp/tmux-501/default,1,0');

    expect(attachWindow({ sessionId: 't-abc' })).toBe(0);

    const [file, args, options] = vi.mocked(spawnSync).mock.calls.at(-1) ?? [];
    expect([file, args]).toEqual(['tmux', ['attach', '-t', '=pup-t-abc:']]);
    expect(options?.stdio).toBe('inherit');
    expect(options?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(options?.env).not.toHaveProperty('TMUX');
  });

  it("answers tmux's own exit status", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1 } as never);

    expect(attachWindow({ conductorOf: 'proj-1' })).toBe(1);
  });

  it('throws when tmux could not be run at all', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: null, error: new Error('ENOENT') } as never);

    expect(() => attachWindow({ conductorOf: 'proj-1' })).toThrow('ENOENT');
  });
});

/**
 * The one place this suite runs the real tmux instead of the fake: what is
 * under test IS tmux's own name resolution, and the fake models what pup
 * believes about it, so a test against the fake could only agree with the
 * belief. tmux is pup's transport (decision 1), so it is installed wherever
 * this suite runs.
 */
describe('attachArgs against the installed tmux', () => {
  it('refuses a session whose name only prefix-matches a live one, which a bare name takes', async (ctx) => {
    const { spawnSync } =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    // A socket of this suite's own, named by PATH (`-S`) and kept short: a
    // unix socket path is capped at 104 bytes, and `-L` would spend a dozen
    // of them on a `tmux-<uid>/` of its own under an already deep `tmpdir()`.
    // Under `tmpdir()` because the merge gate runs this suite sandboxed, where
    // the child's own TMPDIR is about all it may write — `/tmp` is denied
    // (decision 36).
    const dir = tempDir('x');
    // No `$TMUX`: these tests can run inside a pup session, and tmux refuses a
    // nested attach before it ever resolves the target.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TMUX;
    const tmuxHere = (args: string[]) =>
      spawnSync('tmux', ['-S', join(dir, 's'), ...args], { encoding: 'utf8', env });

    try {
      const started = tmuxHere(['new-session', '-d', '-s', 'pup-t-abc-1', 'sleep', '30']);
      // A host whose sandbox refuses the socket itself, which is the one thing
      // this test cannot work around. Skipped out loud, with what tmux said:
      // a test that quietly stops testing is worse than one that is not there.
      if (/not permitted|permission denied/i.test(started.stderr ?? '')) {
        ctx.skip(`no tmux socket here: ${started.stderr.trim()}`);
      }

      const pinnedAttach = tmuxHere(attachArgs({ sessionId: 't-abc' }));
      const bareAttach = tmuxHere(['attach', '-t', 'pup-t-abc']);

      expect(pinnedAttach.stderr).toContain("can't find session");
      // What the pin is for: the bare name prefix-matches the live sibling, and
      // tmux gets all the way to wanting a terminal — which this process is not.
      expect(bareAttach.stderr).toContain('open terminal failed');
    } finally {
      tmuxHere(['kill-server']);
    }
  });
});

describe('transcriptDir', () => {
  /**
   * The worktree path is `sessions.worktree_path`, which the sessions write,
   * and the dashboard reads the directory this derives before trusting a
   * stored `transcript_path` against it (decision 67). So the munge has to be
   * closed: `..` and separators are not escaped, they stop existing.
   */
  it('munges a traversing worktree path into one segment under ~/.claude/projects', () => {
    const dir = transcriptDir('/repo/../.worktrees/t-1');

    expect(dirname(dir)).toBe(join(homedir(), '.claude', 'projects'));
    expect(basename(dir)).toBe('-repo-----worktrees-t-1');
    expect(basename(dir)).not.toMatch(/[/.]/);
  });
});

describe('launchWatcher', () => {
  it('kills any stale watcher, then spawns tmux running the pup CLI watch command', () => {
    const { target } = launchWatcher('proj-1', '/tmp/repo');

    expect(target).toBe('pup-watch-proj-1');
    const tmuxCalls = vi.mocked(execFileSync).mock.calls.filter(([file]) => file === 'tmux');
    expect(tmuxCalls).toHaveLength(2);
    expect(tmuxCalls[0]).toEqual([
      'tmux',
      ['kill-session', '-t', '=pup-watch-proj-1:'],
      // Its environment too, less the variables no tmux call here inherits.
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }),
    ]);
    expect(tmuxCalls[1]?.[1]).toEqual([
      ...spawnPrefix('pup-watch-proj-1'),
      '-c',
      '/tmp/repo',
      process.execPath,
      process.argv[1] ?? 'pup',
      'watch',
    ]);
  });
});

/**
 * A `tmux` on PATH that logs its argv and plays the Claude Code input box
 * (docs/conventions/testing.md, "Faking an external CLI"): `load-buffer` keeps
 * the message, `paste-buffer` puts it in the box, and `capture-pane` renders
 * the box the way 2.1.263 does — the message's tail while the paste is still
 * being ingested (its last row's tail), then, from the `FAKE_TMUX_LANDS_AFTER`th capture on, the
 * folded placeholder with its newline count. Enter empties the box; Ctrl-U
 * takes one row per press, as the real UI does, and none at all when
 * `FAKE_TMUX_STUCK` is set. Every capture's box line is logged too, so a test
 * can read what the runtime saw before it pressed a key.
 *
 * Buffers are kept as tmux keeps them: `load-buffer -b <name>` stores one under
 * that name and `paste-buffer -b <name> -d` pastes and deletes it, refusing a
 * name the server does not hold; without `-b` both use the top of the stack,
 * the one most recently loaded. `FAKE_TMUX_RACE` is another client's message,
 * loaded unnamed right after each load — the steer and the tell that race on
 * one server (decision 87).
 *
 * `FAKE_TMUX_TRANSCRIPT` is the line the transcript ends on, rendered where
 * Claude Code puts it: directly above the box. A dead turn's `⏺ API Error:`
 * line is one of those, and it is all a pane says about a turn that ended
 * without a Stop hook.
 *
 * `FAKE_TMUX_DIALOG` puts a dialog where the box was, under the echo of the
 * prompt just submitted; `FAKE_TMUX_DIALOG_AFTER_CLEARS` does so once that
 * many Ctrl-U presses went in, and `FAKE_TMUX_DIALOG_AFTER_ENTER` once Enter
 * has been pressed.
 *
 * With `FAKE_TMUX_SUGGESTION` set, an empty box offers that prompt, the way
 * Claude Code does once a turn ends: dim under `-e`, and — as real tmux
 * strips the styling — bare text without it, which is how a capture that
 * forgot `-e` sees a suggestion as a draft.
 *
 * Panes are modelled the way tmux resolves `-t`: a pane id names that pane,
 * which must be listed in `panes` or the command fails with tmux's own
 * can't-find-pane line; anything else is a session target and resolves to
 * the pane named in `active`, which a split from inside the session moves.
 * Each pane has its own box, and what was pasted or keyed into it is kept in
 * `typed-<pane>`, so a test can tell which pane a steer reached. With
 * `FAKE_TMUX_DOWN` set every command fails the way a dead server does.
 * Windows are modelled only as far as `list-panes` shows them: a `window`
 * file names the current window's panes, which is all a plain `list-panes -t
 * <session>` lists (verified on tmux 3.7b), and `-s` lists `panes`, every
 * pane in the session, whichever window is current.
 *
 * Servers are modelled too, because that is what the conductor's isolation is:
 * a leading `-L <socket>` selects the state directory `<socket>/`, everything
 * else the state root, and a socket with no directory fails the way a socket
 * with no server does. So a pane on one server is invisible to a client on
 * another — by pane id and by name alike (decision 47).
 */
const FAKE_TMUX = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
if [ -n "$FAKE_TMUX_DOWN" ]; then
  echo 'error connecting to /private/tmp/tmux-501/default (No such file or directory)' >&2
  exit 1
fi
server="$FAKE_TMUX_STATE"
if [ "$1" = -L ]; then server="$FAKE_TMUX_STATE/$2"; shift 2; fi
if [ ! -d "$server" ]; then echo "no server running on $server" >&2; exit 1; fi
target=''
styled=''
prev=''
all=''
buf=''
for arg in "$@"; do
  [ "$prev" = -t ] && target="$arg"
  [ "$prev" = -b ] && buf="$arg"
  [ "$arg" = -e ] && styled=1
  [ "$arg" = -s ] && all=1
  prev="$arg"
done
case "$target" in
  %*) pane="\${target#%}"
      grep -qx "$pane" "$server/panes" || { echo "can't find pane: $target" >&2; exit 1; } ;;
  *) pane=$(cat "$server/active") ;;
esac
box="$server/box-$pane"
typed="$server/typed-$pane"
buffer="$server/buffer\${buf:+-$buf}"
case "$1" in
  load-buffer)
    cat > "$buffer"
    if [ -n "$FAKE_TMUX_RACE" ]; then printf '%s' "$FAKE_TMUX_RACE" > "$server/buffer"; fi ;;
  paste-buffer)
    [ -f "$buffer" ] || { echo "no buffer $buf" >&2; exit 1; }
    cp "$buffer" "$box"; rm -f "$buffer"; cat "$box" >> "$typed"; echo >> "$typed" ;;
  delete-buffer) rm -f "$buffer" ;;
  list-panes)
    if [ -n "$all" ] || [ ! -f "$server/window" ]; then sed 's/^/%/' "$server/panes"
    else sed 's/^/%/' "$server/window"; fi ;;
  send-keys)
    echo "$4" >> "$typed"
    [ "$4" = C-u ] && echo $(( $(cat "$server/clears" 2>/dev/null || echo 0) + 1 )) > "$server/clears"
    if [ "$4" = Enter ]; then rm -f "$box"; touch "$server/entered"; fi
    if [ "$4" = C-u ] && [ -z "$FAKE_TMUX_STUCK" ] && [ -f "$box" ]; then
      rows=$(grep -c '' "$box")
      if [ "$rows" -le 1 ]; then rm -f "$box"
      else head -n $((rows - 1)) "$box" > "$box.tmp" && mv "$box.tmp" "$box"; fi
    fi ;;
  capture-pane)
    n=$(( $(cat "$server/captures" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$server/captures"
    if [ ! -f "$box" ]; then
      if [ -z "$FAKE_TMUX_SUGGESTION" ]; then line='❯ '
      elif [ -n "$styled" ]; then line="❯ $(printf '\\033')[2m$FAKE_TMUX_SUGGESTION$(printf '\\033')[0m"
      else line="❯ $FAKE_TMUX_SUGGESTION"; fi
    elif [ "$n" -lt "$FAKE_TMUX_LANDS_AFTER" ]; then line="❯ $(tail -n 1 "$box" | tail -c 12)"
    else
      newlines=$(tr -cd '\\n' < "$box" | wc -c | tr -d ' ')
      if [ "$newlines" -gt 0 ]; then line="❯ [Pasted text #1 +$newlines lines]"
      else line='❯ [Pasted text #1]'; fi
    fi
    printf 'capture => %s\\n' "$line" >> "$FAKE_TMUX_LOG"
    clears=$(cat "$server/clears" 2>/dev/null || echo 0)
    if [ -n "$FAKE_TMUX_DIALOG" ] || { [ -n "$FAKE_TMUX_DIALOG_AFTER_CLEARS" ] && [ "$clears" -ge "$FAKE_TMUX_DIALOG_AFTER_CLEARS" ]; } || { [ -n "$FAKE_TMUX_DIALOG_AFTER_ENTER" ] && [ -f "$server/entered" ]; }; then
      printf '❯ earlier prompt\\n⏺ ok\\n Usage limit reached.\\n ❯ 1. Wait\\n   2. Switch model\\n'
    else
      printf '  ? for shortcuts\\n%s\\n────\\n%s\\n────\\n' "$FAKE_TMUX_TRANSCRIPT" "$line"
    fi ;;
esac
`;

/** A tmux whose captures carry no styling, for the test that shows why `-e` is passed. */
function dropStyling(args: string[]): string[] {
  return args[0] === 'capture-pane' ? args.filter((arg) => arg !== '-e') : args;
}

describe('steerPane with a fake tmux on PATH', () => {
  const original = vi.mocked(execFileSync).getMockImplementation();
  let log: string;
  let state: string;
  let landsAfter: number;
  let stuck: boolean;
  let dialog: boolean;
  let dialogAfterClears: number;
  let down: boolean;
  let race: string;
  let dialogAfterEnter: boolean;
  let suggestion: string;
  let transcript: string;
  let stripStyling: boolean;
  let wait: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const dir = tempDir('pup-fake-tmux-');
    mkdirSync(join(dir, 'bin'));
    state = join(dir, 'state');
    mkdirSync(state);
    writeFileSync(join(dir, 'bin', 'tmux'), FAKE_TMUX, { mode: 0o755 });
    log = join(dir, 'tmux.log');
    writeFileSync(log, '');
    // The session was launched into pane 3, which is also its active pane.
    writeFileSync(join(state, 'panes'), '3\n');
    writeFileSync(join(state, 'active'), '3\n');
    landsAfter = 0;
    stuck = false;
    dialog = false;
    dialogAfterClears = 0;
    down = false;
    race = '';
    dialogAfterEnter = false;
    suggestion = '';
    transcript = '';
    stripStyling = false;
    // Every settle is skipped: what is under test is what the runtime does
    // between settles, and the fake's clock is the capture count.
    wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(execFileSync).mockImplementation((file, args, options) =>
      file === 'tmux'
        ? real.execFileSync(
            file,
            stripStyling ? dropStyling(args as string[]) : (args as string[]),
            {
              ...(options as object),
              env: {
                ...process.env,
                PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
                FAKE_TMUX_LOG: log,
                FAKE_TMUX_STATE: state,
                FAKE_TMUX_LANDS_AFTER: String(landsAfter),
                FAKE_TMUX_SUGGESTION: suggestion,
                FAKE_TMUX_TRANSCRIPT: transcript,
                ...(stuck ? { FAKE_TMUX_STUCK: '1' } : {}),
                ...(dialog ? { FAKE_TMUX_DIALOG: '1' } : {}),
                ...(dialogAfterClears > 0
                  ? { FAKE_TMUX_DIALOG_AFTER_CLEARS: String(dialogAfterClears) }
                  : {}),
                ...(down ? { FAKE_TMUX_DOWN: '1' } : {}),
                ...(race ? { FAKE_TMUX_RACE: race } : {}),
                ...(dialogAfterEnter ? { FAKE_TMUX_DIALOG_AFTER_ENTER: '1' } : {}),
              },
            },
          )
        : ((original as (...callArgs: unknown[]) => unknown)(file, args, options) as string),
    );
  });

  afterEach(() => {
    wait.mockRestore();
    vi.mocked(execFileSync).mockImplementation(original as never);
  });

  /** The log as tmux saw it, each paste's buffer name included. */
  function rawArgvLog(): string[] {
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
  }

  /**
   * The log with every paste buffer's name read as `BUF`: the name is minted
   * per call, and the test that pins it reads `rawArgvLog`.
   */
  function argvLog(): string[] {
    return rawArgvLog().map((line) => line.replace(PASTE_BUFFER, 'BUF'));
  }

  /**
   * What reached pane `n` on `socket` (the default server when unset): each
   * paste's text, then each key, one per line.
   */
  function typedInto(n: number, socket?: string): string | undefined {
    const file = join(socket ? join(state, socket) : state, `typed-${n}`);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  }

  /** Bring up a server on `socket` holding one pane, the way a launch would. */
  function serverWithPane(socket: string, pane: number): void {
    mkdirSync(join(state, socket));
    writeFileSync(join(state, socket, 'panes'), `${pane}\n`);
    writeFileSync(join(state, socket, 'active'), `${pane}\n`);
  }

  const LAUNCH_PANE: SessionPane = { sessionId: 's-1', paneId: '%3' };
  const PASTE_BUFFER = /pup-paste-[0-9a-f-]{36}/g;
  const STEER_3000 = `FIRSTWORD ${'tok '.repeat(745)}LASTWORDS.`;
  const ENTER = 'send-keys -t %3 Enter';
  const CLEAR = 'send-keys -t %3 C-u';

  it('pastes a 3000-char steer bracketed and presses Enter only once the pane shows it whole', () => {
    expect(STEER_3000).toHaveLength(3000);
    // One capture checks the box is empty before the paste; the placeholder
    // then appears at the third settle, not the first.
    landsAfter = 4;

    steerPane(LAUNCH_PANE, STEER_3000);

    const lines = argvLog();
    expect(lines.slice(0, 4)).toEqual([
      'capture-pane -p -e -t %3',
      'capture => ❯ ',
      'load-buffer -b BUF -',
      'paste-buffer -b BUF -d -p -t %3',
    ]);
    const enterAt = lines.indexOf(ENTER);
    expect(enterAt).toBeGreaterThan(0);
    expect(lines.slice(4, enterAt)).toEqual([
      'capture-pane -p -e -t %3',
      'capture => ❯ k LASTWORDS.',
      'capture-pane -p -e -t %3',
      'capture => ❯ k LASTWORDS.',
      'capture-pane -p -e -t %3',
      'capture => ❯ [Pasted text #1]',
    ]);
    // Submission verified after Enter, exactly as before; no clear was needed.
    expect(lines.slice(enterAt + 1)).toEqual(['capture-pane -p -e -t %3', 'capture => ❯ ']);
    expect(lines.filter((line) => line === ENTER)).toHaveLength(1);
    expect(lines).not.toContain(CLEAR);
  });

  it('lands in the launch pane after a split from inside the session moved the active pane', () => {
    // The agent ran `tmux split-window`: pane 9 is now the session's active
    // pane, so a session target would resolve to it — and it is a shell of
    // the agent's own, where Enter runs whatever was pasted. The steer is
    // addressed to the pane recorded at launch and never sees the split.
    writeFileSync(join(state, 'panes'), '3\n9\n');
    writeFileSync(join(state, 'active'), '9\n');
    landsAfter = 4;

    steerPane(LAUNCH_PANE, STEER_3000);

    expect(typedInto(3)).toBe(`${STEER_3000}\nEnter\n`);
    expect(typedInto(9)).toBeUndefined();
    expect(argvLog()).not.toContainEqual(expect.stringContaining('=pup-s-1:'));
  });

  it('refuses, naming the pane, when it no longer exists, and pastes nothing', () => {
    // The launch pane was killed; pane 9 is what the session now shows. A
    // session target would land there. Nothing is sent anywhere, and the
    // refusal is tmux's own can't-find-pane turned into a named error.
    writeFileSync(join(state, 'panes'), '9\n');
    writeFileSync(join(state, 'active'), '9\n');

    expect(() => steerPane(LAUNCH_PANE, STEER_3000)).toThrow(SessionPaneMissingError);
    expect(() => steerPane(LAUNCH_PANE, STEER_3000)).toThrow(
      "Session s-1's pane %3 no longer exists; nothing was sent.",
    );

    expect(argvLog()).toEqual(['capture-pane -p -e -t %3', 'capture-pane -p -e -t %3']);
    expect(typedInto(9)).toBeUndefined();
  });

  it('refuses the same way when the tmux server itself is gone', () => {
    down = true;

    expect(() => interruptPane(LAUNCH_PANE)).toThrow(
      "Session s-1's pane %3 no longer exists; nothing was sent.",
    );
    expect(() => steerPane(LAUNCH_PANE, 'do X')).toThrow(SessionPaneMissingError);
  });

  it('clears a draft the box already holds before pasting', () => {
    // A box with leftover text reads as text plus placeholder after the
    // paste, never as the message alone (seen live: `row one[Pasted text #33]`).
    writeFileSync(join(state, 'box-3'), 'row one\nrow two\nrow three');
    // The draft and then the short message both render inline (as their
    // own tail); nothing folds.
    landsAfter = Number.MAX_SAFE_INTEGER;

    steerPane(LAUNCH_PANE, 'do X instead');

    // Ctrl-U takes one row per press, so clearing is a loop checked against
    // the pane after each press, not one press and a hope.
    const lines = argvLog();
    expect(lines.slice(0, 12)).toEqual([
      'capture-pane -p -e -t %3',
      'capture => ❯ row three',
      CLEAR,
      'capture-pane -p -e -t %3',
      'capture => ❯ row two',
      CLEAR,
      'capture-pane -p -e -t %3',
      'capture => ❯ row one',
      CLEAR,
      'capture-pane -p -e -t %3',
      'capture => ❯ ',
      'load-buffer -b BUF -',
    ]);
    expect(lines.indexOf('paste-buffer -b BUF -d -p -t %3')).toBeGreaterThan(lines.indexOf(CLEAR));
  });

  it('steers a session showing a suggested prompt without pressing Ctrl-U at all', () => {
    // The live refusal this fixes: a session that has finished its turn offers
    // a prompt of its own in the box. It is dim, so it is not a draft, and
    // Ctrl-U cannot clear it — 64 presses later every steer, handoff and gate
    // re-steer to an idle session was refused with box-not-cleared.
    suggestion = 'run the security review on this branch';
    landsAfter = 4;

    steerPane(LAUNCH_PANE, STEER_3000);

    const lines = argvLog();
    expect(lines).not.toContain(CLEAR);
    expect(lines.slice(0, 2)).toEqual([
      'capture-pane -p -e -t %3',
      `capture => \u276f \u001b[2m${suggestion}\u001b[0m`,
    ]);
    expect(lines.slice(2, 4)).toEqual(['load-buffer -b BUF -', 'paste-buffer -b BUF -d -p -t %3']);
    expect(typedInto(3)).toBe(`${STEER_3000}\nEnter\n`);
    expect(lines.filter((line) => line === ENTER)).toHaveLength(1);
  });

  it('would refuse the same steer from a capture with no styling to read', () => {
    // Why the box is captured with `-e`: without it tmux strips the escapes,
    // and the suggestion is then a draft like any other. Dropping the flag on
    // its way to the fake is the whole difference from the test above.
    suggestion = 'run the security review on this branch';
    landsAfter = 4;
    stripStyling = true;

    expect(() => steerPane(LAUNCH_PANE, STEER_3000)).toThrow(
      'Steer to session s-1 did not land: its input box held text that Ctrl-U could not clear',
    );

    expect(argvLog().filter((line) => line === CLEAR)).toHaveLength(64);
  }, 20_000);

  it('gives a steer one settle per KB, then clears the box and refuses without pressing Enter', () => {
    landsAfter = Number.MAX_SAFE_INTEGER;

    expect(() => steerPane(LAUNCH_PANE, `${STEER_3000}${'tok '.repeat(750)}`)).toThrow(
      SteerNotDeliveredError,
    );
    expect(() => steerPane(LAUNCH_PANE, STEER_3000)).toThrow(
      'Steer to session s-1 did not land: its input box never held the whole 3000-char message. ' +
        'Cleared the box and submitted nothing; the session is still running with an empty prompt.',
    );

    const lines = argvLog().slice(0, argvLog().indexOf(CLEAR) + 3);
    expect(lines).not.toContain(ENTER);
    // ceil(6000 / 1000) settles for the first call, each ending in a look at
    // the box, then one more look that the box is still there to clear.
    const settles = lines.filter((line) => line === 'capture => ❯ tok tok tok ');
    expect(settles).toHaveLength(7);
    expect(lines.slice(-3)).toEqual([CLEAR, 'capture-pane -p -e -t %3', 'capture => ❯ ']);
  });

  it('floors a short steer at five settles, so a late repaint under load is not a refusal', () => {
    landsAfter = Number.MAX_SAFE_INTEGER;

    expect(() => steerPane(LAUNCH_PANE, 'do X instead, then run the tests')).toThrow(
      SteerNotDeliveredError,
    );

    // Five settles, then the look that the box is still there to clear.
    expect(argvLog().filter((line) => line === 'capture => ❯ un the tests')).toHaveLength(6);
  });

  // The same budget its sibling in `kickoff` carries, for the same reason:
  // every C-u press of the clear loop spawns the fake, a shell script, twice
  // (the key, then a capture), so 64 presses are ~128 spawns — comfortably
  // under vitest's 5 s default alone, and over it on a loaded machine.
  it('refuses, naming the box, when Ctrl-U cannot empty it, and pastes nothing', () => {
    writeFileSync(join(state, 'box-3'), 'x');
    stuck = true;

    expect(() => steerPane(LAUNCH_PANE, STEER_3000)).toThrow(
      'Steer to session s-1 did not land: its input box held text that Ctrl-U could not clear, ' +
        'so the 3000-char message was not pasted. Nothing was submitted; the session is still ' +
        'running with the box as it was.',
    );

    const lines = argvLog();
    expect(lines.filter((line) => line === CLEAR)).toHaveLength(64);
    expect(lines).not.toContain('load-buffer -b BUF -');
    expect(lines).not.toContain(ENTER);
  }, 20_000);

  // The frame rule `pup conductor tell` reads the box by (decision 85): the
  // echo of the prompt just submitted is still on screen above a dialog, and
  // read as the box it held text, so the steer pressed Ctrl-U into the dialog
  // — or, with an empty echo, pasted into it (decision 87).
  it('refuses a dialog under an echoed prompt before pressing any key into it', () => {
    dialog = true;

    expect(() => steerPane(LAUNCH_PANE, 'do X instead')).toThrow(
      'Steer to session s-1 did not land: its input box is not on screen (a dialog or menu ' +
        'holds the pane), so the 12-char message was not pasted and no key was pressed.',
    );

    expect(argvLog()).toEqual(['capture-pane -p -e -t %3', 'capture => ❯ ']);
    expect(typedInto(3)).toBeUndefined();
  });

  it('stops pressing Enter once a dialog has replaced the box it submitted', () => {
    landsAfter = 1;
    dialogAfterEnter = true;

    steerPane(LAUNCH_PANE, 'do X instead');

    expect(argvLog().filter((line) => line === ENTER)).toHaveLength(1);
    expect(typedInto(3)).toBe('do X instead\nEnter\n');
  });

  it('loads and pastes a buffer named for each call, and leaves none behind', () => {
    landsAfter = 1;

    steerPane(LAUNCH_PANE, 'first steer');
    steerPane(LAUNCH_PANE, 'second steer');

    const named = rawArgvLog()
      .map((line) => /^(load|paste)-buffer -b (\S+)/.exec(line))
      .filter((match) => match !== null)
      .map((match) => [match[1], match[2]]);
    expect(named.map(([verb]) => verb)).toEqual(['load', 'paste', 'load', 'paste']);
    const [first, second] = [named[0]?.[1], named[2]?.[1]];
    expect(first).toMatch(/^pup-paste-[0-9a-f-]{36}$/);
    expect(named[1]?.[1]).toBe(first);
    expect(named[3]?.[1]).toBe(second);
    expect(second).not.toBe(first);
    expect(readdirSync(state).filter((file) => file.startsWith('buffer'))).toEqual([]);
  });

  it('pastes its own message when another client loads one between its load and its paste', () => {
    // Unnamed, the paste took the top of the server's stack: the racing
    // tell's text went into this session's box and was submitted as the
    // steer (decision 87).
    landsAfter = 1;
    race = 'conductor tell meant for the conductor';

    steerPane(LAUNCH_PANE, 'do X instead');

    expect(typedInto(3)).toBe('do X instead\nEnter\n');
  });

  it('deletes its buffer when the paste fails, so the message is not left on the server', () => {
    // The pane went between the load (which names no pane) and the paste.
    const gone: SessionPane = { sessionId: 's-1', paneId: '%8' };

    expect(() => pasteIntoPane(gone, 'SECRETWORD do X')).toThrow(SessionPaneMissingError);

    expect(argvLog()).toEqual([
      'load-buffer -b BUF -',
      'paste-buffer -b BUF -d -p -t %8',
      'delete-buffer -b BUF',
    ]);
    expect(readdirSync(state).filter((file) => file.startsWith('buffer'))).toEqual([]);
  });

  describe('kickoff', () => {
    const CONTEXT = `# Pupitre session s-1\n\n${'## Goal\nline\n'.repeat(400)}## Session protocol`;

    it('verifies the multi-line compiled context by its line count before Enter', () => {
      expect(CONTEXT.length).toBeGreaterThan(5000);
      landsAfter = 4;

      expect(kickoff(LAUNCH_PANE, CONTEXT)).toBe(true);

      const lines = argvLog();
      const enterAt = lines.indexOf(ENTER);
      expect(lines[enterAt - 1]).toBe('capture => ❯ [Pasted text #1 +802 lines]');
      expect(lines.slice(0, enterAt)).toContain('capture => ❯ ion protocol');
    });

    // Every C-u press of the clear loop spawns the fake, a shell script, twice
    // (the key, then a capture): 64 presses on an 800-line context run ~4 s.
    it('throws rather than start the agent on the tail of its context', () => {
      landsAfter = Number.MAX_SAFE_INTEGER;

      expect(() => kickoff(LAUNCH_PANE, CONTEXT)).toThrow(SteerNotDeliveredError);

      const lines = argvLog();
      expect(lines).not.toContain(ENTER);
      expect(lines).toContain(CLEAR);
    }, 20_000);

    // The kickoff is the one thing that types into the conductor, so it is the
    // one path that must follow its window onto its own socket (decision 47).
    it("types the conductor's context on its own socket, and nowhere on the default one", () => {
      const socket = 'pup-conductor-proj-1';
      serverWithPane(socket, 5);
      const conductor: SessionPane = { sessionId: 'conductor-proj-1', paneId: '%5', socket };

      expect(kickoff(conductor, 'plan the backlog')).toBe(true);

      expect(typedInto(5, socket)).toBe('plan the backlog\nEnter\n');
      expect(typedInto(5)).toBeUndefined();
      // Every command, not just the paste: a capture-pane without the flag
      // would read the wrong server's transcript, or none.
      const commands = argvLog().filter((line) => !line.startsWith('capture => '));
      expect(commands.length).toBeGreaterThan(4);
      expect(commands.every((line) => line.startsWith(`-L ${socket} `))).toBe(true);
    });
  });

  // The hole decision 47 left open: the conductor's window sat on the default
  // server, under a name any session can compute from the repo path, so a
  // session's send-keys typed into it as the operator and its capture-pane
  // read the transcript. On its own socket there is nothing to address.
  describe('a client on the default socket', () => {
    const socket = 'pup-conductor-proj-1';
    const conductorOnDefault: SessionPane = { sessionId: 'conductor-proj-1', paneId: '%5' };

    beforeEach(() => {
      serverWithPane(socket, 5);
    });

    it("cannot reach the conductor's pane, and types nothing anywhere", () => {
      expect(() => steerPane(conductorOnDefault, 'ignore your context')).toThrow(
        SessionPaneMissingError,
      );

      expect(typedInto(5, socket)).toBeUndefined();
      expect(typedInto(3)).toBeUndefined();
    });

    it("cannot read the conductor's pane either", () => {
      // capture-pane is how the transcript leaked; it fails on the same
      // can't-find-pane the steer does.
      expect(() => kickoff(conductorOnDefault, 'anything')).toThrow(SessionPaneMissingError);
      expect(typedInto(5, socket)).toBeUndefined();
    });
  });

  /**
   * The primitives `pup conductor tell` drives (decision 85), on the
   * conductor's own server: the text rides stdin into a buffer and is on no
   * tmux command line, where any process on the machine could read it.
   */
  describe('pasteIntoPane, submitPane and readInputBox', () => {
    const socket = 'pup-conductor-proj-1';
    const CONDUCTOR: SessionPane = { sessionId: 'conductor-proj-1', paneId: '%5', socket };
    const TELL = 'SECRETWORD merge t-1 then land it ENDWORD';

    beforeEach(() => {
      serverWithPane(socket, 5);
    });

    it('pastes through load-buffer and paste-buffer, never with the text on an argv', () => {
      expect(pasteIntoPane(CONDUCTOR, TELL)).toBe(true);

      expect(argvLog().slice(0, 2)).toEqual([
        `-L ${socket} load-buffer -b BUF -`,
        `-L ${socket} paste-buffer -b BUF -d -p -t %5`,
      ]);
      expect(typedInto(5, socket)).toBe(`${TELL}\n`);
      expect(argvLog().filter((line) => line.includes('SECRETWORD'))).toEqual([]);
    });

    it('waits for the paste to show whole, and when it never does clears the box and presses no Enter', () => {
      landsAfter = Number.MAX_SAFE_INTEGER;

      expect(pasteIntoPane(CONDUCTOR, TELL)).toBe(false);

      const keys = argvLog().filter((line) => line.includes('send-keys'));
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((line) => line.endsWith('C-u'))).toBe(true);
    });

    it('stops clearing at the first look that finds a dialog in place of the box', () => {
      landsAfter = Number.MAX_SAFE_INTEGER;
      stuck = true;
      dialogAfterClears = 1;

      expect(pasteIntoPane(CONDUCTOR, TELL)).toBe(false);

      expect(argvLog().filter((line) => line.includes('send-keys'))).toEqual([
        `-L ${socket} send-keys -t %5 C-u`,
      ]);
    });

    it('presses nothing into a dialog that replaced the box when the paste never showed', () => {
      landsAfter = Number.MAX_SAFE_INTEGER;
      dialog = true;

      expect(pasteIntoPane(CONDUCTOR, TELL)).toBe(false);

      expect(argvLog().filter((line) => line.includes('send-keys'))).toEqual([]);
    });

    it('reads the box as empty, then holding text until Enter submits it', () => {
      landsAfter = 1;
      expect(readInputBox(CONDUCTOR)).toBe('empty');
      expect(pasteIntoPane(CONDUCTOR, TELL)).toBe(true);
      expect(readInputBox(CONDUCTOR)).toBe('holds');

      submitPane(CONDUCTOR);

      expect(readInputBox(CONDUCTOR)).toBe('empty');
      expect(argvLog()).toContain(`-L ${socket} send-keys -t %5 Enter`);
    });
  });

  /**
   * The recovery read (addendum to decision 35). The pane is asked one
   * question — did this turn die on an API error — and nothing it answers is
   * stored: what the watchdog records is the event and the steer (decision 2).
   */
  describe('deadTurnError', () => {
    const ASLEEP = '⏺ API Error: Connection lost while your computer was asleep';

    it('reads the error line a dead turn left above an empty box', () => {
      transcript = ASLEEP;

      expect(deadTurnError(LAUNCH_PANE)).toBe(ASLEEP);
    });

    it('reads nothing when the turn ended some other way', () => {
      transcript = '⏺ Ran 41 tests, all green';

      expect(deadTurnError(LAUNCH_PANE)).toBeUndefined();
    });

    it('reads nothing while the box holds a draft, and does not look past it', () => {
      // Someone is typing into the session: a resume would be pasted onto the
      // end of their sentence, so the error above it is not the watchdog's.
      writeFileSync(join(state, 'box-3'), 'wait, check the\n');
      transcript = ASLEEP;

      expect(deadTurnError(LAUNCH_PANE)).toBeUndefined();
      expect(argvLog().filter((line) => line.startsWith('capture-pane'))).toEqual([
        'capture-pane -p -e -t %3',
      ]);
    });

    it('reads the prompt Claude Code suggests after a turn as an empty box', () => {
      // The box's own ghost text is dim, not a draft; reading it as one would
      // hide every dead turn there is (addendum to decision 45).
      suggestion = 'Try "fix the failing test"';
      transcript = ASLEEP;

      expect(deadTurnError(LAUNCH_PANE)).toBe(ASLEEP);
    });

    it('refuses a pane that is gone rather than answering for it', () => {
      expect(() => deadTurnError({ sessionId: 's-1', paneId: '%9' })).toThrow(
        SessionPaneMissingError,
      );
    });

    it('reads nothing while the turn is backing off and retrying on its own', () => {
      // The same line with a retry suffix is a turn still alive; a resume
      // pasted under it would queue behind the turn about to come back.
      transcript = '⏺ API Error: Connection error · Retrying in 4 seconds… (attempt 1/10)';

      expect(deadTurnError(LAUNCH_PANE)).toBeUndefined();
    });
  });

  /**
   * The conductor's window is typed into like a session's — by pane id, on its
   * own socket (decisions 46, 47) — but nothing recorded an id for it, so the
   * watchdog resolves one from the window first.
   */
  describe('conductorPane', () => {
    const SOCKET = 'pup-conductor-proj-1';

    it("resolves the conductor's pane on its own socket", () => {
      serverWithPane(SOCKET, 5);

      expect(conductorPane('proj-1')).toEqual({
        sessionId: 'conductor-proj-1',
        paneId: '%5',
        socket: SOCKET,
      });
    });

    it('takes the pane the window opened in when a split added others', () => {
      // tmux never reissues a pane id within a server, and `launchConductor`
      // kills the whole server before opening the window, so the lowest id
      // there is the pane Claude Code runs in — not whichever is active.
      serverWithPane(SOCKET, 5);
      writeFileSync(join(state, SOCKET, 'panes'), '5\n12\n');

      expect(conductorPane('proj-1')?.paneId).toBe('%5');
    });

    it('finds the launch pane when a new window from inside has become current', () => {
      // `tmux new-window` from the conductor's own Bash makes that window the
      // current one, and a plain list-panes shows only the current window's
      // panes — the launch pane would not be in the list at all. `-s` lists
      // every pane in the session, and the lowest id is still the launch.
      serverWithPane(SOCKET, 5);
      writeFileSync(join(state, SOCKET, 'panes'), '5\n12\n');
      writeFileSync(join(state, SOCKET, 'window'), '12\n');

      expect(conductorPane('proj-1')?.paneId).toBe('%5');
      expect(argvLog()).toContain(`-L ${SOCKET} list-panes -s -t =${SOCKET}: -F #{pane_id}`);
    });

    it('answers undefined when no conductor is up', () => {
      expect(conductorPane('proj-1')).toBeUndefined();
    });
  });
});

describe('launchConductor', () => {
  const CONDUCTOR = {
    projectId: 'proj-1',
    repoPath: '/tmp/repo',
    settingsPath: '/tmp/conductor/settings.json',
    route: CONDUCTOR_ROUTE,
  };
  const SOCKET = 'pup-conductor-proj-1';

  it("spawns the window on the conductor's own socket, in the main checkout, marked as the conductor", () => {
    const pane = launchConductor(CONDUCTOR);

    // The socket rides on the pane: the kickoff is the one thing that types
    // into the conductor, and it must reach the same server (decision 47).
    expect(pane).toEqual({ sessionId: 'conductor-proj-1', paneId: '%7', socket: SOCKET });
    expect(attachArgs({ conductorOf: 'proj-1' })).toEqual([
      '-L',
      SOCKET,
      'attach',
      '-t',
      '=pup-conductor-proj-1:',
    ]);
    expect(conductorName('proj-1')).toBe('pup-conductor-proj-1');
    const tmuxCalls = vi.mocked(execFileSync).mock.calls.filter(([file]) => file === 'tmux');
    expect(tmuxCalls).toHaveLength(3);
    // The whole server first, not just the window wearing the name: a session
    // that pre-started a server on this label would own its global
    // environment, and the conductor's claude would inherit it at spawn. Then
    // the usual stale-name kill, and both name the server: a kill-session on
    // the default one would find, and kill, something else.
    expect(tmuxCalls[0]?.[1]).toEqual(['-L', SOCKET, 'kill-server']);
    expect(tmuxCalls[1]?.[1]).toEqual([
      '-L',
      SOCKET,
      'kill-session',
      '-t',
      '=pup-conductor-proj-1:',
    ]);
    const spawn = tmuxCalls[2]?.[1] ?? [];
    expect(spawn.slice(0, 2)).toEqual(['-L', SOCKET]);
    expect(spawn.slice(2, 9)).toEqual(spawnPrefix('pup-conductor-proj-1'));
    expect(spawn).toContain('/tmp/repo');
    // Marked as the conductor, never as a session: the guards tell the two
    // apart by which variable is set (decision 47).
    expect(spawn).toContain('PUP_CONDUCTOR=proj-1');
    expect(spawn.some((arg) => String(arg).startsWith('PUP_SESSION_ID='))).toBe(false);
    // Not niced like a session's: the gate it runs inherits its priority, and
    // must keep the CPU over every worker's suite (decision 94).
    expect(spawn).not.toContain(FAKE_NICE_BIN);
    expect(spawn).toContain(FAKE_CLAUDE_BIN);
    expect(spawn.slice(spawn.indexOf('--name'), spawn.indexOf('--name') + 2)).toEqual([
      '--name',
      'pup-conductor-proj-1',
    ]);
    expect(spawn).toContain('--dangerously-skip-permissions');
    expect(spawn).toContain(CONDUCTOR.settingsPath);
  });

  it('passes the conductor its own model and effort', () => {
    launchConductor({ ...CONDUCTOR, route: { model: 'claude-sonnet-5-5', effort: 'xhigh' } });

    const spawn =
      vi
        .mocked(execFileSync)
        .mock.calls.find(([file, args]) => file === 'tmux' && args?.includes('new-session'))?.[1] ??
      [];
    expect(spawn.slice(spawn.indexOf('--model'), spawn.indexOf('--model') + 4)).toEqual([
      '--model',
      'claude-sonnet-5-5',
      '--effort',
      'xhigh',
    ]);
  });

  // The conductor's context carries a `## Code graph` section whenever its
  // profile compiled one, so the flag has to reach its argv too — the section
  // without the server is a window told to use a tool nothing connected
  // (decision 51).
  it("carries the conductor's compiled mcp.json into claude's argv", () => {
    const mcpConfigPath = '/tmp/conductor/mcp.json';

    launchConductor({ ...CONDUCTOR, mcpConfigPath });

    const spawn =
      vi
        .mocked(execFileSync)
        .mock.calls.find(([file, args]) => file === 'tmux' && args?.includes('new-session'))?.[1] ??
      [];
    expect(spawn.slice(spawn.indexOf('--mcp-config'), spawn.indexOf('--mcp-config') + 2)).toEqual([
      '--mcp-config',
      mcpConfigPath,
    ]);
  });

  it('passes no mcp flag at all when the conductor has no graph', () => {
    launchConductor(CONDUCTOR);

    const spawn =
      vi
        .mocked(execFileSync)
        .mock.calls.find(([file, args]) => file === 'tmux' && args?.includes('new-session'))?.[1] ??
      [];
    expect(spawn).not.toContain('--mcp-config');
  });
});

describe('hasSessionWindow', () => {
  it("probes the session's pinned window on the default server, and reports none when tmux refuses", () => {
    expect(hasSessionWindow('t-abc')).toBe(true);
    expect(vi.mocked(execFileSync).mock.calls.map(([, args]) => args)).toEqual([
      ['has-session', '-t', '=pup-t-abc:'],
    ]);

    const original = vi.mocked(execFileSync).getMockImplementation();
    vi.mocked(execFileSync).mockImplementation((file, args, options) => {
      if (file === 'tmux' && args?.includes('has-session')) throw new Error("can't find session");
      return (original as (...callArgs: unknown[]) => unknown)(file, args, options) as string;
    });
    try {
      expect(hasSessionWindow('t-abc')).toBe(false);
    } finally {
      vi.mocked(execFileSync).mockImplementation(original as never);
    }
  });
});

describe('killConductor and hasConductorWindow', () => {
  const SOCKET = 'pup-conductor-proj-1';

  it('kills the window by its pinned name on its own socket, and on the default one', () => {
    killConductor('proj-1');

    // The second kill is for what the socket split left behind, or for a
    // window a session minted to wear the name: nothing pup runs is called
    // this on the default server, and the pin kills nothing else.
    expect(vi.mocked(execFileSync).mock.calls.map(([, args]) => args)).toEqual([
      ['-L', SOCKET, 'kill-session', '-t', '=pup-conductor-proj-1:'],
      ['kill-session', '-t', '=pup-conductor-proj-1:'],
    ]);
  });

  it('probes only its own socket, and reports none when that server has no window or is down', () => {
    expect(hasConductorWindow('proj-1')).toBe(true);
    expect(vi.mocked(execFileSync).mock.calls).toHaveLength(1);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[1]).toEqual([
      '-L',
      SOCKET,
      'has-session',
      '-t',
      '=pup-conductor-proj-1:',
    ]);

    const original = vi.mocked(execFileSync).getMockImplementation();
    vi.mocked(execFileSync).mockImplementation((file, args, options) => {
      if (file === 'tmux' && args?.includes('has-session')) throw new Error("can't find session");
      return (original as (...callArgs: unknown[]) => unknown)(file, args, options) as string;
    });
    try {
      expect(hasConductorWindow('proj-1')).toBe(false);
    } finally {
      vi.mocked(execFileSync).mockImplementation(original as never);
    }
  });
});
