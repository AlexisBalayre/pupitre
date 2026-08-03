import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fakes `tmux`/`which` so this suite never spawns a real tmux pane or shells
// out to resolve `claude` on PATH — spawning a tmux pane is explicitly out of
// scope for a test process (docs/conventions/testing.md). Every other
// execFileSync call — git, in particular — still runs for real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fakeExecFileSync = vi.fn((file: string, args?: readonly string[], options?: unknown) => {
    if (file === 'tmux') return '';
    if (file === 'which') return '/fake/bin/claude\n';
    return (actual.execFileSync as (...callArgs: unknown[]) => unknown)(file, args, options);
  });
  return { ...actual, execFileSync: fakeExecFileSync };
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

import {
  interruptSession,
  launchArgs,
  launchSession,
  launchWatcher,
  preseedTrust,
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
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-trust-')));
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
    const claudeJson = join(mkdtempSync(join(tmpdir(), 'pup-cfg-')), 'claude.json');

    preseedTrust(worktree, claudeJson);

    const projects = readProjects(claudeJson);
    expect(projects[worktree]?.hasTrustDialogAccepted).toBe(true);
    expect(projects[repo]?.hasTrustDialogAccepted).toBe(true);
  });

  it('preserves existing project entries and flips declined trust to accepted', () => {
    const { repo, worktree } = initRepoWithWorktree();
    const claudeJson = join(mkdtempSync(join(tmpdir(), 'pup-cfg-')), 'claude.json');
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

  it('seeds only the launch path when it is not a git checkout', () => {
    const plainDir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-plain-')));
    const claudeJson = join(mkdtempSync(join(tmpdir(), 'pup-cfg-')), 'claude.json');

    preseedTrust(plainDir, claudeJson);

    const projects = readProjects(claudeJson);
    expect(projects[plainDir]?.hasTrustDialogAccepted).toBe(true);
    expect(Object.keys(projects)).toHaveLength(1);
  });

  it('writes a single entry when launching at the repo root itself', () => {
    const { repo } = initRepoWithWorktree();
    const claudeJson = join(mkdtempSync(join(tmpdir(), 'pup-cfg-')), 'claude.json');

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

  it('passes the model flag only when a model is set', () => {
    expect(launchArgs(OPTS)).not.toContain('--model');
    expect(launchArgs({ ...OPTS, model: 'opus' })).toContain('--model');
  });
});

// FAKE_CLAUDE_BIN must match the 'which' branch faked in the node:child_process
// mock above.
const FAKE_CLAUDE_BIN = '/fake/bin/claude';

describe('launchSession', () => {
  it('kills any stale session, then spawns tmux with the window size, env, and resolved claude binary', () => {
    const { target } = launchSession(OPTS);

    expect(target).toBe('pup-s-1');
    const tmuxCalls = vi.mocked(execFileSync).mock.calls.filter(([file]) => file === 'tmux');
    expect(tmuxCalls).toHaveLength(2);
    expect(tmuxCalls[0]).toEqual([
      'tmux',
      ['kill-session', '-t', 'pup-s-1'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    ]);
    expect(tmuxCalls[1]?.[1]).toEqual([
      'new-session',
      '-d',
      '-s',
      'pup-s-1',
      '-x',
      '220',
      '-y',
      '50',
      '-c',
      OPTS.worktreePath,
      '-e',
      `PUP_SESSION_ID=${OPTS.sessionId}`,
      '-e',
      `PUP_BIN=${process.argv[1] ?? 'pup'}`,
      FAKE_CLAUDE_BIN,
      ...launchArgs(OPTS),
    ]);
  });
});

describe('interruptSession', () => {
  it('sends Escape to the session pane and nothing else', () => {
    // Skip the real post-Escape settle — spying (not restoreAllMocks) so the
    // module-level execFileSync fake survives for the rest of the suite.
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    try {
      interruptSession('s-1');
    } finally {
      wait.mockRestore();
    }

    const tmuxCalls = vi.mocked(execFileSync).mock.calls.filter(([file]) => file === 'tmux');
    expect(tmuxCalls).toHaveLength(1);
    expect(tmuxCalls[0]?.[1]).toEqual(['send-keys', '-t', 'pup-s-1', 'Escape']);
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
      ['kill-session', '-t', 'pup-watch-proj-1'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    ]);
    expect(tmuxCalls[1]?.[1]).toEqual([
      'new-session',
      '-d',
      '-s',
      'pup-watch-proj-1',
      '-c',
      '/tmp/repo',
      process.execPath,
      process.argv[1] ?? 'pup',
      'watch',
    ]);
  });
});
