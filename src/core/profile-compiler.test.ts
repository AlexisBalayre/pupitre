import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSessionEnv } from '../claude/session-runtime.service.js';
import { makeInput } from '../test/helpers/profile-compiler.mock.js';
import { tempDir } from '../test/temp-dir.mock.js';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import {
  HOOK_TIMEOUT_SECONDS,
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
      makeInput({ repoPath: repo, worktreePath: worktree, eventsFile: events, outDir }),
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

  function hook(phase: string, command: string, id = 'toolu_01abc') {
    return run({ hook_event_name: phase, tool_use_id: id, tool_input: { command } });
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
      const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
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
  // sits well past the hook's, so a hook that blocks reads as slow or null.
  it('refuses within the hook timeout while the repo config includes a fifo', () => {
    const fifo = join(root, 'included');
    spawnSync('mkfifo', [fifo]);
    spawnSync('git', ['config', 'include.path', fifo], { cwd: repo, env: GIT_ENV });

    const started = Date.now();
    const result = run(
      { hook_event_name: 'PostToolUse', tool_use_id: 'toolu_01fifo', tool_input: { command: 'x' } },
      {},
      15_000,
    );
    expect(result.status).toBe(2);
    expect(Date.now() - started).toBeLessThan(HOOK_TIMEOUT_SECONDS * 1000);
    expect(result.stderr).toContain('outran the hook deadline');
    expect(result.stderr).toContain('SCOPE CHECK FAILED: could not read git status');
  }, 30_000);

  // git status holds the index's lock, an optional one, through its untracked walk,
  // and a kill skips git's cleanup, so every later index write in the worktree
  // would fail on the lock left behind. A fifo as a .gitignore blocks that walk.
  it('leaves no index lock behind when the deadline kills git status', () => {
    spawnSync('mkfifo', [join(worktree, 'src/net/.gitignore')]);

    const result = run(
      { hook_event_name: 'PostToolUse', tool_use_id: 'toolu_01lock', tool_input: { command: 'x' } },
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
    const realWc = spawnSync('/bin/sh', ['-c', 'command -v wc'], { encoding: 'utf8' });
    writeFileSync(
      join(bin, 'wc'),
      `#!/bin/sh\nfor arg; do last=$arg; done\nif [ "$last" = '${written}' ]; then rm -f "$last" && mkfifo "$last"; fi\nexec ${realWc.stdout.trim()} "$@"\n`,
      { mode: 0o755 },
    );
    expect(hook('PreToolUse', 'x', 'toolu_01wc').status).toBe(0);
    writeFileSync(written, 'pwned\n');

    const started = Date.now();
    const result = run(
      { hook_event_name: 'PostToolUse', tool_use_id: 'toolu_01wc', tool_input: { command: 'x' } },
      { PATH: `${bin}:${process.env.PATH}` },
      15_000,
    );
    expect(lstatSync(written).isFIFO()).toBe(true);
    expect(result.status).toBe(2);
    expect(Date.now() - started).toBeLessThan(HOOK_TIMEOUT_SECONDS * 1000);
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
    const realWc = spawnSync('/bin/sh', ['-c', 'command -v wc'], { encoding: 'utf8' });
    const realSleep = spawnSync('/bin/sh', ['-c', 'command -v sleep'], { encoding: 'utf8' });
    writeFileSync(
      join(bin, 'wc'),
      `#!/bin/sh\nfor arg; do last=$arg; done\nif [ "$last" = '${slow}' ]; then exec ${realSleep.stdout.trim()} 30; fi\nexec ${realWc.stdout.trim()} "$@"\n`,
      { mode: 0o755 },
    );
    const slowed = { PATH: `${bin}:${process.env.PATH}` };
    const payload = (phase: string) => ({
      hook_event_name: phase,
      tool_use_id: 'toolu_01late',
      tool_input: { command: 'x' },
    });

    expect(run(payload('PreToolUse'), slowed, 15_000).status).toBe(0);
    writeFileSync(target, 'changed by the call\n');
    const started = Date.now();
    const result = run(payload('PostToolUse'), slowed, 15_000);
    expect(result.status).toBe(2);
    expect(Date.now() - started).toBeLessThan(HOOK_TIMEOUT_SECONDS * 1000);
    expect(result.stderr).toContain('SCOPE CHECK FAILED: the check ran out of time');
  }, 30_000);

  // The clock is whole seconds, so a read that starts late in the deadline's last
  // second still sleeps that whole second before it is killed. The date on the
  // hook's PATH is a clock whose seconds turn as the hook records its deadline; a
  // wc on the first dirty path returns just before the last of them ends, and one
  // on the second never returns. Killed a second ahead of the hook timeout, the
  // read leaves the refusal most of that second.
  it('refuses with a second to spare a read that starts as the deadline ends', () => {
    const slow = join(worktree, 'src/cli/decoy.ts');
    const target = join(worktree, 'src/cli/index.ts');
    writeFileSync(slow, 'dirty before the call\n');
    writeFileSync(target, 'dirty before the call\n');
    const clock = join(root, 'clock');
    const deadline = ProfileCompiler.HOOK_READ_DEADLINE_SECONDS;
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const realWc = spawnSync('/bin/sh', ['-c', 'command -v wc'], { encoding: 'utf8' });
    const realSleep = spawnSync('/bin/sh', ['-c', 'command -v sleep'], { encoding: 'utf8' });
    writeFileSync(
      join(bin, 'date'),
      `#!/bin/sh\n[ -f '${clock}' ] || echo 1000 > '${clock}'\nexec cat '${clock}'\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'wc'),
      `#!/bin/sh
for arg; do last=$arg; done
if [ "$last" = '${slow}' ]; then
  python3 -c 'import os, sys, time; time.sleep(max(0, os.stat(sys.argv[1]).st_mtime + float(sys.argv[2]) - time.time()))' '${clock}' ${deadline - 0.3}
  echo ${1000 + deadline - 1} > '${clock}'
elif [ "$last" = '${target}' ]; then
  echo ${1000 + deadline} > '${clock}'
  exec ${realSleep.stdout.trim()} 30
fi
exec ${realWc.stdout.trim()} "$@"
`,
      { mode: 0o755 },
    );

    const started = Date.now();
    const result = run(
      { hook_event_name: 'PostToolUse', tool_use_id: 'toolu_01last', tool_input: { command: 'x' } },
      { PATH: `${bin}:${process.env.PATH}` },
      15_000,
    );
    expect(result.status).toBe(2);
    expect(Date.now() - started).toBeLessThan(HOOK_TIMEOUT_SECONDS * 1000 - 500);
    expect(result.stderr).toContain('SCOPE CHECK FAILED: the check ran out of time');
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
      const realHead = spawnSync('/bin/sh', ['-c', 'command -v head'], { encoding: 'utf8' });
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
    expect(settings.env).toEqual({
      ...SLIM_CONTEXT_ENV,
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

      expect(settings.env).toEqual({ ...SLIM_CONTEXT_ENV, ...WORKER_SUBAGENT_ENV });
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
        checkoutPath: '/state/conductor/checkout',
        maxSessions: 4,
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
