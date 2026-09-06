import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  kickoff,
  launchArgs,
  launchSession,
  launchWatcher,
  preseedTrust,
  SteerNotDeliveredError,
  steerSession,
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
      ['kill-session', '-t', '=pup-s-1:'],
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
  it('sends Escape to the exact-match pinned pane target and spawns nothing else', () => {
    // Skip the real post-Escape settle — spying (not restoreAllMocks) so the
    // module-level execFileSync fake survives for the rest of the suite.
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    try {
      interruptSession('s-1');
    } finally {
      wait.mockRestore();
    }

    // Full call list, not a tmux-filtered one — a future non-tmux spawn here
    // must fail this test too. The '=...:' pin is load-bearing: a bare name
    // prefix-matches a live sibling once this session's window is gone.
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('tmux');
    expect(calls[0]?.[1]).toEqual(['send-keys', '-t', '=pup-s-1:', 'Escape']);
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

/**
 * A `tmux` on PATH that logs its argv and plays the Claude Code input box
 * (docs/conventions/testing.md, "Faking an external CLI"): `load-buffer` keeps
 * the message, `paste-buffer` puts it in the box, and `capture-pane` renders
 * the box the way 2.1.263 does — the message's tail while the paste is still
 * being ingested, then, from the `FAKE_TMUX_LANDS_AFTER`th capture on, the
 * folded placeholder with its newline count. Enter and Ctrl-U empty the box.
 * Every capture's box line is logged too, so a test can read what the runtime
 * saw before it pressed a key.
 */
const FAKE_TMUX = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
box="$FAKE_TMUX_STATE/box"
case "$1" in
  load-buffer) cat > "$FAKE_TMUX_STATE/buffer" ;;
  paste-buffer) cp "$FAKE_TMUX_STATE/buffer" "$box" ;;
  send-keys) [ "$4" = Enter ] || [ "$4" = C-u ] && rm -f "$box" ;;
  capture-pane)
    n=$(( $(cat "$FAKE_TMUX_STATE/captures" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$FAKE_TMUX_STATE/captures"
    if [ ! -f "$box" ]; then line='❯ '
    elif [ "$n" -lt "$FAKE_TMUX_LANDS_AFTER" ]; then line="❯ $(tail -c 12 "$box")"
    else
      newlines=$(tr -cd '\\n' < "$box" | wc -c | tr -d ' ')
      if [ "$newlines" -gt 0 ]; then line="❯ [Pasted text #1 +$newlines lines]"
      else line='❯ [Pasted text #1]'; fi
    fi
    printf 'capture => %s\\n' "$line" >> "$FAKE_TMUX_LOG"
    printf '  ? for shortcuts\\n────\\n%s\\n────\\n' "$line" ;;
esac
`;

describe('steerSession with a fake tmux on PATH', () => {
  const original = vi.mocked(execFileSync).getMockImplementation();
  let log: string;
  let landsAfter: number;
  let wait: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-fake-tmux-')));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'state'));
    writeFileSync(join(dir, 'bin', 'tmux'), FAKE_TMUX, { mode: 0o755 });
    log = join(dir, 'tmux.log');
    writeFileSync(log, '');
    landsAfter = 0;
    // Every settle is skipped: what is under test is what the runtime does
    // between settles, and the fake's clock is the capture count.
    wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(execFileSync).mockImplementation((file, args, options) =>
      file === 'tmux'
        ? real.execFileSync(file, args as string[], {
            ...(options as object),
            env: {
              ...process.env,
              PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
              FAKE_TMUX_LOG: log,
              FAKE_TMUX_STATE: join(dir, 'state'),
              FAKE_TMUX_LANDS_AFTER: String(landsAfter),
            },
          })
        : ((original as (...callArgs: unknown[]) => unknown)(file, args, options) as string),
    );
  });

  afterEach(() => {
    wait.mockRestore();
    vi.mocked(execFileSync).mockImplementation(original as never);
  });

  function argvLog(): string[] {
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
  }

  const STEER_3000 = `FIRSTWORD ${'tok '.repeat(745)}LASTWORDS.`;
  const ENTER = 'send-keys -t =pup-s-1: Enter';
  const CLEAR = 'send-keys -t =pup-s-1: C-u';

  it('pastes a 3000-char steer bracketed and presses Enter only once the pane shows it whole', () => {
    expect(STEER_3000).toHaveLength(3000);
    // One capture checks the box is empty before the paste; the placeholder
    // then appears at the third settle, not the first.
    landsAfter = 4;

    steerSession('s-1', STEER_3000);

    const lines = argvLog();
    expect(lines.slice(0, 4)).toEqual([
      'capture-pane -p -t =pup-s-1:',
      'capture => ❯ ',
      'load-buffer -',
      'paste-buffer -d -p -t =pup-s-1:',
    ]);
    const enterAt = lines.indexOf(ENTER);
    expect(enterAt).toBeGreaterThan(0);
    expect(lines.slice(4, enterAt)).toEqual([
      'capture-pane -p -t =pup-s-1:',
      'capture => ❯ k LASTWORDS.',
      'capture-pane -p -t =pup-s-1:',
      'capture => ❯ k LASTWORDS.',
      'capture-pane -p -t =pup-s-1:',
      'capture => ❯ [Pasted text #1]',
    ]);
    // Submission verified after Enter, exactly as before; no clear was needed.
    expect(lines.slice(enterAt + 1)).toEqual(['capture-pane -p -t =pup-s-1:', 'capture => ❯ ']);
    expect(lines.filter((line) => line === ENTER)).toHaveLength(1);
    expect(lines).not.toContain(CLEAR);
  });

  it('clears a draft the box already holds before pasting', () => {
    // A box with leftover text reads as text plus placeholder after the
    // paste, never as the message alone (seen live: `row one[Pasted text #33]`).
    writeFileSync(join(dirname(log), 'state', 'box'), 'row one');
    // The draft and then the short message both render inline (as their
    // own tail); nothing folds.
    landsAfter = Number.MAX_SAFE_INTEGER;

    steerSession('s-1', 'do X instead');

    const lines = argvLog();
    expect(lines.slice(0, 6)).toEqual([
      'capture-pane -p -t =pup-s-1:',
      'capture => ❯ row one',
      CLEAR,
      'capture-pane -p -t =pup-s-1:',
      'capture => ❯ ',
      'load-buffer -',
    ]);
    expect(lines.indexOf('paste-buffer -d -p -t =pup-s-1:')).toBeGreaterThan(lines.indexOf(CLEAR));
  });

  it('gives a steer one settle per KB, then clears the box and refuses without pressing Enter', () => {
    landsAfter = Number.MAX_SAFE_INTEGER;

    expect(() => steerSession('s-1', STEER_3000)).toThrow(SteerNotDeliveredError);
    expect(() => steerSession('s-1', STEER_3000)).toThrow(
      'Steer to session s-1 did not land: its input box never held the whole 3000-char message. ' +
        'Cleared the box and submitted nothing; the session is still running with an empty prompt.',
    );

    const lines = argvLog().slice(0, argvLog().indexOf(CLEAR) + 3);
    expect(lines).not.toContain(ENTER);
    // 1 + ceil(3000 / 1000) settles, each ending in a look at the box.
    const settles = lines.filter((line) => line === 'capture => ❯ k LASTWORDS.');
    expect(settles).toHaveLength(4);
    expect(lines.slice(-3)).toEqual([CLEAR, 'capture-pane -p -t =pup-s-1:', 'capture => ❯ ']);
  });

  it('gives a short steer fewer settles', () => {
    landsAfter = Number.MAX_SAFE_INTEGER;

    expect(() => steerSession('s-1', 'do X instead, then run the tests')).toThrow(
      SteerNotDeliveredError,
    );

    expect(argvLog().filter((line) => line === 'capture => ❯ un the tests')).toHaveLength(2);
  });

  describe('kickoff', () => {
    const CONTEXT = `# Pupitre session s-1\n\n${'## Goal\nline\n'.repeat(400)}## Session protocol`;

    it('verifies the multi-line compiled context by its line count before Enter', () => {
      expect(CONTEXT.length).toBeGreaterThan(5000);
      landsAfter = 4;

      expect(kickoff('s-1', CONTEXT)).toBe(true);

      const lines = argvLog();
      const enterAt = lines.indexOf(ENTER);
      expect(lines[enterAt - 1]).toBe('capture => ❯ [Pasted text #1 +802 lines]');
      expect(lines.slice(0, enterAt)).toContain('capture => ❯ ion protocol');
    });

    it('throws rather than start the agent on the tail of its context', () => {
      landsAfter = Number.MAX_SAFE_INTEGER;

      expect(() => kickoff('s-1', CONTEXT)).toThrow(SteerNotDeliveredError);

      const lines = argvLog();
      expect(lines).not.toContain(ENTER);
      expect(lines).toContain(CLEAR);
    });
  });
});
