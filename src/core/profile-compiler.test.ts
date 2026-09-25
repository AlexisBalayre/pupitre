import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-hook-')));
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
  let worktree: string;
  let events: string;

  /** A real git worktree with one commit, and the session's profile compiled for it. */
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pup-recheck-')));
    worktree = join(root, 'wt');
    events = join(root, 'events.jsonl');
    mkdirSync(join(worktree, 'src/net'), { recursive: true });
    mkdirSync(join(worktree, 'src/cli'), { recursive: true });
    writeFileSync(join(worktree, 'src/net/client.ts'), 'export {};\n');
    writeFileSync(join(worktree, 'src/cli/index.ts'), 'export {};\n');
    writeFileSync(join(worktree, 'src/cli/decoy.ts'), 'export {};\n');
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['add', '-A'],
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'],
    ]) {
      spawnSync('git', args, { cwd: worktree, env: GIT_ENV });
    }
    const outDir = join(root, 'compiled');
    const compiled = ProfileCompiler.compileProfile(
      makeInput({ worktreePath: worktree, eventsFile: events, outDir }),
    );
    ProfileCompiler.writeCompiledProfile(compiled, outDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
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
    const result = bash(
      "python3 - <<'EOF'\n" +
        "open('.git/info/exclude', 'a').write('\\n.claude/\\n')\n" +
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
    for (const tool of ['jq', 'cat', 'tr', 'grep', 'mktemp', 'rm', 'mkdir', 'mv', 'wc']) {
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
    vi.stubEnv('HOME', realpathSync(mkdtempSync(join(tmpdir(), 'pup-compiler-home-'))));
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
  };

  function runConductorHook(script: string, payload: object): number | null {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-conductor-hook-')));
    const compiled = ProfileCompiler.compileConductorProfile({ ...conductorInput, outDir: dir });
    ProfileCompiler.writeCompiledProfile(compiled, dir);
    return spawnSync('sh', [join(dir, script)], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
    }).status;
  }

  // The context is the operator's loop written down: what the conductor may
  // run, how it reaches a session by peer name, and that the merge is not its
  // to make (decision 47).
  it('tells the conductor its name, the worker model, the peer protocol and what it is refused', () => {
    const compiled = ProfileCompiler.compileConductorProfile(conductorInput);

    expect(compiled.contextMarkdown).toContain('conductor pup-conductor-proj-1');
    expect(compiled.contextMarkdown).toContain('pup launch <task> --model opus');
    expect(compiled.contextMarkdown).toContain('SendMessage');
    expect(compiled.contextMarkdown).toContain('notify_when_idle');
    expect(compiled.contextMarkdown).toContain('pup steer <session-id> --sent');
    expect(compiled.contextMarkdown).toContain('Refused to you: `pup merge`, `pup respawn`');
    expect(compiled.contextMarkdown).toContain('correct > simple > readable > fast');
    expect(compiled.contextMarkdown).not.toContain('pup session done "<one-line summary>"');
  });

  it('launches on the default model when no worker model is set', () => {
    const compiled = ProfileCompiler.compileConductorProfile({
      ...conductorInput,
      workerModel: undefined,
    });

    expect(compiled.contextMarkdown).toContain('`pup launch <task>`');
    expect(compiled.contextMarkdown).not.toContain('--model');
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
