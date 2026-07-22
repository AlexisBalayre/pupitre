import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
