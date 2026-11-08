import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';

const HOOK = join(import.meta.dirname, '..', '..', 'scripts', 'pre-commit');

// Same scrub as git-diff-client.test: keep the developer's git config and any
// surrounding hook's GIT_DIR away from the temp repo, and the running session's id
// (the hook tests outside a session unless a test sets one).
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') && key !== 'PUP_SESSION_ID' && key !== 'PUP_BIN',
    ),
  ),
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
// arguments contain $STUB_FAIL. Listing the tests prints $STUB_LISTED and fails
// when $STUB_LIST_FAIL is set.
const PNPM_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$*" in *"list --filesOnly"*) printf '%s' "$STUB_LISTED"; [ -z "$STUB_LIST_FAIL" ] || exit 1 ;; esac
case "$*" in *"$STUB_FAIL"*) [ -n "$STUB_FAIL" ] && exit 1 ;; esac
exit 0
`;

// A pup that logs its call, and fails like the pnpm stub. It answers `session --help`
// as pupitre does, which the hook asks to tell it from another tool named pup.
const PUP_STUB = `#!/bin/sh
case "$*" in "session --help") echo "Session-internal protocol commands"; exit 0 ;; esac
printf 'pup %s\\n' "$*" >> "$STUB_LOG"
case "$*" in *"$STUB_FAIL"*) [ -n "$STUB_FAIL" ] && exit 1 ;; esac
echo "stub pup waits for a test slot"
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
  write(repo, 'stub-bin/pup', PUP_STUB);
  chmodSync(join(repo, 'stub-bin', 'pup'), 0o755);
  return repo;
}

interface HookOptions {
  /** A call whose arguments contain this fails. */
  fail?: string;
  /** Run as a pup session with this id. */
  sessionId?: string;
  /** What listing the related tests prints. */
  listed?: string;
  /** The listing exits 1. */
  listFails?: boolean;
  /** The directories on PATH after the stubs; the machine's by default. */
  path?: string;
  /** Set PUP_BIN. */
  pupBin?: string;
}

/** Take pup off the hook's PATH; node stays, which the hook needs to pick its Node version. */
function withoutPup(repo: string): void {
  rmSync(join(repo, 'stub-bin', 'pup'));
  symlinkSync(process.execPath, join(repo, 'stub-bin', 'node'));
}

/** Stage `paths` (already written) and run the hook; the pnpm calls it made. */
function runHook(
  repo: string,
  paths: string[],
  options: HookOptions = {},
): { status: number | null; calls: string[]; stdout: string } {
  const { fail = '', sessionId = '', listed = 'src/sum.test.ts\n', listFails = false } = options;
  git(repo, 'add', '--', ...paths);
  const log = join(repo, 'stub.log');
  writeFileSync(log, '');
  const result = spawnSync('bash', [HOOK], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...GIT_ENV,
      PATH: `${join(repo, 'stub-bin')}:${options.path ?? process.env.PATH}`,
      STUB_LOG: log,
      STUB_FAIL: fail,
      STUB_LISTED: listed,
      ...(listFails ? { STUB_LIST_FAIL: '1' } : {}),
      ...(sessionId ? { PUP_SESSION_ID: sessionId } : {}),
      ...(options.pupBin ? { PUP_BIN: options.pupBin } : {}),
    },
  });
  return {
    status: result.status,
    calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
    stdout: result.stdout,
  };
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

  it('runs the typecheck when the staged change only deletes a TypeScript file', () => {
    const repo = makeRepo();
    git(repo, 'rm', '-q', 'src/sum.ts');

    const { status, calls } = runHook(repo, []);

    expect(status).toBe(0);
    expect(calls).toContain('typecheck');
  });

  it('blocks the commit when a related test fails', () => {
    const repo = makeRepo();
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { status } = runHook(repo, ['src/sum.ts'], { fail: 'vitest' });

    expect(status).not.toBe(0);
  });

  it('queues the related tests for a test slot inside a pup session', () => {
    const repo = makeRepo();
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { status, calls, stdout } = runHook(repo, ['src/sum.ts'], { sessionId: 't-session' });

    expect(status).toBe(0);
    expect(calls).toEqual([
      'exec biome check ./src/sum.ts',
      'typecheck',
      'exec vitest list --filesOnly --changed',
      'pup session test -- src/sum.test.ts',
    ]);
    expect(stdout).toContain('through a test slot (waits for a free one)');
  });

  it('blocks the commit when the tests run through a slot fail', () => {
    const repo = makeRepo();
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { status } = runHook(repo, ['src/sum.ts'], {
      fail: 'session test',
      sessionId: 't-session',
    });

    expect(status).not.toBe(0);
  });

  it('blocks the commit when the listing of related tests fails', () => {
    const repo = makeRepo();
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { status, calls } = runHook(repo, ['src/sum.ts'], {
      sessionId: 't-session',
      listFails: true,
    });

    expect(status).not.toBe(0);
    expect(calls.some((call) => call.startsWith('pup '))).toBe(false);
  });

  it('runs no tests, and passes, when the listing finds no related test', () => {
    const repo = makeRepo();
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { status, calls } = runHook(repo, ['src/sum.ts'], {
      sessionId: 't-session',
      listed: '',
    });

    expect(status).toBe(0);
    expect(calls).toEqual([
      'exec biome check ./src/sum.ts',
      'typecheck',
      'exec vitest list --filesOnly --changed',
    ]);
  });

  it('blocks the commit in a session when pup is not on the PATH and PUP_BIN is unset', () => {
    const repo = makeRepo();
    withoutPup(repo);
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { status, stdout } = runHook(repo, ['src/sum.ts'], {
      sessionId: 't-session',
      path: '/usr/bin:/bin',
    });

    expect(status, stdout).toBe(1);
    expect(stdout).toContain('PUP_BIN is not a file');
  });

  it('blocks the commit in a session when PUP_BIN names no file', () => {
    const repo = makeRepo();
    withoutPup(repo);
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { status } = runHook(repo, ['src/sum.ts'], {
      sessionId: 't-session',
      path: '/usr/bin:/bin',
      pupBin: join(repo, 'no-such-pup.js'),
    });

    expect(status).not.toBe(0);
  });

  it('blocks the commit in a session when the pup on the PATH is not pupitre', () => {
    const repo = makeRepo();
    withoutPup(repo);
    // An unrelated tool of that name: reads stdin, ignores its arguments, exits 0.
    write(repo, 'stub-bin/pup', '#!/bin/sh\nexit 0\n');
    chmodSync(join(repo, 'stub-bin', 'pup'), 0o755);
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { status, stdout } = runHook(repo, ['src/sum.ts'], {
      sessionId: 't-session',
      path: '/usr/bin:/bin',
    });

    expect(status, stdout).toBe(1);
    expect(stdout).toContain('no pupitre pup is on the PATH');
  });

  it('runs the tests through PUP_BIN when no pup is on the PATH', () => {
    const repo = makeRepo();
    withoutPup(repo);
    write(
      repo,
      'fake-pup.js',
      "require('node:fs').appendFileSync(process.env.STUB_LOG, 'pupbin ' + process.argv.slice(2).join(' ') + '\\n');\n",
    );
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { status, calls } = runHook(repo, ['src/sum.ts'], {
      sessionId: 't-session',
      path: '/usr/bin:/bin',
      pupBin: join(repo, 'fake-pup.js'),
    });

    expect(status).toBe(0);
    expect(calls.at(-1)).toBe('pupbin session test -- src/sum.test.ts');
  });

  it('lists the related tests with the real vitest, starting none of them', () => {
    const repo = makeRepo();
    const vitestBin = join(import.meta.dirname, '..', '..', 'node_modules', '.bin', 'vitest');
    // The hook's own listing runs for real; every other pnpm call is only logged.
    write(
      repo,
      'stub-bin/pnpm',
      `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$*" in "exec vitest"*) shift 2; exec "${vitestBin}" "$@" ;; esac
exit 0
`,
    );
    write(repo, 'src/other.ts', 'export const other = 1;\n');
    write(repo, 'src/other.test.ts', "import './other.js';\n");
    git(repo, 'add', 'src');
    git(repo, 'commit', '-m', 'other');
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { status, calls } = runHook(repo, ['src/sum.ts'], { sessionId: 't-session' });

    expect(status).toBe(0);
    expect(calls.at(-1)).toBe('pup session test -- src/sum.test.ts');
  });

  it('runs no tests when TEST_CMD is empty', () => {
    const repo = makeRepo(PROJECT_ENV.replace('TEST_CMD="pnpm test"', 'TEST_CMD=""'));
    write(repo, 'src/sum.ts', 'export const sum = 2;\n');

    const { calls } = runHook(repo, ['src/sum.ts']);

    expect(calls).toEqual(['exec biome check ./src/sum.ts', 'typecheck']);
  });
});
