import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as ProfileCompiler from '../../core/profile-compiler.service.js';
import type { CompileInput, SessionId, TaskId, TaskSpec } from '../../core/types/profile.types.js';
import { tempDir } from '../temp-dir.mock.js';

export const task: TaskSpec = {
  id: 'task-1' as TaskId,
  goal: 'Add retry logic to the fetch client',
  scopeIn: ['src/net/**', 'src/net/index.ts'],
  scopeOut: ['src/net/legacy/**'],
  acceptance: ['retries three times with backoff', 'unit tests cover the retry path'],
};

export function makeInput(overrides: Partial<CompileInput> = {}): CompileInput {
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

export function runHook(
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

/** The `key=value` pairs an environment hands git as command-scope config. */
export function commandScopeConfig(env: Record<string, string>): string[] {
  return Array.from(
    { length: Number(env.GIT_CONFIG_COUNT) },
    (_, index) => `${env[`GIT_CONFIG_KEY_${index}`]}=${env[`GIT_CONFIG_VALUE_${index}`]}`,
  );
}
