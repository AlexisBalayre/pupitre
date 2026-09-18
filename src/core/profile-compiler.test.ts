import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { briefPath } from './brief.service.js';
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

    expect(compiled.contextMarkdown).toContain(
      '## Project brief\n### Destination\nA control plane the operator trusts.',
    );
    expect(compiled.contextMarkdown).toContain('### Constraints\nNo new dependencies');
    expect(compiled.contextMarkdown).not.toContain('Priorities');
    expect(compiled.contextMarkdown).not.toContain('Close the gate bypasses');
    // Ahead of the goal: the direction the task serves is read before the task.
    expect(compiled.contextMarkdown.indexOf('## Project brief')).toBeLessThan(
      compiled.contextMarkdown.indexOf('## Goal'),
    );
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
