import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';

const HOOK = join(import.meta.dirname, '..', '..', 'scripts', 'pre-commit');

// Same scrub as git-diff-client.test: keep the developer's git config and any
// surrounding hook's GIT_DIR away from the temp repo.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const PROJECT_ENV = [
  'SOURCE_EXTENSIONS="ts tsx"',
  'LINT_CMD="pnpm exec biome check"',
  'TYPECHECK_CMD="pnpm typecheck"',
  'TEST_CMD="pnpm test"',
].join('\n');

// A pnpm that logs each call instead of running it, and fails the one whose
// arguments contain $STUB_FAIL.
const PNPM_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$*" in *"$STUB_FAIL"*) [ -n "$STUB_FAIL" ] && exit 1 ;; esac
exit 0
`;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

function write(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** A repo with one committed source file and its test, and the hook's stubs. */
function makeRepo(projectEnv = PROJECT_ENV): string {
  const repo = tempDir('pup-pre-commit-');
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'hook@test');
  git(repo, 'config', 'user.name', 'hook-test');
  write(repo, '.claude/project.env', `${projectEnv}\n`);
  write(repo, 'src/sum.ts', 'export const sum = 1;\n');
  write(repo, 'src/sum.test.ts', "import './sum.js';\n");
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  // Present but untracked, so the hook does not install dependencies.
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
  write(repo, 'stub-bin/pnpm', PNPM_STUB);
  chmodSync(join(repo, 'stub-bin', 'pnpm'), 0o755);
  return repo;
}

/** Stage `paths` (already written) and run the hook; the pnpm calls it made. */
function runHook(
  repo: string,
  paths: string[],
  fail = '',
): { status: number | null; calls: string[] } {
  git(repo, 'add', '--', ...paths);
  const log = join(repo, 'stub.log');
  writeFileSync(log, '');
  const result = spawnSync('bash', [HOOK], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...GIT_ENV,
      PATH: `${join(repo, 'stub-bin')}:${process.env.PATH}`,
      STUB_LOG: log,
      STUB_FAIL: fail,
    },
  });
  return { status: result.status, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

describe('scripts/pre-commit', () => {
  it('runs only the tests related to a staged source file, never the full suite', () => {
    const repo = makeRepo();
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { status, calls } = runHook(repo, ['src/sum.ts']);

    expect(status).toBe(0);
    expect(calls).toEqual([
      'exec biome check ./src/sum.ts',
      'typecheck',
      'exec vitest related --run --passWithNoTests ./src/sum.ts',
    ]);
  });

  it('passes every staged source file to vitest related and leaves other files out', () => {
    const repo = makeRepo();
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');
    write(repo, 'src/sum.test.ts', "import './sum.js';\n// changed\n");
    write(repo, 'docs/notes.md', '# notes\n');

    const { calls } = runHook(repo, ['src/sum.ts', 'src/sum.test.ts', 'docs/notes.md']);

    expect(calls).toContain(
      'exec vitest related --run --passWithNoTests ./src/sum.test.ts ./src/sum.ts',
    );
  });

  it('runs lint but no typecheck and no vitest when only docs are staged', () => {
    const repo = makeRepo();
    write(repo, 'docs/notes.md', '# notes\n');

    const { status, calls } = runHook(repo, ['docs/notes.md']);

    expect(status).toBe(0);
    expect(calls).toEqual(['exec biome check ./docs/notes.md']);
  });

  it('blocks the commit when a related test fails', () => {
    const repo = makeRepo();
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { status } = runHook(repo, ['src/sum.ts'], 'vitest');

    expect(status).not.toBe(0);
  });

  it('runs no tests when TEST_CMD is empty', () => {
    const repo = makeRepo(PROJECT_ENV.replace('TEST_CMD="pnpm test"', 'TEST_CMD=""'));
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { calls } = runHook(repo, ['src/sum.ts']);

    expect(calls).toEqual(['exec biome check ./src/sum.ts', 'typecheck']);
  });
});
