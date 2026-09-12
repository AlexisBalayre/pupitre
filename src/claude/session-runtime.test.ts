import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fakes `tmux`/`which` so this suite never spawns a real tmux pane or shells
// out to resolve `claude` on PATH — spawning a tmux pane is explicitly out of
// scope for a test process (docs/conventions/testing.md). Every other
// execFileSync call — git, in particular — still runs for real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fakeExecFileSync = vi.fn((file: string, args?: readonly string[], options?: unknown) => {
    // new-session is asked to print the pane it opened (-P -F '#{pane_id}').
    if (file === 'tmux') return args?.[0] === 'new-session' ? '%7\n' : '';
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
  conductorName,
  hasConductorWindow,
  interruptPane,
  kickoff,
  killConductor,
  killSession,
  launchArgs,
  launchConductor,
  launchSession,
  launchWatcher,
  preseedTrust,
  type SessionPane,
  SessionPaneMissingError,
  SteerNotDeliveredError,
  steerPane,
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

// FAKE_CLAUDE_BIN must match the 'which' branch faked in the node:child_process
// mock above.
const FAKE_CLAUDE_BIN = '/fake/bin/claude';

describe('launchSession', () => {
  it('kills any stale session, then spawns tmux with the window size, env, and resolved claude binary, and returns the pane it printed', () => {
    const pane = launchSession(OPTS);

    // The pane id, not the session name: it is what every later steer,
    // interrupt and capture is addressed to (decision 46).
    expect(pane).toEqual({ sessionId: 's-1', paneId: '%7' });
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
      '-P',
      '-F',
      '#{pane_id}',
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
      expect(() => launchSession(OPTS)).toThrow('tmux new-session printed "", not a pane id.');
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
      '-P',
      '-F',
      '#{pane_id}',
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
 * being ingested (its last row's tail), then, from the `FAKE_TMUX_LANDS_AFTER`th capture on, the
 * folded placeholder with its newline count. Enter empties the box; Ctrl-U
 * takes one row per press, as the real UI does, and none at all when
 * `FAKE_TMUX_STUCK` is set. Every capture's box line is logged too, so a test
 * can read what the runtime saw before it pressed a key.
 *
 * Panes are modelled the way tmux resolves `-t`: a pane id names that pane,
 * which must be listed in `panes` or the command fails with tmux's own
 * can't-find-pane line; anything else is a session target and resolves to
 * the pane named in `active`, which a split from inside the session moves.
 * Each pane has its own box, and what was pasted or keyed into it is kept in
 * `typed-<pane>`, so a test can tell which pane a steer reached. With
 * `FAKE_TMUX_DOWN` set every command fails the way a dead server does.
 */
const FAKE_TMUX = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
if [ -n "$FAKE_TMUX_DOWN" ]; then
  echo 'error connecting to /private/tmp/tmux-501/default (No such file or directory)' >&2
  exit 1
fi
target=''
prev=''
for arg in "$@"; do
  [ "$prev" = -t ] && target="$arg"
  prev="$arg"
done
case "$target" in
  %*) pane="\${target#%}"
      grep -qx "$pane" "$FAKE_TMUX_STATE/panes" || { echo "can't find pane: $target" >&2; exit 1; } ;;
  *) pane=$(cat "$FAKE_TMUX_STATE/active") ;;
esac
box="$FAKE_TMUX_STATE/box-$pane"
typed="$FAKE_TMUX_STATE/typed-$pane"
case "$1" in
  load-buffer) cat > "$FAKE_TMUX_STATE/buffer" ;;
  paste-buffer) cp "$FAKE_TMUX_STATE/buffer" "$box"; cat "$box" >> "$typed"; echo >> "$typed" ;;
  send-keys)
    echo "$4" >> "$typed"
    [ "$4" = Enter ] && rm -f "$box"
    if [ "$4" = C-u ] && [ -z "$FAKE_TMUX_STUCK" ] && [ -f "$box" ]; then
      rows=$(grep -c '' "$box")
      if [ "$rows" -le 1 ]; then rm -f "$box"
      else head -n $((rows - 1)) "$box" > "$box.tmp" && mv "$box.tmp" "$box"; fi
    fi ;;
  capture-pane)
    n=$(( $(cat "$FAKE_TMUX_STATE/captures" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$FAKE_TMUX_STATE/captures"
    if [ ! -f "$box" ]; then line='❯ '
    elif [ "$n" -lt "$FAKE_TMUX_LANDS_AFTER" ]; then line="❯ $(tail -n 1 "$box" | tail -c 12)"
    else
      newlines=$(tr -cd '\\n' < "$box" | wc -c | tr -d ' ')
      if [ "$newlines" -gt 0 ]; then line="❯ [Pasted text #1 +$newlines lines]"
      else line='❯ [Pasted text #1]'; fi
    fi
    printf 'capture => %s\\n' "$line" >> "$FAKE_TMUX_LOG"
    printf '  ? for shortcuts\\n────\\n%s\\n────\\n' "$line" ;;
esac
`;

describe('steerPane with a fake tmux on PATH', () => {
  const original = vi.mocked(execFileSync).getMockImplementation();
  let log: string;
  let state: string;
  let landsAfter: number;
  let stuck: boolean;
  let down: boolean;
  let wait: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-fake-tmux-')));
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
    down = false;
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
              FAKE_TMUX_STATE: state,
              FAKE_TMUX_LANDS_AFTER: String(landsAfter),
              ...(stuck ? { FAKE_TMUX_STUCK: '1' } : {}),
              ...(down ? { FAKE_TMUX_DOWN: '1' } : {}),
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

  /** What reached pane `n`: each paste's text, then each key, one per line. */
  function typedInto(n: number): string | undefined {
    const file = join(state, `typed-${n}`);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  }

  const LAUNCH_PANE: SessionPane = { sessionId: 's-1', paneId: '%3' };
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
      'capture-pane -p -t %3',
      'capture => ❯ ',
      'load-buffer -',
      'paste-buffer -d -p -t %3',
    ]);
    const enterAt = lines.indexOf(ENTER);
    expect(enterAt).toBeGreaterThan(0);
    expect(lines.slice(4, enterAt)).toEqual([
      'capture-pane -p -t %3',
      'capture => ❯ k LASTWORDS.',
      'capture-pane -p -t %3',
      'capture => ❯ k LASTWORDS.',
      'capture-pane -p -t %3',
      'capture => ❯ [Pasted text #1]',
    ]);
    // Submission verified after Enter, exactly as before; no clear was needed.
    expect(lines.slice(enterAt + 1)).toEqual(['capture-pane -p -t %3', 'capture => ❯ ']);
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

    expect(argvLog()).toEqual(['capture-pane -p -t %3', 'capture-pane -p -t %3']);
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
      'capture-pane -p -t %3',
      'capture => ❯ row three',
      CLEAR,
      'capture-pane -p -t %3',
      'capture => ❯ row two',
      CLEAR,
      'capture-pane -p -t %3',
      'capture => ❯ row one',
      CLEAR,
      'capture-pane -p -t %3',
      'capture => ❯ ',
      'load-buffer -',
    ]);
    expect(lines.indexOf('paste-buffer -d -p -t %3')).toBeGreaterThan(lines.indexOf(CLEAR));
  });

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
    // ceil(6000 / 1000) settles for the first call, each ending in a look at the box.
    const settles = lines.filter((line) => line === 'capture => ❯ tok tok tok ');
    expect(settles).toHaveLength(6);
    expect(lines.slice(-3)).toEqual([CLEAR, 'capture-pane -p -t %3', 'capture => ❯ ']);
  });

  it('floors a short steer at five settles, so a late repaint under load is not a refusal', () => {
    landsAfter = Number.MAX_SAFE_INTEGER;

    expect(() => steerPane(LAUNCH_PANE, 'do X instead, then run the tests')).toThrow(
      SteerNotDeliveredError,
    );

    expect(argvLog().filter((line) => line === 'capture => ❯ un the tests')).toHaveLength(5);
  });

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
    expect(lines).not.toContain('load-buffer -');
    expect(lines).not.toContain(ENTER);
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
  });
});

describe('launchConductor', () => {
  const CONDUCTOR = {
    projectId: 'proj-1',
    repoPath: '/tmp/repo',
    settingsPath: '/tmp/conductor/settings.json',
  };

  it('spawns the window in the main checkout, named and marked as the conductor, and returns its pane', () => {
    const pane = launchConductor(CONDUCTOR);

    expect(pane).toEqual({ sessionId: 'conductor-proj-1', paneId: '%7' });
    expect(conductorName('proj-1')).toBe('pup-conductor-proj-1');
    const tmuxCalls = vi.mocked(execFileSync).mock.calls.filter(([file]) => file === 'tmux');
    expect(tmuxCalls).toHaveLength(2);
    expect(tmuxCalls[0]?.[1]).toEqual(['kill-session', '-t', '=pup-conductor-proj-1:']);
    const spawn = tmuxCalls[1]?.[1] ?? [];
    expect(spawn.slice(0, 7)).toEqual([
      'new-session',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-s',
      'pup-conductor-proj-1',
    ]);
    expect(spawn).toContain('/tmp/repo');
    // Marked as the conductor, never as a session: the guards tell the two
    // apart by which variable is set (decision 47).
    expect(spawn).toContain('PUP_CONDUCTOR=proj-1');
    expect(spawn.some((arg) => String(arg).startsWith('PUP_SESSION_ID='))).toBe(false);
    expect(spawn).toContain(FAKE_CLAUDE_BIN);
    expect(spawn.slice(spawn.indexOf('--name'), spawn.indexOf('--name') + 2)).toEqual([
      '--name',
      'pup-conductor-proj-1',
    ]);
    expect(spawn).toContain('--dangerously-skip-permissions');
    expect(spawn).toContain(CONDUCTOR.settingsPath);
  });

  it('passes the conductor its own model', () => {
    launchConductor({ ...CONDUCTOR, model: 'fable' });

    const spawn = vi
      .mocked(execFileSync)
      .mock.calls.find(([file, args]) => file === 'tmux' && args?.[0] === 'new-session')?.[1];
    expect(spawn?.slice(spawn.indexOf('--model'), spawn.indexOf('--model') + 2)).toEqual([
      '--model',
      'fable',
    ]);
  });
});

describe('killConductor and hasConductorWindow', () => {
  it('kills the window by its pinned name', () => {
    killConductor('proj-1');

    expect(vi.mocked(execFileSync).mock.calls.map(([, args]) => args)).toEqual([
      ['kill-session', '-t', '=pup-conductor-proj-1:'],
    ]);
  });

  it('reports a window wearing the name, and none when tmux has none or no server runs', () => {
    expect(hasConductorWindow('proj-1')).toBe(true);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[1]).toEqual([
      'has-session',
      '-t',
      '=pup-conductor-proj-1:',
    ]);

    const original = vi.mocked(execFileSync).getMockImplementation();
    vi.mocked(execFileSync).mockImplementation((file, args, options) => {
      if (file === 'tmux' && args?.[0] === 'has-session') throw new Error("can't find session");
      return (original as (...callArgs: unknown[]) => unknown)(file, args, options) as string;
    });
    try {
      expect(hasConductorWindow('proj-1')).toBe(false);
    } finally {
      vi.mocked(execFileSync).mockImplementation(original as never);
    }
  });
});
