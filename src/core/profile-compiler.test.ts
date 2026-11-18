import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { makeInput } from '@test/helpers/profile-compiler.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSessionEnv } from '../claude/session-runtime.service.js';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { projectPaths } from './paths.utils.js';
import {
  HOOK_TIMEOUT_SECONDS,
  RECHECK_HASH_MAX_BYTES,
  SLIM_CONTEXT_ENV,
  WORKER_SUBAGENT_ENV,
} from './profile.constants.js';
import * as ProfileCompiler from './profile-compiler.service.js';

// Many tests here spawn real git and sh; under load or coverage the 5 s default
// times out a different one each run, which also stops `pup audit` measuring coverage.
vi.setConfig({ testTimeout: 30_000 });

describe('generated bash re-check (decision 63)', () => {
  // No inherited GIT_*: under the pre-commit hook GIT_INDEX_FILE names the real
  // index, and a temp repo's `git add` would rewrite it.
  const GIT_ENV: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  let root: string;
  let repo: string;
  let worktree: string;
  let events: string;

  /**
   * A real linked git worktree of a repo with one commit, as a session's is, and
   * the session's profile compiled for it.
   */
  beforeEach(() => {
    root = tempDir('pup-recheck-');
    repo = join(root, 'repo');
    worktree = join(repo, '.worktrees', 's-1');
    events = join(root, 'events.jsonl');
    mkdirSync(join(repo, 'src/net'), { recursive: true });
    mkdirSync(join(repo, 'src/cli'), { recursive: true });
    writeFileSync(join(repo, 'src/net/client.ts'), 'export {};\n');
    writeFileSync(join(repo, 'src/cli/index.ts'), 'export {};\n');
    writeFileSync(join(repo, 'src/cli/decoy.ts'), 'export {};\n');
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['add', '-A'],
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'],
      ['worktree', 'add', '-q', '-b', 'pup/s-1', worktree, 'main'],
    ]) {
      spawnSync('git', args, { cwd: repo, env: GIT_ENV });
    }
    const outDir = join(root, 'compiled');
    const compiled = ProfileCompiler.compileProfile(
      makeInput({
        repoPath: repo,
        worktreePath: worktree,
        eventsFile: events,
        outDir,
      }),
    );
    ProfileCompiler.writeCompiledProfile(compiled, outDir);
  });

  /**
   * Run directly, not through Claude Code's hook harness, so the only thing that
   * ends a hang is this call's own 4-second timeout: set under the hook's 5-second
   * production budget so the test's kill wins the race and a hang reads as a
   * null status. A UTF-8 locale, as a session's shell usually has, which the
   * script must not depend on.
   */
  function run(payload: object, env: NodeJS.ProcessEnv = {}, timeout = 4_000) {
    return spawnSync('/bin/sh', [join(root, 'compiled/hooks/bash-recheck.sh')], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout,
      env: {
        ...GIT_ENV,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        PUP_SESSION_ID: 's-1',
        ...env,
      },
    });
  }

  /**
   * A sleep in `bin` that records each length it is asked for. Only the deadline's
   * watcher sleeps, so these are the seconds the hook gave each bounded read: its
   * own deadline arithmetic, which no machine load moves, unlike the wall time of
   * the whole spawn.
   */
  function recordSleeps(bin: string): () => number[] {
    const log = join(root, 'sleeps');
    const realSleep = spawnSync('/bin/sh', ['-c', 'command -v sleep'], {
      encoding: 'utf8',
    });
    writeFileSync(
      join(bin, 'sleep'),
      `#!/bin/sh\necho "$1" >> '${log}'\nexec ${realSleep.stdout.trim()} "$@"\n`,
      { mode: 0o755 },
    );
    return () =>
      existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  }

  function hook(phase: string, command: string, id = 'toolu_01abc') {
    return run({
      hook_event_name: phase,
      tool_use_id: id,
      tool_input: { command },
    });
  }

  /** The Bash call as Claude Code runs it: the pre hook, the command, the post hook. */
  function bash(command: string, phase = 'PostToolUse') {
    expect(hook('PreToolUse', command).status).toBe(0);
    spawnSync('sh', ['-c', command], { cwd: worktree, env: GIT_ENV });
    return hook(phase, command);
  }

  function violations(): Record<string, string>[] {
    if (!existsSync(events)) return [];
    return readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, string>)
      .filter((event) => event.type === 'scope_violation');
  }

  const heredoc = (path: string) =>
    `python3 - <<'EOF'\nopen('${path}', 'w').write('changed\\n')\nEOF`;

  it('refuses a python3 heredoc that wrote outside scope-in, and records the violation', () => {
    const command = heredoc('src/cli/index.ts');
    const result = bash(command);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('SCOPE VIOLATION: src/cli/index.ts (outside-scope-in)');
    expect(result.stderr).toContain(command);
    expect(violations()).toEqual([
      {
        type: 'scope_violation',
        pup_session_id: 's-1',
        path: 'src/cli/index.ts',
        reason: 'outside-scope-in',
        command,
      },
    ]);
  });

  it('passes a heredoc that wrote inside scope-in', () => {
    const result = bash(heredoc('src/net/client.ts'));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(violations()).toEqual([]);
  });

  it('refuses a new file in scope-out, written by a command that then failed', () => {
    const result = bash(
      'mkdir -p src/net/legacy && printf x > src/net/legacy/old.ts; exit 1',
      'PostToolUseFailure',
    );
    expect(result.status).toBe(2);
    expect(violations().map((v) => [v.path, v.reason])).toEqual([
      ['src/net/legacy/old.ts', 'scope-out'],
    ]);
  });

  it('refuses a deletion and a write into .claude/', () => {
    const result = bash('rm src/cli/index.ts; mkdir .claude && printf x > .claude/settings.json');
    expect(result.status).toBe(2);
    expect(violations().map((v) => [v.path, v.reason])).toEqual([
      ['src/cli/index.ts', 'outside-scope-in'],
      ['.claude/settings.json', 'protected-path'],
    ]);
  });

  it('holds a file dirty before the call against the call only once it changes', () => {
    writeFileSync(join(worktree, 'src/cli/index.ts'), 'dirty before\n');
    expect(bash('echo unrelated').status).toBe(0);
    expect(bash(heredoc('src/cli/index.ts')).status).toBe(2);
    expect(violations()).toHaveLength(1);
  });

  it('compares against nothing when the call has no usable snapshot id', () => {
    writeFileSync(join(worktree, 'src/cli/index.ts'), 'dirty before\n');
    expect(hook('PreToolUse', 'echo hi', 'bad/../id').status).toBe(0);
    const result = hook('PostToolUse', 'echo hi', 'bad/../id');
    expect(result.status).toBe(2);
    expect(violations().map((v) => v.path)).toEqual(['src/cli/index.ts']);
  });

  it('treats a hostile file name as data: never run, and named whole', () => {
    // Relative, so it would land in the hook's cwd, the worktree or the root.
    const name = `-n $(touch pwned) ';x \\ `;
    const result = bash(`printf x > "${name.replace(/[$\\]/g, '\\$&')}"`);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`SCOPE VIOLATION: ${name} (outside-scope-in)`);
    for (const dir of [root, worktree, process.cwd()]) {
      expect(existsSync(join(dir, 'pwned'))).toBe(false);
    }
    expect(violations().map((v) => v.path)).toEqual([name]);
    expect(bash(`printf x > "$(printf 'a\\nb')"`).status).toBe(2);
    expect(violations().map((v) => v.path)).toEqual([name, 'a\u0001b']);
  });

  it('refuses a write made beside a fifo, and never reads the fifo', () => {
    const result = bash(
      "rm src/cli/decoy.ts && mkfifo src/cli/decoy.ts && python3 -c \"open('src/cli/index.ts','w').write('pwned')\"",
    );
    expect(result.status).toBe(2);
    expect(violations().map((v) => v.path)).toContain('src/cli/index.ts');
    // The fifo stays, and the next call is still checked, not hung on it.
    expect(bash('echo later').status).toBe(0);
    expect(bash(heredoc('src/cli/index.ts')).status).toBe(2);
  });

  it('sees a .claude/ write hidden by an exclude rule the command wrote itself', () => {
    // The linked worktree's exclude file is the common dir's, two levels up.
    const result = bash(
      "python3 - <<'EOF'\n" +
        "open('../../.git/info/exclude', 'a').write('\\n.claude/\\n')\n" +
        "import os; os.makedirs('.claude', exist_ok=True)\n" +
        "open('.claude/settings.local.json', 'w').write('{}')\n" +
        'EOF',
    );
    expect(result.status).toBe(2);
    expect(violations().map((v) => [v.path, v.reason])).toEqual([
      ['.claude/settings.local.json', 'protected-path'],
    ]);
  });

  it('re-checks when background output is read, catching a write made after its call', () => {
    expect(bash('echo started in the background').status).toBe(0);
    writeFileSync(join(worktree, 'src/cli/index.ts'), 'written later by the background shell\n');
    const result = run({
      hook_event_name: 'PostToolUse',
      tool_name: 'TaskOutput',
      tool_use_id: 'toolu_02def',
      tool_input: { task_id: 'b1' },
    });
    expect(result.status).toBe(2);
    expect(violations()).toEqual([
      expect.objectContaining({
        path: 'src/cli/index.ts',
        command: 'a read of background output {"task_id":"b1"}',
      }),
    ]);
  });

  it('refuses, without reading them, more dirty paths than it can check in time', () => {
    const result = bash(
      'mkdir src/net/gen && i=0; while [ $i -lt 201 ]; do : > src/net/gen/f$i.ts; i=$((i+1)); done',
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('over 200 dirty paths');
    expect(violations()).toEqual([]);
  });

  it('refuses when git fails or is missing, and never blocks the call before it', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // date, sleep and env bound the hook's reads in time (decision 124).
    for (const tool of [
      ...['jq', 'cat', 'tr', 'grep', 'head', 'mktemp', 'rm', 'mkdir', 'mv', 'wc'],
      ...['date', 'sleep', 'env'],
    ]) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], {
        encoding: 'utf8',
      });
      spawnSync('ln', ['-s', found.stdout.trim(), join(bin, tool)]);
    }
    const missing = { PATH: bin };
    expect(
      run({ hook_event_name: 'PreToolUse', tool_input: { command: 'x' } }, missing).status,
    ).toBe(0);
    const noGit = run({ hook_event_name: 'PostToolUse', tool_input: { command: 'x' } }, missing);
    expect(noGit.status).toBe(2);
    expect(noGit.stderr).toContain('SCOPE CHECK FAILED: could not read git status');
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 128\n', { mode: 0o755 });
    const failing = run({ hook_event_name: 'PostToolUse', tool_input: { command: 'x' } }, missing);
    expect(failing.status).toBe(2);
    expect(failing.stderr).toContain('SCOPE CHECK FAILED: could not read git status');
  });

  // The shared config is the session's to write (decision 41's exposure), and git
  // opens what an include names before it runs any command. The test's timeout
  // sits well past the hook's, so a hook that blocks reads as null; one that
  // ends gave no read longer than the deadline.
  it('refuses within the hook timeout while the repo config includes a fifo', () => {
    const fifo = join(root, 'included');
    spawnSync('mkfifo', [fifo]);
    spawnSync('git', ['config', 'include.path', fifo], {
      cwd: repo,
      env: GIT_ENV,
    });
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const sleeps = recordSleeps(bin);

    const result = run(
      {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'toolu_01fifo',
        tool_input: { command: 'x' },
      },
      { PATH: `${bin}:${process.env.PATH}` },
      15_000,
    );
    expect(result.status).toBe(2);
    expect(sleeps().length).toBeGreaterThan(0);
    expect(Math.max(...sleeps())).toBeLessThanOrEqual(ProfileCompiler.HOOK_READ_DEADLINE_SECONDS);
    expect(result.stderr).toContain('outran the hook deadline');
    expect(result.stderr).toContain('SCOPE CHECK FAILED: could not read git status');
  }, 30_000);

  // git status holds the index's lock, an optional one, through its untracked walk,
  // and a kill skips git's cleanup, so every later index write in the worktree
  // would fail on the lock left behind. A fifo as a .gitignore blocks that walk.
  it('leaves no index lock behind when the deadline kills git status', () => {
    spawnSync('mkfifo', [join(worktree, 'src/net/.gitignore')]);

    const result = run(
      {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'toolu_01lock',
        tool_input: { command: 'x' },
      },
      {},
      15_000,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('outran the hook deadline');
    expect(existsSync(join(repo, '.git/worktrees/s-1/index.lock'))).toBe(false);
  }, 30_000);

  // The swap lands between the regular-file test and the read: a wc on the hook's
  // PATH turns the written file into a fifo, then reads it as the real one.
  it('refuses within the hook timeout a write swapped for a fifo mid-check', () => {
    const written = join(worktree, 'src/cli/index.ts');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const realWc = spawnSync('/bin/sh', ['-c', 'command -v wc'], {
      encoding: 'utf8',
    });
    writeFileSync(
      join(bin, 'wc'),
      `#!/bin/sh\nfor arg; do last=$arg; done\nif [ "$last" = '${written}' ]; then rm -f "$last" && mkfifo "$last"; fi\nexec ${realWc.stdout.trim()} "$@"\n`,
      { mode: 0o755 },
    );
    const sleeps = recordSleeps(bin);
    expect(hook('PreToolUse', 'x', 'toolu_01wc').status).toBe(0);
    writeFileSync(written, 'pwned\n');

    const result = run(
      {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'toolu_01wc',
        tool_input: { command: 'x' },
      },
      { PATH: `${bin}:${process.env.PATH}` },
      15_000,
    );
    expect(lstatSync(written).isFIFO()).toBe(true);
    expect(result.status).toBe(2);
    expect(sleeps().length).toBeGreaterThan(0);
    expect(Math.max(...sleeps())).toBeLessThanOrEqual(ProfileCompiler.HOOK_READ_DEADLINE_SECONDS);
    expect(result.stderr).toContain('SCOPE CHECK FAILED: the check ran out of time');
  }, 30_000);

  // Both snapshots run out before the out-of-scope file that was already dirty, so
  // an unread path fingerprinted alike in each would pass however it changed. A wc
  // that never returns on the path before it stands in for the slow hashing of
  // many large files.
  it('refuses rather than passes a dirty file both checks ran out of time before reading', () => {
    const slow = join(worktree, 'src/cli/decoy.ts');
    const target = join(worktree, 'src/cli/index.ts');
    writeFileSync(slow, 'dirty before the call\n');
    writeFileSync(target, 'dirty before the call\n');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const realWc = spawnSync('/bin/sh', ['-c', 'command -v wc'], {
      encoding: 'utf8',
    });
    const realSleep = spawnSync('/bin/sh', ['-c', 'command -v sleep'], {
      encoding: 'utf8',
    });
    writeFileSync(
      join(bin, 'wc'),
      `#!/bin/sh\nfor arg; do last=$arg; done\nif [ "$last" = '${slow}' ]; then exec ${realSleep.stdout.trim()} 30; fi\nexec ${realWc.stdout.trim()} "$@"\n`,
      { mode: 0o755 },
    );
    const sleeps = recordSleeps(bin);
    const slowed = { PATH: `${bin}:${process.env.PATH}` };
    const payload = (phase: string) => ({
      hook_event_name: phase,
      tool_use_id: 'toolu_01late',
      tool_input: { command: 'x' },
    });

    expect(run(payload('PreToolUse'), slowed, 15_000).status).toBe(0);
    writeFileSync(target, 'changed by the call\n');
    const result = run(payload('PostToolUse'), slowed, 15_000);
    expect(result.status).toBe(2);
    expect(sleeps().length).toBeGreaterThan(0);
    expect(Math.max(...sleeps())).toBeLessThanOrEqual(ProfileCompiler.HOOK_READ_DEADLINE_SECONDS);
    expect(result.stderr).toContain('SCOPE CHECK FAILED: the check ran out of time');
  }, 30_000);

  // The clock is whole seconds, so a read that starts late in the deadline's last
  // second still sleeps that whole second before it is killed. The date on the
  // hook's PATH is a clock that stands at its start until a wc on the first dirty
  // path, too large to hash, turns it to the deadline's last second; a wc on the
  // second never returns. Started within that second and given one more, the
  // read is killed before the second after the deadline ends, a second ahead of
  // the hook timeout, which leaves the refusal that second.
  it('refuses with a second to spare a read that starts as the deadline ends', () => {
    const first = join(worktree, 'src/cli/decoy.ts');
    const target = join(worktree, 'src/cli/index.ts');
    writeFileSync(first, 'dirty before the call\n');
    writeFileSync(target, 'dirty before the call\n');
    const clock = join(root, 'clock');
    const deadline = ProfileCompiler.HOOK_READ_DEADLINE_SECONDS;
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const realWc = spawnSync('/bin/sh', ['-c', 'command -v wc'], {
      encoding: 'utf8',
    });
    const realSleep = spawnSync('/bin/sh', ['-c', 'command -v sleep'], {
      encoding: 'utf8',
    });
    writeFileSync(
      join(bin, 'date'),
      `#!/bin/sh\n[ -f '${clock}' ] || echo 1000 > '${clock}'\nexec cat '${clock}'\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'wc'),
      `#!/bin/sh
for arg; do last=$arg; done
if [ "$last" = '${first}' ]; then
  echo ${1000 + deadline - 1} > '${clock}'
  echo ${RECHECK_HASH_MAX_BYTES + 1}
  exit 0
elif [ "$last" = '${target}' ]; then
  echo ${1000 + deadline} > '${clock}'
  exec ${realSleep.stdout.trim()} 30
fi
exec ${realWc.stdout.trim()} "$@"
`,
      { mode: 0o755 },
    );
    const sleeps = recordSleeps(bin);

    const result = run(
      {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'toolu_01last',
        tool_input: { command: 'x' },
      },
      { PATH: `${bin}:${process.env.PATH}` },
      15_000,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('SCOPE CHECK FAILED: the check ran out of time');
    // Every read before the clock turned had the whole deadline; the last, in its
    // final second, had that second.
    const given = sleeps();
    const last = given.pop();
    expect(given).toEqual(given.map(() => deadline));
    expect(last).toBe(1);
    // Started before second 1000 + deadline, killed before 1000 + deadline + 1.
    expect(deadline + Number(last)).toBeLessThanOrEqual(HOOK_TIMEOUT_SECONDS - 1);
  }, 30_000);

  it('refuses after the call, and never blocks it, when the clock reads as no number', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'date'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const clockless = { PATH: `${bin}:${process.env.PATH}` };
    const payload = (phase: string) => ({
      hook_event_name: phase,
      tool_use_id: 'toolu_01clock',
      tool_input: { command: 'x' },
    });

    expect(run(payload('PreToolUse'), clockless).status).toBe(0);
    const result = run(payload('PostToolUse'), clockless);
    // A shell that exited on the arithmetic would end 1 or 127, which fails open.
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('SCOPE CHECK FAILED');
  });

  it('lets the call run but refuses after it when its scratch dir cannot be made', () => {
    writeFileSync(join(root, 'compiled/bash-snapshots'), 'a file where the directory goes');
    expect(hook('PreToolUse', 'echo hi').status).toBe(0);
    const after = hook('PostToolUse', 'echo hi');
    expect(after.status).toBe(2);
    expect(after.stderr).toContain(
      'SCOPE CHECK FAILED: bash re-check could not make its scratch dir',
    );
  });

  // A session can rewrite its worktree's gitfile and its admin dir's commondir
  // from inside the sandbox, and the hook runs outside it: git that followed
  // either would run a clean filter armed in the repo they name (decision 101).
  describe('over git pointers the session rewrote', () => {
    const IGNORE_NONE = '[submodule "sub"]\n\tpath = src/net/sub\n\tignore = none\n';
    let marker: string;
    const plainGit = (cwd: string, ...args: string[]) =>
      spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });

    beforeEach(() => {
      marker = join(root, 'fired');
    });

    /** A repo holding the worktree's files, with a clean filter armed on every path. */
    function armedRepo(dir: string): string {
      mkdirSync(join(dir, 'src/net'), { recursive: true });
      writeFileSync(join(dir, 'src/net/client.ts'), 'export {};\n');
      plainGit(dir, 'init', '-q');
      plainGit(dir, 'add', '-A');
      plainGit(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'armed');
      plainGit(dir, 'config', 'filter.pwn.clean', `sh -c 'echo pwned >> ${marker}; cat'`);
      writeFileSync(join(dir, '.git/info/attributes'), '* filter=pwn\n');
      return join(dir, '.git');
    }

    /** Proves the plant live with plain git, then makes the file stale again for the hook. */
    function expectPlainGitFires(stale: string): void {
      const later = () => new Date(Date.now() + 60_000);
      utimesSync(stale, later(), later());
      plainGit(worktree, 'status', '--porcelain');
      expect(existsSync(marker)).toBe(true);
      unlinkSync(marker);
      utimesSync(stale, later(), later());
    }

    it.each([
      ['a repointed gitfile', () => [join(worktree, '.git'), 'gitdir: ']],
      ['a rewritten commondir', () => [join(repo, '.git/worktrees/s-1/commondir'), '']],
    ])('refuses after the call over %s, and runs no clean filter', (_, pointer) => {
      const [file, prefix] = pointer() as [string, string];
      writeFileSync(file, `${prefix}${armedRepo(join(root, 'armed'))}\n`);
      expectPlainGitFires(join(worktree, 'src/net/client.ts'));

      const result = bash('echo hi');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`${worktree}/.git or its commondir no longer names`);
      expect(existsSync(marker)).toBe(false);
    });

    it('holds the pins when the gitfile is swapped after the check', () => {
      const gitfile = join(worktree, '.git');
      const trusted = readFileSync(gitfile, 'utf8');
      writeFileSync(gitfile, `gitdir: ${armedRepo(join(root, 'armed'))}\n`);
      expectPlainGitFires(join(worktree, 'src/net/client.ts'));
      // A head that shows the check the trusted gitfile, as a swap between the
      // check and the git call would.
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const realHead = spawnSync('/bin/sh', ['-c', 'command -v head'], {
        encoding: 'utf8',
      });
      writeFileSync(
        join(bin, 'head'),
        `#!/bin/sh\nfor arg; do last=$arg; done\nif [ "$last" = '${gitfile}' ]; then printf '%s' '${trusted.trimEnd()}'; else exec ${realHead.stdout.trim()} "$@"; fi\n`,
        { mode: 0o755 },
      );
      const lied = { PATH: `${bin}:${process.env.PATH}` };
      const payload = (phase: string) => ({
        hook_event_name: phase,
        tool_use_id: 'toolu_01swap',
        tool_input: { command: 'echo hi' },
      });

      expect(run(payload('PreToolUse'), lied).status).toBe(0);
      expect(run(payload('PostToolUse'), lied).status).toBe(0);
      expect(existsSync(marker)).toBe(false);
    });

    it('refuses while git would read the worktree config, and runs no clean filter', () => {
      const worktreeConfig = join(repo, '.git/worktrees/s-1/config.worktree');
      plainGit(
        root,
        'config',
        '--file',
        worktreeConfig,
        'filter.pwn.clean',
        `sh -c 'echo pwned >> ${marker}; cat'`,
      );
      writeFileSync(join(repo, '.git/info/attributes'), '* filter=pwn\n');
      plainGit(
        root,
        'config',
        '--file',
        join(repo, '.git/config'),
        'extensions.worktreeConfig',
        'true',
      );
      expectPlainGitFires(join(worktree, 'src/net/client.ts'));

      const result = bash('echo hi');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`git would read ${repo}/.git/worktrees/s-1/config.worktree`);
      expect(existsSync(marker)).toBe(false);

      // The file alone refuses, and so does the extension alone.
      plainGit(
        root,
        'config',
        '--file',
        join(repo, '.git/config'),
        'extensions.worktreeConfig',
        'false',
      );
      expect(bash('echo hi').status).toBe(2);
      unlinkSync(worktreeConfig);
      plainGit(
        root,
        'config',
        '--file',
        join(repo, '.git/config'),
        'extensions.worktreeConfig',
        'true',
      );
      expect(bash('echo hi').status).toBe(2);
      plainGit(
        root,
        'config',
        '--file',
        join(repo, '.git/config'),
        '--unset',
        'extensions.worktreeConfig',
      );
      expect(bash('echo hi').status).toBe(0);
    });

    it('runs no child git in a gitlink over a .git the session made', () => {
      const sub = join(worktree, 'src/net/sub');
      armedRepo(sub);
      const head = plainGit(sub, 'rev-parse', 'HEAD').stdout.trim();
      plainGit(worktree, 'update-index', '--add', '--cacheinfo', `160000,${head},src/net/sub`);
      expectPlainGitFires(join(sub, 'src/net/client.ts'));

      expect(bash('echo hi').status).toBe(0);
      expect(existsSync(marker)).toBe(false);
    });

    // A per-submodule `ignore` outranks diff.ignoreSubmodules from any config;
    // only the hook's own --ignore-submodules=all beats it.
    it.each([
      ['in the worktree', () => writeFileSync(join(worktree, '.gitmodules'), IGNORE_NONE)],
      [
        'in the index alone',
        () => {
          const blob = join(root, 'gitmodules');
          writeFileSync(blob, IGNORE_NONE);
          const id = plainGit(worktree, 'hash-object', '-w', '--', blob).stdout.trim();
          plainGit(worktree, 'update-index', '--add', '--cacheinfo', `100644,${id},.gitmodules`);
        },
      ],
    ])('runs no child git in a gitlink under a .gitmodules override %s', (_, plant) => {
      const sub = join(worktree, 'src/net/sub');
      armedRepo(sub);
      const head = plainGit(sub, 'rev-parse', 'HEAD').stdout.trim();
      plainGit(worktree, 'update-index', '--add', '--cacheinfo', `160000,${head},src/net/sub`);
      plant();
      const stale = join(sub, 'src/net/client.ts');
      const later = () => new Date(Date.now() + 60_000);
      utimesSync(stale, later(), later());
      plainGit(worktree, '-c', 'diff.ignoreSubmodules=all', 'status', '--porcelain');
      expect(existsSync(marker)).toBe(true);
      unlinkSync(marker);
      utimesSync(stale, later(), later());

      expect(bash('echo hi').status).not.toBeNull();
      expect(existsSync(marker)).toBe(false);
    });
  });

  it('wires the re-check before and after every Bash call, failures included', () => {
    const { hooks } = ProfileCompiler.compileProfile(makeInput()).settings;
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      const bashHooks = (hooks[event] ?? [])
        .filter((e) => e.matcher === 'Bash')
        .flatMap((e) => e.hooks.map((h) => h.command));
      expect(bashHooks.some((c) => c.endsWith('bash-recheck.sh'))).toBe(true);
    }
  });

  it('wires the re-check on reading a background shell or task', () => {
    const { hooks } = ProfileCompiler.compileProfile(makeInput()).settings;
    const entry = (hooks.PostToolUse ?? []).find((e) => e.matcher === 'TaskOutput');
    expect(entry?.hooks.map((h) => h.command)).toEqual([
      '/state/sessions/s-1/compiled/hooks/bash-recheck.sh',
    ]);
  });
});

// Decision 152: a worker hands a broad read to the Explore subagent, pinned to a cheap model.
describe('worker search delegation (decision 152)', () => {
  const settingsOf = (compiled: { files: Record<string, string> }) =>
    JSON.parse(compiled.files['settings.json'] as string);

  it('keeps the Agent tool for a worker and pins its subagents to Haiku at low effort', () => {
    const settings = settingsOf(ProfileCompiler.compileProfile(makeInput()));

    expect(settings.permissions.deny).not.toContain('Agent');
    expect(settings.env).toMatchObject({
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-5-5',
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
      CLAUDE_CODE_SUBAGENT_EFFORT: 'low',
    });
  });

  it('keeps the pin when --session-env names its variables, so the shell cannot override it', () => {
    vi.stubEnv('HOME', tempDir('pup-session-env-home-'));
    try {
      saveSessionEnv('/repo', ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE']);
      const settings = settingsOf(ProfileCompiler.compileProfile(makeInput()));

      expect(settings.env).toMatchObject(WORKER_SUBAGENT_ENV);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("leaves the conductor's deny list and env unpinned", () => {
    const settings = settingsOf(
      ProfileCompiler.compileConductorProfile({
        base: { name: 'base' },
        repoPath: '/repo',
        projectId: 'proj-1',
        conductorName: 'pup-conductor-proj-1',
        userConfigHash: 'user-hash-a',
        outDir: '/state/conductor/compiled',
      }),
    );

    expect(settings.permissions.deny).toEqual(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
    expect(settings.env).toEqual(SLIM_CONTEXT_ENV);
  });

  it('gives the worker kickoff a Searching section within the context budget', () => {
    const compiled = ProfileCompiler.compileProfile(
      makeInput({ base: DEFAULT_BASE_PROFILE, role: undefined }),
    );

    expect(compiled.contextMarkdown).toContain(
      '## Searching\n' +
        'For any where-is-X or how-does-module-Y question, ask an Explore subagent with the ' +
        'Agent tool (`subagent_type: "Explore"`) and keep only its summary; pup pins the model ' +
        'and effort it runs on. Tell it to use only Read, Grep and Glob, to run no git and no ' +
        "other shell command, and to read only this worktree, never another session's under " +
        '`.worktrees/`. Read with the Read tool only the file you are about to edit, for the ' +
        'lines the edit needs. What your own diff changes you read yourself, with git in this ' +
        'worktree.',
    );
    // The settings take the Agent tool's `model` parameter away, so naming one would mislead.
    expect(compiled.contextMarkdown).not.toContain('## Exploring code');
    expect(compiled.contextMarkdown).not.toContain('`model: "sonnet"`');
    expect(compiled.tokenEstimate).toBeLessThanOrEqual(compiled.contextBudget);
  });
});

// Decision 93: a question whose answer is a choice comes with its options and a
// recommendation, so the operator answers it with one key.
describe('the protocol asks with options (decision 93)', () => {
  it('tells the worker to offer options and its recommendation when the answer is a choice', () => {
    const compiled = ProfileCompiler.compileProfile(makeInput());

    expect(compiled.contextMarkdown).toContain(
      'When the answer is a choice, always offer it as options with your recommendation, so ' +
        'the operator answers with one key: `pup session ask "<question>" --option "<answer>" ' +
        '--option "<answer>" --recommend <n>` (up to 4 options; n is the one you would pick).',
    );
    expect(compiled.tokenEstimate).toBeLessThanOrEqual(compiled.contextBudget);
  });
});

describe('the status line records the plan usage (decision 156)', () => {
  const SAMPLE = {
    model: { display_name: 'Opus' },
    context_window: { used_percentage: 12.7 },
    rate_limits: {
      five_hour: {
        used_percentage: 23.5,
        resets_at: 1738425600,
        extra: 'dropped',
      },
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      spend_limit: {
        used_percentage: 62.8,
        resets_at: 1740787200,
        used_usd: 314.12,
      },
    },
  };
  let home: string;
  let outDir: string;

  beforeEach(() => {
    home = tempDir('pup-usage-home-');
    vi.stubEnv('HOME', home);
    outDir = tempDir('pup-statusline-');
    mkdirSync(join(home, '.pupitre'), { recursive: true });
    const compiled = ProfileCompiler.compileProfile(makeInput({ outDir }));
    ProfileCompiler.writeCompiledProfile(compiled, outDir);
    mkdirSync(dirname(usageFile()), { recursive: true });
    return () => vi.unstubAllEnvs();
  });

  const usageFile = (): string => projectPaths('/repo').usageFile;

  function runStatusLine(payload: object): {
    status: number | null;
    stdout: string;
  } {
    const result = spawnSync('/bin/sh', [join(outDir, 'hooks/statusline.sh')], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout };
  }

  it('is the command of the window settings, a compiled path and nothing else', () => {
    const compiled = ProfileCompiler.compileProfile(makeInput({ outDir }));

    expect((compiled.settings as { statusLine?: unknown }).statusLine).toEqual({
      type: 'command',
      command: join(outDir, 'hooks/statusline.sh'),
    });
  });

  it('writes only the two windows used share and reset, and prints one line', () => {
    const { status, stdout } = runStatusLine(SAMPLE);

    expect(status).toBe(0);
    expect(stdout).toBe('ctx 12% | 5h 23% | 7d 41%\n');
    expect(JSON.parse(readFileSync(usageFile(), 'utf8'))).toEqual({
      five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    });
    // Through a temp file and a rename: nothing is left beside the reading.
    expect(readdirSync(dirname(usageFile()))).toEqual(['usage.json']);
  });

  it('leaves the last reading as it was when the JSON has no usable window', () => {
    writeFileSync(usageFile(), '{"five_hour":{"used_percentage":50,"resets_at":1}}\n');

    const { status, stdout } = runStatusLine({
      context_window: { used_percentage: null },
      rate_limits: {
        five_hour: { used_percentage: '$(touch pwned)', resets_at: 1 },
      },
    });

    expect(status).toBe(0);
    expect(stdout).toBe('ctx ? | 7d ?\n');
    expect(readFileSync(usageFile(), 'utf8')).toBe(
      '{"five_hour":{"used_percentage":50,"resets_at":1}}\n',
    );
    expect(existsSync(join(outDir, 'pwned'))).toBe(false);
    expect(existsSync('pwned')).toBe(false);
  });

  it('leaves no temp file behind when a directory is planted as the usage file', () => {
    mkdirSync(usageFile());

    for (let render = 0; render < 3; render++) {
      expect(runStatusLine(SAMPLE).stdout).toBe('ctx 12% | 5h 23% | 7d 41%\n');
    }

    expect(readdirSync(dirname(usageFile()))).toEqual(['usage.json']);
    expect(readdirSync(usageFile())).toEqual([]);
  });

  it('prints no 5h segment when the plan reports no 5-hour window', () => {
    const { rate_limits: limits, ...rest } = SAMPLE;

    expect(runStatusLine({ ...rest, rate_limits: { seven_day: limits.seven_day } }).stdout).toBe(
      'ctx 12% | 7d 41%\n',
    );
  });

  it('writes a window that is present without the one that is absent', () => {
    runStatusLine({ rate_limits: { seven_day: SAMPLE.rate_limits.seven_day } });

    expect(JSON.parse(readFileSync(usageFile(), 'utf8'))).toEqual({
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    });
  });

  it('prints a line and writes nothing from input that is not JSON', () => {
    const result = spawnSync('/bin/sh', [join(outDir, 'hooks/statusline.sh')], {
      input: "'; touch pwned; '",
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ctx ? | 7d ?\n');
    expect(existsSync(usageFile())).toBe(false);
  });

  it('refuses a usage path the script could not quote safely', () => {
    vi.stubEnv('HOME', "/tmp/it's");

    expect(() => ProfileCompiler.compileProfile(makeInput({ outDir }))).toThrow(
      'the usage file contains characters unsafe for a generated hook',
    );
  });

  it('is the conductor window status line too', () => {
    const compiled = ProfileCompiler.compileConductorProfile({
      base: { name: 'base' },
      repoPath: '/repo',
      projectId: 'proj-1',
      conductorName: 'pup-conductor-proj-1',
      userConfigHash: 'user-hash-a',
      outDir,
    });

    expect((compiled.settings as { statusLine?: unknown }).statusLine).toEqual({
      type: 'command',
      command: join(outDir, 'hooks/statusline.sh'),
    });
    expect(compiled.files['hooks/statusline.sh']).toContain(`USAGE='${usageFile()}'`);
  });
});

// Decision 191: Claude Code's Bash sandbox, behind the project's `workerSandbox` setting.
describe('the worker sandbox (decision 191)', () => {
  // The setting refuses outside macOS (ceiling 12), so these compile as on it.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  // The compile reads the user settings.json, so the operator's own never decides a test.
  let home: string;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    home = tempDir('pup-sandbox-home-');
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
  });

  /** A repo directory whose `.pupitre/project.yml` holds `content`, or none when undefined. */
  function repoWith(content?: string): string {
    const repo = tempDir('pup-sandbox-repo-');
    if (content !== undefined) {
      mkdirSync(join(repo, '.pupitre'));
      writeFileSync(join(repo, '.pupitre', 'project.yml'), content);
    }
    return repo;
  }

  function compileIn(repo: string) {
    return ProfileCompiler.compileProfile(
      makeInput({ repoPath: repo, worktreePath: join(repo, '.worktrees', 's-1') }),
    );
  }

  /** The project-config file is the only difference, so `repo` alone names the input. */
  function compiledText(content: string | undefined, file: string): string {
    const repo = repoWith(content);
    const text = compileIn(repo).files[file] as string;
    return text.replaceAll(repo, '<repo>');
  }

  it.each(['settings.json', 'hooks/scope-enforce.sh'])(
    'compiles the same %s bytes as a project without the setting while it is off',
    (file) => {
      const without = compiledText(undefined, file);

      expect(compiledText('workerSandbox: false\n', file)).toBe(without);
      expect(compiledText('skipTestsOnUntestedChanges: false\n', file)).toBe(without);
    },
  );

  it('adds no sandbox block and no cache redirect while it is off', () => {
    const settings = JSON.parse(compiledText(undefined, 'settings.json'));

    expect(settings).not.toHaveProperty('sandbox');
    expect(settings.env).not.toHaveProperty('npm_config_cache');
  });

  it('confines Bash children to the worktree, keeping the store and the main .git config unwritable', () => {
    const repo = repoWith('workerSandbox: true\n');
    const store = projectPaths(repo);
    const { sandbox } = JSON.parse(compileIn(repo).files['settings.json'] as string);

    expect(sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
    const adminDir = join(repo, '.git', 'worktrees', 's-1');
    expect(sandbox.filesystem.allowWrite).toEqual([
      join(repo, '.worktrees', 's-1'),
      adminDir,
      store.dbFile,
      `${store.dbFile}-wal`,
      `${store.dbFile}-shm`,
      store.handoffFile('s-1'),
    ]);
    // A deny wins over any allow, so the store is left out of the grants, not
    // denied: a denied store root would take state.db with it.
    expect(sandbox.filesystem.denyWrite).toEqual(
      [
        join(repo, '.git', 'config'),
        join(repo, '.git', 'config.worktree'),
        join(repo, '.git', 'commondir'),
        join(repo, '.git', 'hooks'),
        join(repo, '.git', 'info'),
        join(repo, '.git', 'modules'),
        join(repo, '.git', 'main'),
        join(repo, '.git', 'refs', 'main'),
        join(repo, '.git', 'refs', 'tags', 'main'),
        join(repo, '.git', 'refs', 'heads', 'main'),
        join(repo, '.git', 'packed-refs'),
        join(repo, '.git', 'refs', 'replace'),
        join(repo, '.git', 'refs', 'remotes'),
        join(repo, '.git', 'shallow'),
        join(repo, '.git', 'HEAD'),
        join(repo, '.git', 'index'),
        join(repo, '.git', 'MERGE_HEAD'),
        join(repo, '.git', 'ORIG_HEAD'),
        join(repo, '.git', 'FETCH_HEAD'),
        join(repo, '.git', 'CHERRY_PICK_HEAD'),
        join(repo, '.git', 'MERGE_AUTOSTASH'),
        join(repo, '.git', 'rebase-merge'),
        join(repo, '.git', 'rebase-apply'),
        join(repo, '.git', 'sequencer'),
        join(adminDir, 'commondir'),
        join(adminDir, 'gitdir'),
        join(adminDir, 'config.worktree'),
      ].flatMap((path) => [path, `${path}.lock`]),
    );
    expect(sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(['~/.ssh', '~/.npmrc']));
    expect(sandbox.network).toEqual({
      allowedDomains: [
        'registry.npmjs.org',
        'registry.yarnpkg.com',
        'pypi.org',
        'files.pythonhosted.org',
      ],
      strictAllowlist: true,
      // No allowUnixSockets: a granted dir lets a sandboxed `mv` carry in
      // another session's socket and connect to it (decision 196).
    });
    // On macOS local binding opens every localhost port to the sandbox; the web
    // dashboard's tests listen on no socket instead (decision 191).
    expect(sandbox.network).not.toHaveProperty('allowLocalBinding');
  });

  // A sandboxed kill(pid, 0) on an unsandboxed pid fails with EPERM (probed), so
  // the slot protocol would reclaim a live gate's slot. Ungranted, `pup session
  // test` cannot write the slots dir and runs slot-less.
  it("leaves the machine's test slots out of the grants", () => {
    const { sandbox } = JSON.parse(
      compileIn(repoWith('workerSandbox: true\n')).files['settings.json'] as string,
    );
    const slots = join(home, '.pupitre', 'slots');

    for (const path of sandbox.filesystem.allowWrite) {
      expect(path === slots || path.startsWith(`${slots}/`)).toBe(false);
    }
  });

  // Claude Code joins the sandbox's lists from every source a worker loads, the
  // operator's user settings included: a `sandbox` key's lists, additional
  // directories and Edit and WebFetch allow rules. No compiled value takes an
  // entry back, and a value the compile cannot check refuses too.
  it.each([
    {
      name: 'a sandbox key',
      content: '{"sandbox":{"excludedCommands":["docker"]}}',
      error: 'its `sandbox` key is refused',
    },
    { name: 'a null sandbox', content: '{"sandbox":null}', error: 'its `sandbox` key is refused' },
    {
      name: 'a sandbox that is not an object',
      content: '{"sandbox":true}',
      error: 'its `sandbox` key is refused',
    },
    {
      name: 'an Edit allow rule',
      content: '{"permissions":{"allow":["Bash(npm test:*)","Edit(/tmp/**)"]}}',
      error: 'rule "Edit(/tmp/**)" is refused',
    },
    {
      name: 'a Write allow rule',
      content: '{"permissions":{"allow":["Write(~/notes/**)"]}}',
      error: 'rule "Write(~/notes/**)" is refused',
    },
    {
      name: 'a WebFetch domain allow rule',
      content: '{"permissions":{"allow":["WebFetch(domain:example.com)"]}}',
      error: 'rule "WebFetch(domain:example.com)" is refused',
    },
    {
      name: 'additional directories',
      content: '{"permissions":{"additionalDirectories":["/tmp"]}}',
      error: 'its `permissions.additionalDirectories` is refused',
    },
    {
      name: 'permissions that are not an object',
      content: '{"permissions":["Edit(/tmp/**)"]}',
      error: 'its `permissions` must be an object',
    },
    {
      name: 'null permissions',
      content: '{"permissions":null}',
      error: 'its `permissions` must be an object',
    },
    {
      name: 'allow rules that are not a list',
      content: '{"permissions":{"allow":"Edit(/tmp/**)"}}',
      error: 'its `permissions.allow` must be a list',
    },
    {
      name: 'an allow rule that is not a string',
      content: '{"permissions":{"allow":[{"Edit":"/tmp/**"}]}}',
      error: 'not a rule string',
    },
    { name: 'a JSON value not an object', content: '[]', error: 'hold a JSON object' },
    { name: 'JSON that does not parse', content: '{"sandbox": ', error: 'read it as JSON' },
  ])('refuses the compile on a user settings.json holding $name', ({ content, error }) => {
    const settingsPath = join(home, '.claude', 'settings.json');
    mkdirSync(dirname(settingsPath));
    writeFileSync(settingsPath, content);
    const compileOn = () => compileIn(repoWith('workerSandbox: true\n'));

    expect(compileOn).toThrow(error);
    expect(compileOn).toThrow(settingsPath);
    expect(compileIn(repoWith('workerSandbox: false\n')).settings).not.toHaveProperty('sandbox');
  });

  it('refuses the compile on a user settings.json it cannot read', () => {
    const settingsPath = join(home, '.claude', 'settings.json');
    mkdirSync(settingsPath, { recursive: true });

    const compileOn = () => compileIn(repoWith('workerSandbox: true\n'));
    expect(compileOn).toThrow('read it as JSON');
    expect(compileOn).toThrow(settingsPath);
  });

  it('refuses an Edit allow rule spelled with whitespace around its tool name', () => {
    const settingsPath = join(home, '.claude', 'settings.json');
    mkdirSync(dirname(settingsPath));
    const repo = repoWith('workerSandbox: true\n');

    for (const rule of [' Edit(x)', 'Edit (x)']) {
      writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [rule] } }));
      expect(() => compileIn(repo)).toThrow(`rule ${JSON.stringify(rule)} is refused`);
    }
  });

  it('compiles the sandbox beside a user settings.json that adds nothing to it, or none', () => {
    const repo = repoWith('workerSandbox: true\n');
    expect(compileIn(repo).settings).toHaveProperty('sandbox');

    mkdirSync(join(home, '.claude'));
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(npm test:*)', 'Read(~/docs/**)'], deny: ['Edit(/etc/**)'] },
      }),
    );
    expect(compileIn(repo).settings).toHaveProperty('sandbox');
  });

  // Claude Code's implicit grant is the main .git except `config`, `hooks` and
  // the other worktrees' `worktrees/` entries. These denies narrow it further,
  // to paths a worker's commit or merge does not write.
  it.each([
    {
      name: "the main checkout's config.worktree, read under extensions.worktreeConfig",
      path: ['config.worktree'],
    },
    { name: 'a commondir, which git would follow to a planted config', path: ['commondir'] },
    { name: "the submodules' git dirs, with their own config and hooks", path: ['modules'] },
    { name: 'replace refs, which swap the object a name resolves to', path: ['refs', 'replace'] },
    { name: 'remote-tracking refs', path: ['refs', 'remotes'] },
    { name: 'the shallow file', path: ['shallow'] },
    { name: "main's lock", path: ['refs', 'heads', 'main.lock'] },
    { name: 'a root-level main, which git tries first for a bare main', path: ['main'] },
    { name: "a root-level main's lock", path: ['main.lock'] },
    { name: 'refs/main, which shadows refs/heads/main', path: ['refs', 'main'] },
    { name: "refs/main's lock", path: ['refs', 'main.lock'] },
    { name: 'a main tag, which shadows refs/heads/main', path: ['refs', 'tags', 'main'] },
    { name: "a main tag's lock", path: ['refs', 'tags', 'main.lock'] },
    { name: "packed-refs' lock", path: ['packed-refs.lock'] },
    { name: "the main checkout's HEAD", path: ['HEAD'] },
    { name: "the main checkout's index", path: ['index'] },
    { name: 'MERGE_HEAD', path: ['MERGE_HEAD'] },
    { name: 'ORIG_HEAD', path: ['ORIG_HEAD'] },
    { name: 'FETCH_HEAD', path: ['FETCH_HEAD'] },
    { name: 'CHERRY_PICK_HEAD', path: ['CHERRY_PICK_HEAD'] },
    {
      name: "MERGE_AUTOSTASH, which the operator's next pull applies to the main checkout",
      path: ['MERGE_AUTOSTASH'],
    },
    { name: 'a rebase todo, whose exec lines run on --continue', path: ['rebase-merge'] },
    { name: 'an am or apply-style rebase', path: ['rebase-apply'] },
    { name: 'a cherry-pick or revert sequence', path: ['sequencer'] },
    { name: "the index lock, which stalls the main checkout's git", path: ['index.lock'] },
    { name: "HEAD's lock", path: ['HEAD.lock'] },
  ])('denies writes to $name in the main .git', ({ path }) => {
    const repo = repoWith('workerSandbox: true\n');
    const { sandbox } = JSON.parse(compileIn(repo).files['settings.json'] as string);

    expect(sandbox.filesystem.denyWrite).toContain(join(repo, '.git', ...path));
    expect(sandbox.filesystem.allowWrite).not.toContain(join(repo, '.git', ...path));
  });

  // Git renames a lock over its file by path, so content a worker puts into a
  // lock the operator's git holds lands in the file (decision 191).
  it('denies the lock of every path it denies', () => {
    const repo = repoWith('workerSandbox: true\n');
    const { sandbox } = JSON.parse(compileIn(repo).files['settings.json'] as string);
    const denied: string[] = sandbox.filesystem.denyWrite;

    expect(denied).toContain(join(repo, '.git', 'config.lock'));
    for (const path of denied.filter((entry) => !entry.endsWith('.lock'))) {
      expect(denied).toContain(`${path}.lock`);
    }
  });

  // The sandbox refuses ~/.npm and ~/.cache; the admin dir is granted and goes with the worktree.
  it('points the package caches into the worktree admin dir the sandbox grants', () => {
    const repo = repoWith('workerSandbox: true\n');
    const settings = JSON.parse(compileIn(repo).files['settings.json'] as string);
    const caches = join(repo, '.git', 'worktrees', 's-1', 'pup-cache');

    expect(settings.env).toMatchObject({
      npm_config_cache: join(caches, 'npm'),
      PIP_CACHE_DIR: join(caches, 'pip'),
      UV_CACHE_DIR: join(caches, 'uv'),
      POETRY_CACHE_DIR: join(caches, 'poetry'),
      YARN_GLOBAL_FOLDER: join(caches, 'yarn'),
    });
    expect(settings.sandbox.filesystem.allowWrite).toContain(
      join(repo, '.git', 'worktrees', 's-1'),
    );
  });

  // Edit and Write run outside the sandbox and would follow a link sandboxed Bash planted.
  it('refuses an Edit or Write through a symlink in the worktree', () => {
    const repo = repoWith('workerSandbox: true\n');
    const worktree = join(repo, '.worktrees', 's-1');
    const outDir = tempDir('pup-sandbox-out-');
    ProfileCompiler.writeCompiledProfile(
      ProfileCompiler.compileProfile(makeInput({ repoPath: repo, worktreePath: worktree, outDir })),
      outDir,
    );
    mkdirSync(join(worktree, 'src', 'net'), { recursive: true });
    symlinkSync(join(repo, '.pupitre', 'project.yml'), join(worktree, 'src', 'net', 'retry.ts'));
    symlinkSync(join(repo, '.pupitre'), join(worktree, 'src', 'net', 'linked'));
    const write = (path: string) =>
      spawnSync('/bin/sh', [join(outDir, 'hooks', 'scope-enforce.sh')], {
        input: JSON.stringify({
          tool_name: 'Write',
          tool_input: { file_path: join(worktree, path) },
        }),
        encoding: 'utf8',
      });

    for (const path of ['src/net/retry.ts', 'src/net/linked/project.yml', 'src//net/./linked']) {
      const result = write(path);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('is a symlink');
    }
    expect(write('src/net/new/file.ts').status).toBe(0);
    // sed strips `./` after an embedded LF, so the walk would test `src/evil\nproject.yml`.
    symlinkSync(join(repo, '.pupitre'), join(worktree, 'src', 'evil\n.'));
    for (const path of ['src/evil\n./project.yml', 'src/net/file.ts\n', 'src/net/a\rb.ts']) {
      const result = write(path);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('control character');
    }
    expect(readFileSync(join(repo, '.pupitre', 'project.yml'), 'utf8')).toBe(
      'workerSandbox: true\n',
    );
  });

  it('keeps the Read tool from the credentials the sandbox keeps from Bash', () => {
    const repo = repoWith('workerSandbox: true\n');
    const settings = JSON.parse(compileIn(repo).files['settings.json'] as string);

    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['Read(~/.ssh)', 'Read(~/.ssh/**)', 'Read(~/.npmrc)']),
    );
    // The login Keychain holds Claude Code's and gh's tokens on macOS.
    expect(settings.sandbox.filesystem.denyRead).toContain('~/Library/Keychains');
    for (const path of settings.sandbox.filesystem.denyRead) {
      expect(settings.permissions.deny).toContain(`Read(${path})`);
    }
  });

  it("denies the Claude credentials of a config dir the project's windows run on", () => {
    const configDir = tempDir('pup-sandbox-config-');
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    const repo = repoWith('workerSandbox: true\n');
    saveSessionEnv(repo, ['CLAUDE_CONFIG_DIR']);
    const settings = JSON.parse(compileIn(repo).files['settings.json'] as string);
    const credentials = join(configDir, '.credentials.json');

    expect(settings.sandbox.filesystem.denyRead).toContain(credentials);
    expect(settings.permissions.deny).toContain(`Read(/${credentials})`);
  });

  it("checks the user settings.json of a config dir the project's windows run on", () => {
    const configDir = tempDir('pup-sandbox-config-');
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    const repo = repoWith('workerSandbox: true\n');
    saveSessionEnv(repo, ['CLAUDE_CONFIG_DIR']);
    writeFileSync(join(configDir, 'settings.json'), '{"sandbox":{}}');

    expect(() => compileIn(repo)).toThrow(join(configDir, 'settings.json'));
  });

  it('refuses the compile on a malformed setting rather than launch unsandboxed', () => {
    expect(() => compileIn(repoWith('workerSandbox: "yes"\n'))).toThrow(/true or false/);
  });
});

describe('the compiled profile is written without following a link (decision 194)', () => {
  const compiled = () => ProfileCompiler.compileProfile(makeInput());

  it('replaces a scope-in.pat swapped for a symlink, and leaves its target alone', () => {
    const outDir = join(tempDir('pup-compiled-'), 'compiled');
    const profile = compiled();
    ProfileCompiler.writeCompiledProfile(profile, outDir);
    const target = join(tempDir('pup-elsewhere-'), 'target');
    writeFileSync(target, 'untouched');
    const pattern = join(outDir, 'hooks', 'scope-in.pat');
    unlinkSync(pattern);
    symlinkSync(target, pattern);

    ProfileCompiler.writeCompiledProfile(profile, outDir);

    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(lstatSync(pattern).isFile()).toBe(true);
    expect(readFileSync(pattern, 'utf8')).toBe(profile.files['hooks/scope-in.pat']);
    // A hook script is still executable after the rewrite.
    expect(lstatSync(join(outDir, 'hooks', 'bash-recheck.sh')).mode & 0o777).toBe(0o755);
  });

  it('does not create a file through a dangling link', () => {
    const outDir = join(tempDir('pup-compiled-'), 'compiled');
    mkdirSync(outDir);
    const target = join(tempDir('pup-elsewhere-'), 'settings.json');
    symlinkSync(target, join(outDir, 'settings.json'));

    ProfileCompiler.writeCompiledProfile(compiled(), outDir);

    expect(existsSync(target)).toBe(false);
    expect(lstatSync(join(outDir, 'settings.json')).isFile()).toBe(true);
  });

  it.each([
    ['the compiled dir', ''],
    ['its hooks dir', 'hooks'],
  ])('refuses %s swapped for a link to another directory', (_, sub) => {
    const outDir = join(tempDir('pup-compiled-'), 'compiled');
    const elsewhere = tempDir('pup-elsewhere-');
    if (sub) mkdirSync(outDir);
    symlinkSync(elsewhere, join(outDir, sub));

    expect(() => ProfileCompiler.writeCompiledProfile(compiled(), outDir)).toThrow(
      'is not a directory: pup does not write a compiled profile through a link.',
    );
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
