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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  codegraphBinary,
  codegraphMcpConfig,
  ensureCodegraphExcluded,
  indexDirectory,
} from './codegraph.client.js';

// Test repos must not inherit the developer's global git config nor GIT_DIR & co.
// — when this suite runs inside a git hook (pre-commit), those would redirect
// every git call at the pupitre repo instead of the temp repo.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0] as string, args.slice(1), {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim();
}

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function makeRepo(): string {
  const repo = tempDir('pup-cg-repo-');
  sh(repo, 'git', 'init', '-q', '-b', 'main', '.');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  sh(repo, 'git', 'add', '-A');
  sh(repo, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return repo;
}

/**
 * What codegraph leaves behind: a `.codegraph/` whose own `.gitignore` hides the
 * contents but not the directory. Faked rather than run, so these hold on a
 * machine without the binary — what is asserted is git's answer to that
 * directory, which is the same either way (checked against the real 1.6.0).
 */
function fakeIndexDir(directory: string): void {
  const dir = join(directory, '.codegraph');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '*\n!.gitignore\n');
  writeFileSync(join(dir, 'codegraph.db'), 'sqlite');
}

/**
 * A `codegraph` on PATH logging its argv and telemetry variable, per
 * docs/conventions/testing.md: what is under test is what pup asks the CLI to
 * do, and the spawn path stays real.
 */
function fakeCodegraph(script: string): { dir: string; calls: () => string[] } {
  const dir = tempDir('pup-cg-bin-');
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'codegraph'), script.replace(/__LOG__/g, log), { mode: 0o755 });
  vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
  return {
    dir,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  };
}

const LOGGING_CODEGRAPH =
  '#!/bin/sh\nprintf "%s telemetry=%s\\n" "$*" "$CODEGRAPH_TELEMETRY" >> __LOG__\nexit 0';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('codegraphBinary', () => {
  it('resolves an absolute path so a tmux server that never read the profile can run it', () => {
    const fake = fakeCodegraph(LOGGING_CODEGRAPH);

    expect(codegraphBinary()).toBe(join(fake.dir, 'codegraph'));
  });

  it('answers undefined when the operator has no codegraph — a capability, not an error', () => {
    vi.stubEnv('PATH', tempDir('pup-cg-empty-'));

    expect(codegraphBinary()).toBeUndefined();
  });
});

describe('indexDirectory', () => {
  it('initializes a directory that has no graph yet, telemetry off', () => {
    const fake = fakeCodegraph(LOGGING_CODEGRAPH);
    const repo = makeRepo();

    indexDirectory(join(fake.dir, 'codegraph'), repo);

    expect(fake.calls()).toEqual([`init ${repo} --yes telemetry=0`]);
  });

  // `index` refuses to run before an init, and `init` indexes as it goes.
  it('re-indexes a directory that already has one instead of re-initializing it', () => {
    const fake = fakeCodegraph(LOGGING_CODEGRAPH);
    const repo = makeRepo();
    fakeIndexDir(repo);

    indexDirectory(join(fake.dir, 'codegraph'), repo);

    expect(fake.calls()).toEqual([`index ${repo} --quiet telemetry=0`]);
  });

  it('throws when the binary fails, so the caller can decide what a missing graph costs', () => {
    const fake = fakeCodegraph('#!/bin/sh\necho "boom" >&2\nexit 1\n');
    const repo = makeRepo();

    expect(() => indexDirectory(join(fake.dir, 'codegraph'), repo)).toThrow();
  });
});

describe('ensureCodegraphExcluded', () => {
  it('writes the line once, however often it is asked', () => {
    const repo = makeRepo();
    const exclude = join(repo, '.git', 'info', 'exclude');
    writeFileSync(exclude, '# no trailing newline');

    ensureCodegraphExcluded(repo);
    ensureCodegraphExcluded(repo);

    const lines = readFileSync(exclude, 'utf8').split('\n');
    expect(lines.filter((line) => line === '.codegraph/')).toHaveLength(1);
    // The line the caller found without one must not be joined to ours.
    expect(lines[0]).toBe('# no trailing newline');
  });

  // The claim the design rests on: `info/exclude` lives in the COMMON dir, so one
  // line written from any checkout leaves every checkout's porcelain clean —
  // including worktrees that did not exist when it was written.
  it('leaves every checkout clean, from a line written in one of them', () => {
    const repo = makeRepo();
    const worktree = join(repo, '.worktrees', 's-1');
    sh(repo, 'git', 'worktree', 'add', '-q', '-b', 'pup/s-1', worktree, 'HEAD');
    fakeIndexDir(repo);
    fakeIndexDir(worktree);
    expect(sh(worktree, 'git', 'status', '--porcelain')).toBe('?? .codegraph/');

    ensureCodegraphExcluded(worktree);

    expect(sh(worktree, 'git', 'status', '--porcelain')).toBe('');
    // The main checkout too. (Its own `?? .worktrees/` is pup's to ignore.)
    expect(sh(repo, 'git', 'status', '--porcelain')).not.toContain('.codegraph');
  });
});

describe('codegraphMcpConfig', () => {
  // Pinned to the worktree, never the repo it sits inside: unpinned, codegraph
  // walks parents and serves the main checkout's graph.
  it('serves the session worktree, telemetry off', () => {
    expect(
      JSON.parse(codegraphMcpConfig('/bin/codegraph', '/repo/.worktrees/s-1')).mcpServers.codegraph,
    ).toEqual({
      type: 'stdio',
      command: '/bin/codegraph',
      args: ['serve', '--mcp', '--path', '/repo/.worktrees/s-1'],
      env: { CODEGRAPH_TELEMETRY: '0' },
    });
  });
});
