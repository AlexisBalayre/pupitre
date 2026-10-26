import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCustomAdapter } from '../adapters/custom.adapter.js';
import { tempDir } from '../test/temp-dir.mock.js';
import { BRIEF_MAX_CHARS, BRIEF_TEMPLATE, briefPath } from './brief.service.js';
import { ContextBudgetExceededError, InvalidProfileError } from './profile.errors.js';
import * as ProfileCompiler from './profile-compiler.service.js';
import type { CompileInput, SessionId, TaskId, TaskSpec } from './types/profile.types.js';

const task: TaskSpec = {
  id: 'task-1' as TaskId,
  goal: 'Add retry logic to the fetch client',
  scopeIn: ['src/net/**', 'src/net/index.ts'],
  scopeOut: ['src/net/legacy/**'],
  acceptance: ['retries three times with backoff', 'unit tests cover the retry path'],
};

function makeInput(overrides: Partial<CompileInput> = {}): CompileInput {
  return {
    base: {
      name: 'base',
      conventions: 'correct > simple > readable > fast',
      subagents: ['reviewer'],
    },
    role: { name: 'backend', skills: ['api-testing'], subagents: ['test-runner'] },
    task,
    sessionId: 's-1' as SessionId,
    repoPath: '/repo',
    worktreePath: '/repo/.worktrees/s-1',
    eventsFile: '/tmp/events.jsonl',
    userConfigHash: 'user-hash-a',
    outDir: '/state/sessions/s-1/compiled',
    ...overrides,
  };
}

function runHook(
  script: string,
  payload: object,
  overrides: Partial<CompileInput> = {},
): { status: number | null; stderr: string } {
  const dir = tempDir('pup-hook-');
  // The generated scope hook references sidecar files by their outDir path, so
  // outDir must be the dir the hook actually runs from.
  const compiled = ProfileCompiler.compileProfile(makeInput({ outDir: dir, ...overrides }));
  ProfileCompiler.writeCompiledProfile(compiled, dir);
  const result = spawnSync('sh', [join(dir, script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

describe('compileProfile', () => {
  it('merges base and role layers (union, base first)', () => {
    const compiled = ProfileCompiler.compileProfile(makeInput());
    expect(compiled.contextMarkdown).toContain('correct > simple > readable > fast');
    expect(compiled.contextMarkdown).toContain('pup session done');
    expect(compiled.contextMarkdown).toContain('Add retry logic');
  });

  it('refuses to compile past the context budget', () => {
    const input = makeInput({ role: { name: 'backend', contextBudget: 50 } });
    expect(() => ProfileCompiler.compileProfile(input)).toThrow(ContextBudgetExceededError);
  });

  /**
   * The refusal fires in `parseProfileLayer`, before `compileProfile` runs at
   * all: the parser is the only place a compiled budget can be trusted to be a
   * number. Kept as the regression that was checked red against the old parser.
   */
  it('refuses through compileProfile a base layer whose contextBudget is a string', () => {
    const compile = () =>
      ProfileCompiler.compileProfile(
        makeInput({
          base: ProfileCompiler.parseProfileLayer('name: base\ncontextBudget: nine\n'),
          role: undefined,
        }),
      );
    expect(compile).toThrow(InvalidProfileError);
  });

  it('produces a stable hash that changes with content and user config', () => {
    const a = ProfileCompiler.compileProfile(makeInput());
    const b = ProfileCompiler.compileProfile(makeInput());
    const c = ProfileCompiler.compileProfile(makeInput({ userConfigHash: 'user-hash-b' }));
    const d = ProfileCompiler.compileProfile(
      makeInput({ task: { ...task, goal: 'Different goal' } }),
    );
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(a.hash).not.toBe(d.hash);
  });

  it('wires scope, bash-guard, and event hooks into settings', () => {
    const compiled = ProfileCompiler.compileProfile(makeInput());
    const preToolUse = compiled.settings.hooks.PreToolUse ?? [];
    expect(preToolUse.map((e) => e.matcher)).toEqual(['Edit|Write', 'Bash']);
    for (const event of ['PostToolUse', 'Stop', 'Notification']) {
      expect(compiled.settings.hooks[event]?.[0]?.hooks[0]?.command).toContain('event-log.sh');
    }
  });

  // Decision 94: a worker's full suite competes with the gate's for the CPU,
  // and the gate runs the full suite anyway; decision 96 queues every run.
  it('tells the session to run related tests through `pup session test` only', () => {
    const compiled = ProfileCompiler.compileProfile(makeInput());

    expect(compiled.contextMarkdown).toContain(
      '- Run tests only with `pup session test <test files>`: it runs the project’s test ' +
        'command on the files you name once one of the machine’s test slots is free, and says ' +
        'whom it is waiting for. Running the test runner directly is refused. Name only the ' +
        'tests related to what you changed: the test files for the code you touched and for ' +
        'the code that imports it. Leave the full suite to the merge gate, which runs it.',
    );
  });

  // Decision 103: a turn ended on a background pre-commit or suite read as
  // idle, and a quarter of the conductor's idle notices were that.
  it('orders commits, the pre-commit hook and suites in the foreground, and no turn ending on one', () => {
    const compiled = ProfileCompiler.compileProfile(makeInput());

    expect(compiled.contextMarkdown).toContain(
      '- Run commits, the pre-commit hook they trigger and `pup session test` in the ' +
        'foreground, never with `run_in_background`',
    );
    expect(compiled.contextMarkdown).toContain(
      'Never end a turn while a background job of your own is still running',
    );
  });

  // Decision 74: a selector or a plan approval leaves the pane without an
  // input box, so no steer reaches it. The tools are denied, and the protocol
  // names the one way to ask instead (decision 76).
  it('denies the tools that open a screen pup cannot answer', () => {
    const compiled = ProfileCompiler.compileProfile(makeInput());

    const settings = JSON.parse(compiled.files['settings.json'] as string);
    expect(settings.permissions.deny).toEqual(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
    expect(compiled.contextMarkdown).toContain(
      '- If you are blocked on something only a human can decide, run ' +
        '`pup session ask "<question>"` and end your turn; a steer answers it. ' +
        'pup cannot answer a selector or a plan approval.',
    );
  });

  // Decision 99: workers share files, so every worker is told how to share them
  // — peers can join after its launch, so the rules hold with no Peers section.
  it('gives every worker the collaboration protocol, peers or not', () => {
    const compiled = ProfileCompiler.compileProfile(makeInput());

    expect(compiled.contextMarkdown).not.toContain('## Peers');
    expect(compiled.contextMarkdown).toContain(
      'Before editing a shared file, message the peer what you will change ' +
        '(the function or section) and agree who does what. If you change a shared signature or ' +
        'contract, tell the peer at once. When you are blocked on a peer, say so with ' +
        '`pup session ask` rather than waiting silently.',
    );
  });

  describe('peers (decision 99)', () => {
    const files = Array.from({ length: 22 }, (_, i) => `src/net/f${String(i).padStart(2, '0')}.ts`);

    it('lists each peer by name, above the protocol, capping its files with a count', () => {
      const context = ProfileCompiler.compileProfile({
        ...makeInput(),
        peers: [
          { name: 'pup-s-2', files: ['src/net/index.ts'] },
          { name: 'pup-s-3', files },
        ],
      }).contextMarkdown;

      expect(context).toContain('- `pup-s-2` shares: src/net/index.ts\n');
      expect(context).toContain(`- \`pup-s-3\` shares: ${files.slice(0, 20).join(', ')} +2 more`);
      expect(context.indexOf('## Peers')).toBeLessThan(context.indexOf('## Session protocol'));
    });

    // A broad task such as the audit sweep overlaps every live session, and an
    // overlapping launch is never refused, so the list must fit the budget.
    it('lists at most eight peers and counts the rest, so many broad peers still fit the budget', () => {
      const peers = Array.from({ length: 40 }, (_, i) => ({ name: `pup-s-${i}`, files }));

      const compiled = ProfileCompiler.compileProfile({ ...makeInput(), peers });

      expect(compiled.contextMarkdown).toContain('- `pup-s-7` shares:');
      expect(compiled.contextMarkdown).not.toContain('`pup-s-8`');
      expect(compiled.contextMarkdown).toContain(
        '- +32 more sessions share your files; ListAgents names them.',
      );
    });

    it('is part of the hash, like every other compiled fact', () => {
      const alone = ProfileCompiler.compileProfile(makeInput());
      const shared = ProfileCompiler.compileProfile({
        ...makeInput(),
        peers: [{ name: 'pup-s-2', files: ['src/net/index.ts'] }],
      });

      expect(shared.hash).not.toBe(alone.hash);
    });

    it("names the newcomer and the shared files in a peer's steer, scrubbed", () => {
      expect(
        ProfileCompiler.peerJoinedMessage({ name: 'pup-s\u001b-2', files: ['a\nb.ts', 'c.ts'] }),
      ).toBe(
        'A new peer session, pup-s -2, was just launched on files you also hold: a b.ts, c.ts. ' +
          'Before you edit one of them, message it by SendMessage what you will change ' +
          '(the function or section) and agree who does what.',
      );
    });

    it('scrubs the landed name, the target and the files in the take-main-in steer', () => {
      const message = ProfileCompiler.mainLandedMessage({
        name: 'pup-s\u001b-2',
        target: 'ma\u0007in',
        files: ['a\u009b2J.ts'],
        openPullRequest: false,
      });

      expect(message).toContain('pup-s -2 just landed on ma in, changing files');
      expect(message).toContain('a 2J.ts');
      expect(message).toContain("`git rebase 'refs/heads/ma in'`");
    });

    it('quotes a target the shell would read as more than a ref', () => {
      const message = ProfileCompiler.mainLandedMessage({
        name: 'pup-s-2',
        target: 'main;touch pwned',
        files: ['a.ts'],
        openPullRequest: true,
      });

      expect(message).toContain("`git merge 'refs/heads/main;touch pwned'`");
    });
  });

  // Decision 77: a layer adds denials after decision 74's and never removes one.
  describe('layer denials', () => {
    const denyOf = (input: CompileInput) =>
      JSON.parse(ProfileCompiler.compileProfile(input).files['settings.json'] as string).permissions
        .deny;

    it('appends a parsed layer deny after the unanswerable tools', () => {
      const role = ProfileCompiler.parseProfileLayer('name: copiste\ndeny: [Agent]\n');

      expect(denyOf(makeInput({ role }))).toEqual([
        'AskUserQuestion',
        'EnterPlanMode',
        'ExitPlanMode',
        'Agent',
      ]);
    });

    it("unions a child layer's deny with its parent's", () => {
      const input = makeInput({
        base: { name: 'base', deny: ['Agent'] },
        role: { name: 'copiste', deny: ['WebFetch', 'Agent'] },
      });

      expect(denyOf(input)).toEqual([
        'AskUserQuestion',
        'EnterPlanMode',
        'ExitPlanMode',
        'Agent',
        'WebFetch',
      ]);
    });

    it('keeps a base-only deny when no role is given', () => {
      const input = makeInput({ base: { name: 'base', deny: ['Agent'] }, role: undefined });

      expect(denyOf(input)).toEqual(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Agent']);
    });

    it('does not duplicate a denial the layer repeats', () => {
      const input = makeInput({ role: { name: 'copiste', deny: ['AskUserQuestion', 'Agent'] } });

      expect(denyOf(input)).toEqual(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Agent']);
    });
  });
});

describe('compileProfile with a code graph (decision 51)', () => {
  const withGraph = makeInput({ codegraphBinary: '/opt/node/bin/codegraph' });

  it('compiles an mcp.json naming the binary and pinned to the session worktree', () => {
    const compiled = ProfileCompiler.compileProfile(withGraph);

    const config = JSON.parse(compiled.files['mcp.json'] as string);
    expect(config.mcpServers.codegraph.command).toBe('/opt/node/bin/codegraph');
    expect(config.mcpServers.codegraph.args).toContain('/repo/.worktrees/s-1');
  });

  it('tells the session what the graph answers and to reach for it before reading files', () => {
    const compiled = ProfileCompiler.compileProfile(withGraph);

    expect(compiled.contextMarkdown).toContain('## Code graph');
    expect(compiled.contextMarkdown).toContain('codegraph_explore');
    // Which checkout the graph is of is the one thing a wrong answer turns into
    // a plausible lie, so the session and the conductor are told different
    // first sentences over the same tool description.
    expect(compiled.contextMarkdown).toContain('This worktree is indexed');
    expect(compiled.contextMarkdown).not.toContain('The main checkout is indexed');
  });

  it('compiles neither the file nor the section when the operator has no binary', () => {
    const compiled = ProfileCompiler.compileProfile(makeInput());

    expect(compiled.files['mcp.json']).toBeUndefined();
    expect(compiled.contextMarkdown).not.toContain('## Code graph');
  });

  // Which binary serves the graph is as much of the session's environment as
  // its hooks are, so it belongs inside the hash the session records.
  it('changes the profile hash, because the graph is part of the profile', () => {
    expect(ProfileCompiler.compileProfile(withGraph).hash).not.toBe(
      ProfileCompiler.compileProfile(makeInput()).hash,
    );
  });
});

describe('generated scope hook', () => {
  const worktree = '/repo/.worktrees/s-1';

  it('allows edits inside scope-in', () => {
    const { status } = runHook('hooks/scope-enforce.sh', {
      tool_input: { file_path: `${worktree}/src/net/retry.service.ts` },
    });
    expect(status).toBe(0);
  });

  it('blocks edits outside scope-in', () => {
    const { status, stderr } = runHook('hooks/scope-enforce.sh', {
      tool_input: { file_path: `${worktree}/src/cli/index.ts` },
    });
    expect(status).toBe(2);
    expect(stderr).toContain('outside this task');
  });

  it('blocks scope-out even when nested under scope-in', () => {
    const { status, stderr } = runHook('hooks/scope-enforce.sh', {
      tool_input: { file_path: `${worktree}/src/net/legacy/old.service.ts` },
    });
    expect(status).toBe(2);
    expect(stderr).toContain('scope-out');
  });

  it('blocks .claude/ and paths outside the worktree', () => {
    const inClaude = runHook('hooks/scope-enforce.sh', {
      tool_input: { file_path: `${worktree}/.claude/settings.json` },
    });
    expect(inClaude.status).toBe(2);
    const outside = runHook('hooks/scope-enforce.sh', {
      tool_input: { file_path: '/etc/hosts' },
    });
    expect(outside.status).toBe(2);
  });
});

describe('generated bash guard', () => {
  it('blocks shell writes into .claude/', () => {
    const { status } = runHook('hooks/bash-guard.sh', {
      tool_input: { command: 'echo "{}" > .claude/settings.json' },
    });
    expect(status).toBe(2);
  });

  it('allows reads of .claude/ and unrelated commands', () => {
    expect(
      runHook('hooks/bash-guard.sh', { tool_input: { command: 'cat .claude/settings.json' } })
        .status,
    ).toBe(0);
    expect(runHook('hooks/bash-guard.sh', { tool_input: { command: 'pnpm test' } }).status).toBe(0);
  });
});

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
  function run(payload: object, env: NodeJS.ProcessEnv = {}) {
    return spawnSync('/bin/sh', [join(root, 'compiled/hooks/bash-recheck.sh')], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 4_000,
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
    for (const tool of ['jq', 'cat', 'tr', 'grep', 'head', 'mktemp', 'rm', 'mkdir', 'mv', 'wc']) {
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

// Decision 99: a worker takes main in by merging it, with real git in a linked
// worktree, as a session's is.
describe('generated hooks over a merge of the target', () => {
  const GIT_ENV: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  let root: string;
  let repo: string;
  let worktree: string;
  let events: string;

  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });

  function commit(cwd: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'change');
  }

  /**
   * main and a session branch forked from it, each committing its own files on
   * top, and the session's profile compiled for its worktree. Both change
   * `src/net/client.ts`, in scope, so `git merge main` stops on a conflict with
   * main's other files staged beside it.
   */
  function fork(branchFiles: Record<string, string>, mainFiles: Record<string, string>): void {
    commit(worktree, { 'src/net/client.ts': 'branch\n', ...branchFiles });
    commit(repo, { 'src/net/client.ts': 'main\n', ...mainFiles });
    const outDir = join(root, 'compiled');
    const compiled = ProfileCompiler.compileProfile(
      makeInput({ repoPath: repo, worktreePath: worktree, eventsFile: events, outDir }),
    );
    ProfileCompiler.writeCompiledProfile(compiled, outDir);
  }

  beforeEach(() => {
    root = tempDir('pup-merge-hooks-');
    repo = join(root, 'repo');
    worktree = join(repo, '.worktrees', 's-1');
    events = join(root, 'events.jsonl');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
    commit(repo, {
      '.gitignore': '.worktrees/\n',
      'src/net/client.ts': 'base\n',
      'src/cli/index.ts': 'base\n',
      'src/cli/decoy.ts': 'one\ntwo\n',
    });
    git(repo, 'worktree', 'add', '-q', '-b', 'pup/s-1', worktree, 'main');
  });

  function runScript(script: string, payload: object) {
    return spawnSync('/bin/sh', [join(root, 'compiled/hooks', script)], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 4_000,
      env: { ...GIT_ENV, PUP_SESSION_ID: 's-1' },
    });
  }

  /** The Bash call as Claude Code runs it: the pre hook, the command, the post hook. */
  function bash(command: string) {
    const payload = (phase: string) => ({
      hook_event_name: phase,
      tool_use_id: 'toolu_01merge',
      tool_input: { command },
    });
    expect(runScript('bash-recheck.sh', payload('PreToolUse')).status).toBe(0);
    spawnSync('sh', ['-c', command], { cwd: worktree, env: GIT_ENV });
    return runScript('bash-recheck.sh', payload('PostToolUse'));
  }

  function edit(path: string, oldString: string, newString: string, tool = 'Edit') {
    return runScript('scope-enforce.sh', {
      tool_name: tool,
      tool_input: {
        file_path: join(worktree, path),
        ...(tool === 'Edit'
          ? { old_string: oldString, new_string: newString }
          : { content: newString }),
      },
    });
  }

  function violations(): string[] {
    if (!existsSync(events)) return [];
    return readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, string>)
      .filter((event) => event.type === 'scope_violation')
      .map((event) => `${event.path} ${event.reason}`);
  }

  it("passes a merge of main whose conflicts stop it with main's out-of-scope files staged", () => {
    fork({}, { 'src/cli/index.ts': 'main\n', 'src/net/legacy/old.ts': 'main\n' });

    const merge = bash('git merge main');

    // What the re-check reads: main's files staged, out of scope, mid-merge.
    expect(git(worktree, 'status', '--porcelain').stdout).toContain('M  src/cli/index.ts');
    expect(merge.stderr).toBe('');
    expect(merge.status).toBe(0);
    expect(violations()).toEqual([]);
    expect(edit('src/net/client.ts', 'branch', 'resolved').status).toBe(0);
    expect(
      bash('printf "resolved\\n" > src/net/client.ts && git add -A && git commit -q --no-edit')
        .status,
    ).toBe(0);
    expect(violations()).toEqual([]);
  });

  it('still refuses a write to an out-of-scope file once main is merged in', () => {
    fork({}, { 'src/cli/index.ts': 'main\n' });
    bash('git merge main');

    expect(edit('src/cli/index.ts', 'main', 'evil').status).toBe(2);
    expect(edit('src/cli/index.ts', 'main', 'evil', 'Write').status).toBe(2);
    expect(bash('printf "evil\\n" > src/cli/index.ts').status).toBe(2);
    expect(violations()).toEqual(['src/cli/index.ts outside-scope-in']);
  });

  it('reads the merged tip through no replace ref a session planted', () => {
    fork({}, { 'src/cli/index.ts': 'main\n' });
    bash('git merge main');
    // A commit like the tip but holding the session's own index.ts, swapped in
    // for the tip by `git replace` in the shared ref store.
    const evilIndex = join(root, 'evil-index');
    spawnSync(
      'sh',
      [
        '-c',
        'b=$(printf "evil\\n" | git hash-object -w --stdin) && ' +
          `GIT_INDEX_FILE='${evilIndex}' git read-tree main && ` +
          `GIT_INDEX_FILE='${evilIndex}' git update-index --cacheinfo 100644,$b,src/cli/index.ts && ` +
          `t=$(GIT_INDEX_FILE='${evilIndex}' git write-tree) && ` +
          'git replace "$(git rev-parse main)" "$(git commit-tree "$t" -p main~1 -m e)"',
      ],
      { cwd: repo, env: GIT_ENV },
    );
    expect(git(repo, 'cat-file', '-p', 'main:src/cli/index.ts').stdout).toBe('evil\n');

    expect(bash('printf "evil\\n" > src/cli/index.ts').status).toBe(2);
    expect(violations()).toEqual(['src/cli/index.ts outside-scope-in']);
  });

  it('refuses an Edit over marker lines whose conflict was staged by hand', () => {
    const markers = '<<<<<<< a\nkeep\n=======\ngate()\n>>>>>>> b';
    fork({ 'src/cli/decoy.ts': `${markers}\n` }, { 'src/cli/index.ts': 'main\n' });
    // No merge ran: MERGE_HEAD is written by hand and the file given all three
    // stages at the blob it already holds.
    spawnSync(
      'sh',
      [
        '-c',
        'git rev-parse main > "$(git rev-parse --git-path MERGE_HEAD)" && ' +
          'b=$(git rev-parse HEAD:src/cli/decoy.ts) && ' +
          'printf "0 0000000000000000000000000000000000000000\\tsrc/cli/decoy.ts\\n' +
          '100644 $b 1\\tsrc/cli/decoy.ts\\n100644 $b 2\\tsrc/cli/decoy.ts\\n' +
          '100644 $b 3\\tsrc/cli/decoy.ts\\n" | git update-index --index-info',
      ],
      { cwd: worktree, env: GIT_ENV },
    );
    expect(git(worktree, 'ls-files', '-u').stdout.trim().split('\n')).toHaveLength(3);

    expect(edit('src/cli/decoy.ts', markers, 'keep').status).toBe(2);
  });

  it('allows resolving a conflict main left in a scope-out file, and nothing else there', () => {
    fork({ 'src/net/legacy/old.ts': 'branch\n' }, { 'src/net/legacy/old.ts': 'main\n' });
    bash('git merge main');
    const conflict = '<<<<<<< HEAD\nbranch\n=======\nmain\n>>>>>>> main';

    expect(edit('src/net/legacy/old.ts', conflict, 'main').status).toBe(0);
    expect(edit('src/net/legacy/old.ts', conflict, 'other').status).toBe(2);
  });

  it('reads no MERGE_HEAD a worktree planted in the shared refs', () => {
    fork({}, { 'src/cli/index.ts': 'main\n' });
    // No merge runs here; any worktree can write a ref by that name.
    git(repo, 'update-ref', 'refs/heads/MERGE_HEAD', 'main');
    git(repo, 'tag', 'MERGE_HEAD', 'main');

    expect(bash('printf "main\\n" > src/cli/index.ts').status).toBe(2);
    expect(violations()).toEqual(['src/cli/index.ts outside-scope-in']);
  });

  it('allows one whole block only, never a span of blocks and the code between', () => {
    const lines = (tag: string) => `a ${tag}\nx1\nx2\nx3\nx4\nx5\nx6\nx7\nb ${tag}\n`;
    fork({ 'src/cli/decoy.ts': lines('branch') }, { 'src/cli/decoy.ts': lines('main') });
    bash('git merge main');
    const text = readFileSync(join(worktree, 'src/cli/decoy.ts'), 'utf8');
    expect(text.match(/^<<<<<<< /gm)).toHaveLength(2);
    const span = text.slice(text.indexOf('<<<<<<<'));

    expect(edit('src/cli/decoy.ts', span, 'a main\n').status).toBe(2);
    expect(edit('src/cli/decoy.ts', span, '').status).toBe(2);
    expect(edit('src/cli/decoy.ts', span.slice(0, span.indexOf('x1')), 'a main\n').status).toBe(0);
  });

  it('reads a marker line ending in a CR as a marker', () => {
    fork(
      { 'src/cli/decoy.ts': 'one branch\r\ntwo\r\n' },
      { 'src/cli/decoy.ts': 'one main\r\ntwo\r\n' },
    );
    bash('git merge main');
    const text = readFileSync(join(worktree, 'src/cli/decoy.ts'), 'utf8');
    const crlfBlock = text.slice(0, text.indexOf('two'));
    expect(crlfBlock).toContain('one main\r\n');
    // A side carrying a separator of its own, typed with a CR.
    const forged = crlfBlock.replace('one main\r\n', 'one main\r\n=======\r\n');

    expect(edit('src/cli/decoy.ts', crlfBlock, 'one main\r\n').status).toBe(0);
    expect(edit('src/cli/decoy.ts', crlfBlock, 'one main\r\n=======\r\n').status).toBe(2);
    expect(edit('src/cli/decoy.ts', forged, 'one main\r\n=======\r\n').status).toBe(2);
  });

  describe('a conflict main left in an out-of-scope file', () => {
    const block = '<<<<<<< HEAD\none branch\n=======\none main\n>>>>>>> main';

    beforeEach(() => {
      fork({ 'src/cli/decoy.ts': 'one branch\ntwo\n' }, { 'src/cli/decoy.ts': 'one main\ntwo\n' });
    });

    it('allows an Edit that keeps one side, the other, or ours then theirs', () => {
      bash('git merge main');
      expect(readFileSync(join(worktree, 'src/cli/decoy.ts'), 'utf8')).toContain(block);

      expect(edit('src/cli/decoy.ts', block, 'one main').status).toBe(0);
      expect(edit('src/cli/decoy.ts', block, 'one branch').status).toBe(0);
      expect(edit('src/cli/decoy.ts', block, 'one branch\none main').status).toBe(0);
      expect(edit('src/cli/decoy.ts', `${block}\n`, 'one main\n').status).toBe(0);
    });

    it('refuses an Edit that writes a line of its own, reorders, leaves a marker, or is a Write', () => {
      bash('git merge main');

      expect(edit('src/cli/decoy.ts', block, 'one main\nevil()').status).toBe(2);
      expect(edit('src/cli/decoy.ts', block, 'one main\none branch').status).toBe(2);
      expect(edit('src/cli/decoy.ts', block, 'one main\none main').status).toBe(2);
      expect(edit('src/cli/decoy.ts', block, 'one main\n=======').status).toBe(2);
      // Without its final newline, an emptied block would leave a blank line.
      expect(edit('src/cli/decoy.ts', block, '').status).toBe(2);
      expect(edit('src/cli/decoy.ts', `${block}\n`, 'one main').status).toBe(2);
      expect(edit('src/cli/decoy.ts', 'two', 'two').status).toBe(2);
      expect(edit('src/cli/decoy.ts', block, 'one main', 'Write').status).toBe(2);
    });

    it('reads no further than an object id into a MERGE_HEAD the session grew', () => {
      bash('git merge main');
      const headFile = git(
        worktree,
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'MERGE_HEAD',
      ).stdout.trim();
      writeFileSync(headFile, '');
      truncateSync(headFile, 2 ** 31);

      expect(edit('src/cli/decoy.ts', block, 'one main').status).toBe(2);
      expect(bash('printf "evil\\n" > src/cli/index.ts').status).toBe(2);
    });

    // The hook runs outside the sandbox, the gitfile is writable inside it, and
    // git that followed it would read another repo's config (decision 101).
    it('refuses the resolving Edit once the gitfile names another repo', () => {
      bash('git merge main');
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      git(elsewhere, 'init', '-q');
      writeFileSync(join(worktree, '.git'), `gitdir: ${join(elsewhere, '.git')}\n`);

      const result = edit('src/cli/decoy.ts', block, 'one main');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('or its commondir no longer names');
    });

    // Ten hook runs and two merges, each hook with its pointer check: well past
    // vitest's default under a full parallel run.
    it('refuses the same Edit once the file is resolved, or over a merge of anything but the tip', () => {
      bash('git merge main');
      bash('git add src/cli/decoy.ts');
      expect(edit('src/cli/decoy.ts', block, 'one main').status).toBe(2);

      bash('git merge --abort');
      git(repo, 'branch', 'side', 'main');
      commit(repo, { 'src/net/other.ts': 'moved on\n' });
      bash('git merge side');
      expect(readFileSync(join(worktree, 'src/cli/decoy.ts'), 'utf8')).toContain('<<<<<<< HEAD');
      expect(
        edit('src/cli/decoy.ts', block.replace('>>>>>>> main', '>>>>>>> side'), 'one main').status,
      ).toBe(2);
    }, 20_000);
  });
});

describe('injection safety', () => {
  const worktree = '/repo/.worktrees/s-1';

  it('does not execute shell when a scope glob contains quotes and a command', () => {
    const canary = join(realpathSync(tmpdir()), `pup-canary-${process.pid}`);
    const evilTask: TaskSpec = {
      ...task,
      scopeIn: [`x'; touch ${canary}; :'`, 'src/net/**'],
      scopeOut: [`y'; touch ${canary}; :'`],
    };
    const { status } = runHook(
      'hooks/scope-enforce.sh',
      { tool_input: { file_path: `${worktree}/src/net/ok.service.ts` } },
      { task: evilTask },
    );
    expect(status).toBe(0);
    expect(existsSync(canary)).toBe(false);
  });

  it('rejects a worktree path with shell metacharacters at compile time', () => {
    expect(() =>
      ProfileCompiler.compileProfile(makeInput({ worktreePath: '/repo/$(touch /tmp/x)' })),
    ).toThrow(InvalidProfileError);
  });

  it('rejects an empty scope-in rather than compiling an allow-all hook', () => {
    expect(() =>
      ProfileCompiler.compileProfile(makeInput({ task: { ...task, scopeIn: ['', '  '] } })),
    ).toThrow(InvalidProfileError);
  });

  it('keeps the security PreToolUse hooks when a layer supplies its own', () => {
    const compiled = ProfileCompiler.compileProfile(
      makeInput({
        base: {
          name: 'base',
          hooks: {
            PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'evil.sh' }] }],
          },
        },
        role: undefined,
      }),
    );
    const commands = (compiled.settings.hooks.PreToolUse ?? []).flatMap((e) =>
      e.hooks.map((h) => h.command),
    );
    expect(commands.some((c) => c.includes('scope-enforce.sh'))).toBe(true);
    expect(commands.some((c) => c.includes('bash-guard.sh'))).toBe(true);
    expect(commands).toContain('evil.sh');
    expect(commands[0]).toContain('scope-enforce.sh');
  });

  it('blocks .claude/ despite case and repeated ./ prefixing', () => {
    for (const path of [
      `${worktree}/.Claude/settings.json`,
      `${worktree}/./.claude/x`,
      `${worktree}/././.claude/x`,
      `${worktree}/./foo/.././.claude/x`,
    ]) {
      expect(runHook('hooks/scope-enforce.sh', { tool_input: { file_path: path } }).status).toBe(2);
    }
  });

  it('denies parent-directory traversal even with a broad scope-in', () => {
    const { status } = runHook(
      'hooks/scope-enforce.sh',
      { tool_input: { file_path: `${worktree}/../../etc/passwd` } },
      { task: { ...task, scopeIn: ['**'] } },
    );
    expect(status).toBe(2);
  });
});

describe('parseProfileLayer', () => {
  it('parses a valid layer', () => {
    const layer = ProfileCompiler.parseProfileLayer(
      'name: backend\nextends: base\nskills: [api-testing]\ncontext_budget: 6000\n',
    );
    expect(layer.name).toBe('backend');
    expect(layer.skills).toEqual(['api-testing']);
  });

  it('rejects a layer without a name or with non-list fields', () => {
    expect(() => ProfileCompiler.parseProfileLayer('extends: base\n')).toThrow(InvalidProfileError);
    expect(() => ProfileCompiler.parseProfileLayer('name: x\nskills: nope\n')).toThrow(
      InvalidProfileError,
    );
  });

  it('parses a layer that sets both typed fields', () => {
    const layer = ProfileCompiler.parseProfileLayer(
      'name: backend\nextends: base\ncontextBudget: 8000\n',
    );
    expect(layer).toEqual({ name: 'backend', extends: 'base', contextBudget: 8000 });
  });

  it.each(['nine', '"8000"', '8000.5', '-1', '0', '[8000]', '{n: 1}'])(
    'refuses contextBudget: %s',
    (value) => {
      expect(() =>
        ProfileCompiler.parseProfileLayer(`name: backend\ncontextBudget: ${value}\n`),
      ).toThrow(/Profile field `contextBudget` must be a positive integer\./);
    },
  );

  it('parses a layer deny list', () => {
    expect(ProfileCompiler.parseProfileLayer('name: copiste\ndeny: [Agent, WebFetch]\n')).toEqual({
      name: 'copiste',
      deny: ['Agent', 'WebFetch'],
    });
  });

  it.each(['Agent', '""', '{tool: Agent}', '[Agent, 5]', '[Agent, null]', '[[Agent]]', '[""]'])(
    'refuses deny: %s',
    (value) => {
      expect(() => ProfileCompiler.parseProfileLayer(`name: copiste\ndeny: ${value}\n`)).toThrow(
        /Profile field `deny` must be a list of tool names\./,
      );
    },
  );

  it.each(['5', '[base]', '{name: base}', '""'])('refuses extends: %s', (value) => {
    expect(() => ProfileCompiler.parseProfileLayer(`name: backend\nextends: ${value}\n`)).toThrow(
      /Profile field `extends` must be a non-empty string\./,
    );
  });
});

/**
 * The operator's brief reaches the two windows differently on purpose: a
 * session is given Destination and Constraints, and the conductor is given the
 * file whole because deciding what comes first is its job (decision 57).
 */
describe('the project brief in a compiled context', () => {
  const BRIEF =
    '<!-- free Markdown -->\n\n' +
    '## Destination\nA control plane the operator trusts.\n\n' +
    '## Constraints\nNo new dependencies without approval.\n\n' +
    '## Priorities\n1. Close the gate bypasses.\n';

  const conductorInput = {
    base: { name: 'base' },
    repoPath: '/repo',
    projectId: 'proj-1',
    conductorName: 'pup-conductor-proj-1',
    userConfigHash: 'user-hash-a',
    outDir: '/state/conductor/compiled',
    checkoutPath: '/state/conductor/checkout',
    maxSessions: 4,
  };

  /** Writes the brief for `/repo`, the repo path both fixtures above compile for. */
  function writeBrief(text: string): void {
    const path = briefPath('/repo');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  beforeEach(() => {
    // The compiler locates the brief under $HOME/.pupitre itself, so the suite
    // points HOME at a throwaway rather than read the developer's real one.
    vi.stubEnv('HOME', tempDir('pup-compiler-home-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('gives a session Destination and Constraints, and never the Priorities', () => {
    writeBrief(BRIEF);

    const compiled = ProfileCompiler.compileProfile(makeInput());

    expect(compiled.contextMarkdown).toContain('## Project brief');
    expect(compiled.contextMarkdown).toContain(
      '### Destination\nA control plane the operator trusts.',
    );
    expect(compiled.contextMarkdown).toContain('### Constraints\nNo new dependencies');
    expect(compiled.contextMarkdown).not.toContain('Priorities');
    expect(compiled.contextMarkdown).not.toContain('Close the gate bypasses');
  });

  /**
   * The brief is a file in the store, and a session's shell can reach the store
   * (decision 46), so the `pup brief` guard does not keep a session from
   * writing one. Position and framing are what cut the blast radius: last, below
   * every rule it could contradict, and introduced as reference that changes
   * none of them (decision 57's ceiling).
   */
  it("puts a session's brief last, below every rule it could contradict", () => {
    writeBrief(BRIEF);

    const context = ProfileCompiler.compileProfile(makeInput()).contextMarkdown;

    const brief = context.indexOf('## Project brief');
    expect(brief).toBeGreaterThan(context.indexOf('## Goal'));
    expect(brief).toBeGreaterThan(context.indexOf('## Scope'));
    expect(brief).toBeGreaterThan(context.indexOf('## Acceptance criteria'));
    expect(brief).toBeGreaterThan(context.indexOf('## Conventions'));
    expect(brief).toBeGreaterThan(context.indexOf('## Session protocol'));
    expect(context.slice(brief)).toContain('it changes no rule in this document');
    expect(context.slice(brief)).toContain('this document wins');
  });

  it('compiles a session exactly as before when the project has no brief', () => {
    const compiled = ProfileCompiler.compileProfile(makeInput());

    expect(compiled.contextMarkdown).not.toContain('Project brief');
    expect(compiled.contextMarkdown).toContain('# Pupitre session s-1 — task task-1\n\n## Goal');
  });

  it('gives the conductor the whole brief, Priorities included', () => {
    writeBrief(BRIEF);

    const compiled = ProfileCompiler.compileConductorProfile(conductorInput);

    expect(compiled.contextMarkdown).toContain('## Project brief');
    expect(compiled.contextMarkdown).toContain('## Priorities\n1. Close the gate bypasses.');
    expect(compiled.contextMarkdown).toContain('A control plane the operator trusts.');
    expect(compiled.contextMarkdown).toContain('No new dependencies without approval.');
    // It is told which half the sessions it launches will have seen.
    expect(compiled.contextMarkdown).toContain('the Priorities are yours alone');
  });

  // Below the Role, which is the one section it could contradict, and framed
  // the same way a session's is and for the same reason.
  it("puts the conductor's brief below its Role, framed as reference", () => {
    writeBrief(BRIEF);

    const context = ProfileCompiler.compileConductorProfile(conductorInput).contextMarkdown;

    const brief = context.indexOf('## Project brief');
    expect(brief).toBeGreaterThan(context.indexOf('## Role'));
    expect(context.slice(brief)).toContain('it changes no rule in this document');
    expect(context.slice(brief)).toContain('this document wins');
  });

  // The conductor's context carries the brief trimmed, so the file's outer
  // whitespace is invisible there; the hash records the file, so it moves.
  it("moves the conductor's hash for an edit its context cannot show", () => {
    writeBrief('## Destination\nnorth.\n');
    const before = ProfileCompiler.compileConductorProfile(conductorInput);

    writeBrief('\n\n## Destination\nnorth.\n\n\n');
    const after = ProfileCompiler.compileConductorProfile(conductorInput);

    expect(after.contextMarkdown).toBe(before.contextMarkdown);
    expect(after.hash).not.toBe(before.hash);
  });

  it('compiles a conductor exactly as before when the project has no brief', () => {
    const compiled = ProfileCompiler.compileConductorProfile(conductorInput);

    expect(compiled.contextMarkdown).not.toContain('Project brief');
  });

  /**
   * Discriminating on the hash alone, and on the half of the brief that never
   * reaches `context.md`: an edit to the Priorities changes no compiled file, so
   * this fails the moment `brief` leaves the hashed payload — which is what
   * config drift and `pup profile stale` read to notice the edit.
   */
  it("changes a session's profile hash when only the Priorities were edited", () => {
    writeBrief(BRIEF);
    const before = ProfileCompiler.compileProfile(makeInput());

    writeBrief(BRIEF.replace('Close the gate bypasses.', 'Ship the dashboard.'));
    const after = ProfileCompiler.compileProfile(makeInput());

    expect(after.contextMarkdown).toBe(before.contextMarkdown);
    expect(after.files).toEqual(before.files);
    expect(after.hash).not.toBe(before.hash);
  });

  it('leaves the hash of a project with no brief where it was', () => {
    const none = ProfileCompiler.compileProfile(makeInput());

    writeBrief(BRIEF);

    expect(ProfileCompiler.compileProfile(makeInput()).hash).not.toBe(none.hash);
  });

  // A brief saved on its untouched template carries nothing into the context
  // and still moves the hash: the file is there now, and the hash records the
  // file. Documented, so the difference is not read as a bug.
  it('moves the hash for a brief still on its template, with no section', () => {
    const none = ProfileCompiler.compileProfile(makeInput());

    writeBrief(BRIEF_TEMPLATE);
    const templated = ProfileCompiler.compileProfile(makeInput());

    expect(templated.contextMarkdown).toBe(none.contextMarkdown);
    expect(templated.hash).not.toBe(none.hash);
  });

  // The cap refuses in the compiler's own error type, so every launch path can
  // answer it in one line instead of crashing (decision 57).
  it('refuses to compile a brief over the cap, naming the brief', () => {
    writeBrief(`## Destination\n${'x'.repeat(BRIEF_MAX_CHARS)}\n`);

    expect(() => ProfileCompiler.compileProfile(makeInput())).toThrow(InvalidProfileError);
    expect(() => ProfileCompiler.compileProfile(makeInput())).toThrow('brief');
    expect(() => ProfileCompiler.compileConductorProfile(conductorInput)).toThrow(
      InvalidProfileError,
    );
  });
});

describe('compileConductorProfile', () => {
  const conductorInput = {
    base: { name: 'base', conventions: 'correct > simple > readable > fast' },
    repoPath: '/repo',
    projectId: 'proj-1',
    conductorName: 'pup-conductor-proj-1',
    workerModel: 'opus',
    userConfigHash: 'user-hash-a',
    outDir: '/state/conductor/compiled',
    checkoutPath: '/state/conductor/checkout',
    maxSessions: 4,
  };

  function runConductorHook(script: string, payload: object): number | null {
    const dir = tempDir('pup-conductor-hook-');
    const compiled = ProfileCompiler.compileConductorProfile({ ...conductorInput, outDir: dir });
    ProfileCompiler.writeCompiledProfile(compiled, dir);
    return spawnSync('sh', [join(dir, script)], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
    }).status;
  }

  // Decision 99 retired decision 41's refusal, so the conductor launches
  // overlapping tasks rather than narrowing them; decision 96 only has it fill
  // free places with tasks that share nothing first.
  it('launches overlapping tasks, with no wait-or-re-scope rule', () => {
    const context = ProfileCompiler.compileConductorProfile(conductorInput).contextMarkdown;

    expect(context).toContain(
      'Scopes may overlap: pup names each worker the live sessions sharing its files, and they ' +
        'agree between themselves who changes what.',
    );
    expect(context).toContain(
      'Launch one that shares other files only once every planned task does',
    );
    for (const retired of ['--allow-overlap', 're-scope', 'disjoint', 'refused overlap']) {
      expect(context).not.toContain(retired);
    }
  });

  // The context is the operator's loop written down: what the conductor may
  // run, how it reaches a session by peer name, and that the merge itself is
  // not its to make (decision 47).
  it('tells the conductor its name, the worker model, the peer protocol and what it is refused', () => {
    const compiled = ProfileCompiler.compileConductorProfile(conductorInput);

    expect(compiled.contextMarkdown).toContain('conductor pup-conductor-proj-1');
    expect(compiled.contextMarkdown).toContain('pup launch <task> --model opus');
    expect(compiled.contextMarkdown).toContain('SendMessage');
    expect(compiled.contextMarkdown).toContain('notify_when_idle');
    expect(compiled.contextMarkdown).toContain('pup steer <session-id> --sent');
    expect(compiled.contextMarkdown).toContain(
      'Refused to you: `pup merge` without `--pr`, `pup respawn`',
    );
    expect(compiled.contextMarkdown).toContain('correct > simple > readable > fast');
    expect(compiled.contextMarkdown).not.toContain('pup session done "<one-line summary>"');
  });

  // Decision 75: `--pr` never moves main, so the conductor gates every finished
  // branch with it. `pup merge` takes a session id, which is not the task id
  // after a relaunch.
  it('lets the conductor gate with pup merge --pr and nothing else of the merge', () => {
    const compiled = ProfileCompiler.compileConductorProfile(conductorInput);

    expect(compiled.contextMarkdown).toContain(
      'When a session is `awaiting-review` and meets its acceptance criteria (step 3 ' +
        'otherwise), run `pup merge <session-id> --pr`',
    );
    expect(compiled.contextMarkdown).toContain('a human merges the pull request, never you.');
    expect(compiled.contextMarkdown).not.toContain('pup merge <task>');
    expect(compiled.contextMarkdown).toContain('- Never run `pup merge` without `--pr`:');
    expect(compiled.contextMarkdown).toContain(
      '- Never pass `--accept-debt` without `--approved-by <who>`',
    );
    expect(compiled.contextMarkdown).toContain('`--approved-by` never names you.');
    expect(compiled.contextMarkdown).toContain('- Never pass `--approved-by human`');
    expect(compiled.contextMarkdown).toContain(
      '5. When every session you launched is gated into a pull request, killed or blocked',
    );
    expect(compiled.contextMarkdown).toContain(
      '4. Never edit, commit or push from this checkout. Never run `pup merge` without `--pr`.',
    );
    expect(compiled.contextMarkdown).not.toContain('Never run `pup merge`.');
  });

  // Decision 88: the gate waits for the lock and the load itself, so the
  // conductor's own wait loops and lock hand-offs with the operator go.
  it('has the conductor leave the lock and load waits to pup merge and pup land', () => {
    const context = ProfileCompiler.compileConductorProfile(conductorInput).contextMarkdown;

    expect(context).toContain('Never loop on the load average before running them');
    expect(context).toContain('never ask the operator to release the merge lock');
    expect(context).toContain(
      'report that refusal to the operator as it stands, and never delete the lock.',
    );
  });

  it('launches on the default model when no worker model is set', () => {
    const compiled = ProfileCompiler.compileConductorProfile({
      ...conductorInput,
      workerModel: undefined,
    });

    expect(compiled.contextMarkdown).toContain('`pup launch <task>`');
    expect(compiled.contextMarkdown).not.toContain('--model');
    expect(compiled.contextMarkdown).toContain(
      'Launch with plain `pup launch <task>`, naming no model or effort',
    );
  });

  // Decision 92: the conductor launches into the routing rather than around
  // it, and owes a critical branch a security review before it gates it.
  it('names the tier rule, both ladders and the xhigh security-review subagent', () => {
    const context = ProfileCompiler.compileConductorProfile(conductorInput).contextMarkdown;

    expect(context).toContain('## Models');
    expect(context).toContain(
      'A task is critical when a scope-in glob touches any of `src/core/merge-gate*`, ',
    );
    for (const area of ['src/claude/**', '.claude/hooks/**', '.github/**', 'src/core/git*']) {
      expect(context).toContain(`\`${area}\``);
    }
    expect(context).toContain(
      'standard: claude-sonnet-5-5 medium → claude-sonnet-5-5 high → claude-opus-5-5 high → ' +
        'claude-opus-5-5 xhigh; critical: claude-opus-5-5 high → claude-opus-5-5 xhigh',
    );
    expect(context).toContain('`pup plan add|edit --tier critical|standard`');
    expect(context).toContain('A launch refused at the top rung of its ladder');
    expect(context).toContain(
      'before `pup merge <session-id> --pr` on a session whose diff touches the gate, git, ' +
        'tmux or the store',
    );
    expect(context).toContain('Agent tool at `effort: "xhigh"`');
    expect(context).toContain(
      '`GIT_NO_LAZY_FETCH=1 git --no-replace-objects -C .worktrees/<session-id> ' +
        '-c core.useReplaceRefs=false -c core.fsmonitor= -c core.hooksPath=/dev/null ' +
        '-c protocol.ext.allow=never -c protocol.fd.allow=never -c protocol.file.allow=never ' +
        '-c protocol.git.allow=never -c protocol.http.allow=never -c protocol.https.allow=never ' +
        '-c protocol.ssh.allow=never --no-pager diff --no-ext-diff --no-textconv --no-color --text ' +
        '--ignore-submodules=none --no-relative refs/heads/<target>...refs/heads/pup/<session-id>`',
    );
    expect(context).toContain('which never lifts the top-rung refusal');
    expect(context).toContain("The operator fixed every session's model to opus");
    expect(context).not.toMatch(/fable/i);
  });

  it('wires an edit block and the bash guard, and no scope or event hooks', () => {
    const compiled = ProfileCompiler.compileConductorProfile(conductorInput);

    const preToolUse = compiled.settings.hooks.PreToolUse ?? [];
    expect(preToolUse.map((e) => e.matcher)).toEqual(['Edit|Write', 'Bash']);
    expect(preToolUse[0]?.hooks[0]?.command).toContain('edit-block.sh');
    expect(preToolUse[1]?.hooks[0]?.command).toContain('bash-guard.sh');
    expect(Object.keys(compiled.settings.hooks)).toEqual(['PreToolUse']);
    expect(Object.keys(compiled.files).sort()).toEqual([
      'context.md',
      'hooks/bash-guard.sh',
      'hooks/edit-block.sh',
      'settings.json',
    ]);
  });

  it('denies the tools that open a screen pup cannot answer (decision 74)', () => {
    const compiled = ProfileCompiler.compileConductorProfile(conductorInput);

    const settings = JSON.parse(compiled.files['settings.json'] as string);
    expect(settings.permissions.deny).toEqual(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
  });

  // The conductor's graph is main's, pinned the way a session's is pinned to
  // its worktree and recorded in its profile hash for the same reason
  // (decision 51).
  describe('with a code graph', () => {
    const withGraph = { ...conductorInput, codegraphBinary: '/opt/node/bin/codegraph' };

    // The private checkout, never `repoPath`: a live working tree carries
    // untracked files and a session-writable `codegraph.json`, and the conductor
    // is the last reader that should be fed either.
    it('pins the served graph at the private checkout and never at the live repo', () => {
      const compiled = ProfileCompiler.compileConductorProfile(withGraph);

      const config = JSON.parse(compiled.files['mcp.json'] as string);
      expect(config.mcpServers.codegraph.command).toBe('/opt/node/bin/codegraph');
      expect(config.mcpServers.codegraph.args).toContain('/state/conductor/checkout');
      expect(config.mcpServers.codegraph.args).not.toContain('/repo');
    });

    // It is told the graph is a snapshot of a pristine copy, not the tree it
    // sits in: an answer out of one checkout believed to be about another is
    // the failure this whole decision is shaped around.
    it('tells the conductor its graph is a pristine snapshot of the merge target', () => {
      const compiled = ProfileCompiler.compileConductorProfile(withGraph);

      expect(compiled.contextMarkdown).toContain('## Code graph');
      expect(compiled.contextMarkdown).toContain('codegraph_explore');
      expect(compiled.contextMarkdown).toContain('A pristine copy of the merge target');
      expect(compiled.contextMarkdown).toContain('not the working tree you sit in');
      expect(compiled.contextMarkdown).not.toContain('This worktree is indexed');
    });

    it('compiles neither the file nor the section when the operator has no binary', () => {
      const compiled = ProfileCompiler.compileConductorProfile(conductorInput);

      expect(compiled.files['mcp.json']).toBeUndefined();
      expect(compiled.contextMarkdown).not.toContain('## Code graph');
    });

    it('changes the profile hash, because the graph is part of the profile', () => {
      expect(ProfileCompiler.compileConductorProfile(withGraph).hash).not.toBe(
        ProfileCompiler.compileConductorProfile(conductorInput).hash,
      );
    });
  });

  it('blocks every edit, whatever the path', () => {
    expect(
      runConductorHook('hooks/edit-block.sh', { tool_input: { file_path: '/repo/src/a.ts' } }),
    ).toBe(2);
  });

  it('still blocks shell writes into .claude/', () => {
    expect(
      runConductorHook('hooks/bash-guard.sh', {
        tool_input: { command: 'echo "{}" > .claude/settings.json' },
      }),
    ).toBe(2);
    expect(runConductorHook('hooks/bash-guard.sh', { tool_input: { command: 'pup status' } })).toBe(
      0,
    );
  });

  it('rejects a repo path with shell metacharacters at compile time', () => {
    expect(() =>
      ProfileCompiler.compileConductorProfile({ ...conductorInput, repoPath: "/repo'; touch /x" }),
    ).toThrow(InvalidProfileError);
  });

  it('refuses to compile past the context budget', () => {
    expect(() =>
      ProfileCompiler.compileConductorProfile({
        ...conductorInput,
        base: { name: 'base', conventions: 'x'.repeat(40_000), contextBudget: 100 },
      }),
    ).toThrow(ContextBudgetExceededError);
  });
});

describe('test runs queue for a slot (decision 96)', () => {
  const guard = (command: string, overrides: Partial<CompileInput> = {}) =>
    runHook('hooks/test-guard.sh', { tool_input: { command } }, overrides);

  it.each([
    'pnpm test',
    'pnpm run test src/core/a.test.ts',
    'pnpm test:watch',
    'npm test',
    'yarn test',
    'vitest',
    'vitest related src/core/a.ts',
    'pnpm vitest run',
    'pnpm exec vitest run src/core/a.test.ts',
    'npx vitest run',
    'npx jest',
    './node_modules/.bin/vitest run',
    'cd src && vitest run',
    'git stash list; pnpm test',
    'CI=1 vitest run',
    'env CI=1 npx vitest',
    'echo $(vitest run)',
  ])('refuses `%s`, naming pup session test', (command) => {
    const { status, stderr } = guard(command);

    expect(status).toBe(2);
    expect(stderr).toContain('pup session test');
  });

  it.each([
    'pup session test src/core/a.test.ts',
    'node "$PUP_BIN" session test src/core/a.test.ts',
    'cat vitest.config.ts',
    'grep -n vitest package.json',
    'pnpm run build',
    'pnpm biome check src',
    'git log --oneline',
  ])('lets `%s` through', (command) => {
    expect(guard(command).status).toBe(0);
  });

  it("refuses the adapter's own test command, its words matched as words", () => {
    const testCommand = { stage: 'test' as const, command: 'uv', args: ['run', 'pytest'] };

    expect(guard('uv run pytest -k slots', { testCommand } as Partial<CompileInput>).status).toBe(
      2,
    );
    expect(guard('uv run pytest', { testCommand } as Partial<CompileInput>).status).toBe(2);
    expect(guard('uv run pytester', { testCommand } as Partial<CompileInput>).status).toBe(0);
    expect(guard('uv run ruff check', { testCommand } as Partial<CompileInput>).status).toBe(0);
  });

  it('escapes the adapter command, so its punctuation is matched literally', () => {
    const testCommand = { stage: 'test' as const, command: 'make', args: ['test.unit'] };

    expect(guard('make test.unit', { testCommand } as Partial<CompileInput>).status).toBe(2);
    expect(guard('make testXunit', { testCommand } as Partial<CompileInput>).status).toBe(0);
  });

  it('leaves out an adapter command holding a line break rather than refuse every call', () => {
    const testCommand = { stage: 'test' as const, command: 'make', args: ['\n'] };

    expect(guard('git status', { testCommand } as Partial<CompileInput>).status).toBe(0);
    expect(guard('pnpm test', { testCommand } as Partial<CompileInput>).status).toBe(2);
  });

  describe("a custom adapter's sh -c script", () => {
    /** The compile input of a project whose `.pupitre/adapter.yml` declares `test: <script>`. */
    function customTest(script: string): Partial<CompileInput> {
      const repo = tempDir('pup-custom-');
      mkdirSync(join(repo, '.pupitre'));
      // JSON is YAML, and keeps the script's quotes and line breaks intact.
      writeFileSync(join(repo, '.pupitre', 'adapter.yml'), JSON.stringify({ test: script }));
      const testCommand = loadCustomAdapter(repo)
        ?.gateCommands(repo)
        .find((command) => command.stage === 'test');
      return { testCommand } as Partial<CompileInput>;
    }

    it("refuses the script's words run directly, less the files it takes", () => {
      const overrides = customTest('go test ./... "$@"');

      expect(guard('go test ./...', overrides).status).toBe(2);
      expect(guard('go test ./... -run TestSlots 2>&1 | tail -20', overrides).status).toBe(2);
      expect(guard('cd pkg && go test ./...', overrides).status).toBe(2);
      expect(guard('go test ./...;echo', overrides).status).toBe(2);
      expect(guard('go test ./...|tail', overrides).status).toBe(2);
      expect(guard('go vet ./...', overrides).status).toBe(0);
      expect(guard('pup session test ./pkg', overrides).status).toBe(0);
    });

    it('refuses a one-word script only bare, so its other uses go through', () => {
      const overrides = customTest('make');

      expect(guard('make', overrides).status).toBe(2);
      expect(guard('make 2>&1 | tail -20', overrides).status).toBe(2);
      expect(guard('git status && make', overrides).status).toBe(2);
      expect(guard('make build', overrides).status).toBe(0);
      expect(guard('makefile-lint', overrides).status).toBe(0);
    });

    it.each([
      'go vet ./... && go test ./...',
      'pytest -m "not slow"',
      'cargo test $CARGO_FLAGS',
      '"$@"',
      '   ',
      'go test\n./...',
    ])('leaves out %j, more than plain words, rather than refuse every call', (script) => {
      const overrides = customTest(script);

      expect(guard('git status', overrides).status).toBe(0);
      expect(guard('pnpm test', overrides).status).toBe(2);
    });
  });

  it('runs the guard on every Bash call, beside the .claude/ guard', () => {
    const compiled = ProfileCompiler.compileProfile(makeInput());
    const bash = compiled.settings.hooks.PreToolUse?.find((entry) => entry.matcher === 'Bash');

    expect(bash?.hooks.map((hook) => hook.command.split('/').at(-1))).toContain('test-guard.sh');
  });

  it('gives the conductor its cap and the rule it fills free places by', () => {
    const context = ProfileCompiler.compileConductorProfile({
      base: { name: 'base' },
      repoPath: '/repo',
      projectId: 'proj-1',
      conductorName: 'pup-conductor-proj-1',
      userConfigHash: 'user-hash-a',
      outDir: '/state/conductor/compiled',
      checkoutPath: '/state/conductor/checkout',
      maxSessions: 7,
    }).contextMarkdown;

    expect(context).toContain('It is refused once 7 sessions are live');
    expect(context).toContain(
      'Keep 7 sessions live: whenever fewer are, fill the free places with planned tasks whose ' +
        "scope-in globs share no source file with a running session's. The project's decisions " +
        'document and the file that registers CLI commands do not count as shared.',
    );
    expect(context).toContain('`--over-cap`');
    expect(context).toContain('A session waiting there is not stalled.');
  });
});
