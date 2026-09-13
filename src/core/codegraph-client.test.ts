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
  codegraphLabel,
  codegraphMcpConfig,
  ensureCodegraphExcluded,
  indexDirectory,
  prepareGraph,
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

    expect(codegraphBinary(makeRepo())).toBe(join(fake.dir, 'codegraph'));
  });

  it('answers undefined when the operator has no codegraph — a capability, not an error', () => {
    vi.stubEnv('PATH', tempDir('pup-cg-empty-'));

    expect(codegraphBinary(makeRepo())).toBeUndefined();
  });

  /**
   * `pnpm dev` as a session sees it: the relative `./node_modules/.bin` first on
   * PATH, resolved by `which` against the cwd, and a script planted there that
   * git ignores. Runs the body from inside the repo, which is what makes the
   * relative entry point at it.
   */
  function withPlantedShim<T>(repo: string, rest: string, body: () => T): T {
    const shim = join(repo, 'node_modules', '.bin');
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, 'codegraph'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const cwd = process.cwd();
    process.chdir(repo);
    // `/usr/bin:/bin` stays on the end so `which` itself still resolves —
    // without it this test would pass on a failed lookup rather than on the
    // refusal. Neither holds a codegraph.
    vi.stubEnv('PATH', `./node_modules/.bin:${rest}:/usr/bin:/bin`);
    try {
      return body();
    } finally {
      process.chdir(cwd);
    }
  }

  // `which` echoes the PATH ENTRY it matched, so the plain lookup answered a
  // repo-local path a session can plant a script at — executed by pup, and
  // written into mcp.json as a relative command every later session re-resolves
  // against its own worktree. Refused, not ranked last.
  it('refuses a repo-local shim rather than executing it', () => {
    const repo = makeRepo();

    const found = withPlantedShim(repo, tempDir('pup-cg-empty-'), () => codegraphBinary(repo));

    expect(found).toBeUndefined();
  });

  it('takes the real binary further down PATH, past the shim', () => {
    const repo = makeRepo();
    const outside = tempDir('pup-cg-bin-');
    writeFileSync(join(outside, 'codegraph'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const found = withPlantedShim(repo, outside, () => codegraphBinary(repo));

    expect(found).toBe(join(outside, 'codegraph'));
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

  // The binary is a third-party `#!/usr/bin/env node` shim: a full `process.env`
  // would hand it every operator secret, and `NODE_OPTIONS` alone is code
  // execution inside it. Built from an allowlist, so a variable is absent unless
  // it was named.
  it("hands the binary an allowlisted environment, not the operator's", () => {
    const fake = fakeCodegraph(
      [
        '#!/bin/sh',
        'printf "node_options=[%s] secret=[%s] download=[%s] nodl=[%s]\\n" \\',
        '  "$NODE_OPTIONS" "$PUP_TEST_SECRET" "$CODEGRAPH_DOWNLOAD_BASE" "$CODEGRAPH_NO_DOWNLOAD" \\',
        '  >> __LOG__',
        'exit 0',
      ].join('\n'),
    );
    vi.stubEnv('NODE_OPTIONS', '--require /tmp/pwn.js');
    vi.stubEnv('PUP_TEST_SECRET', 'hunter2');
    vi.stubEnv('CODEGRAPH_DOWNLOAD_BASE', 'https://attacker.example');

    indexDirectory(join(fake.dir, 'codegraph'), tempDir('pup-cg-dir-'));

    expect(fake.calls()).toEqual(['node_options=[] secret=[] download=[] nodl=[1]']);
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
    expect(lines.filter((line) => line === '/.codegraph/')).toHaveLength(1);
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

  // Anchored, so it hides the one directory codegraph creates and not a name.
  // Unanchored, `src/.codegraph/setup.ts` is invisible to the worktree-clean
  // stage — uncommitted code the gate cannot see but a test run can read.
  it('hides only the root index, never a nested .codegraph/ a session wrote', () => {
    const repo = makeRepo();
    fakeIndexDir(repo);
    fakeIndexDir(join(repo, 'src'));
    writeFileSync(join(repo, 'src', '.codegraph', 'setup.ts'), 'export const pwn = 1;\n');

    ensureCodegraphExcluded(repo);

    expect(sh(repo, 'git', 'status', '--porcelain')).toBe('?? src/');
  });
});

describe('codegraphMcpConfig', () => {
  // Pinned to the worktree, never the repo it sits inside: unpinned, codegraph
  // walks parents and serves the main checkout's graph.
  // The blanked pair is the point: Claude Code spawns a stdio server as its own
  // child, so it would inherit the peer credentials that address other sessions
  // and the conductor — which decision 47 keeps off the tmux server. An `env`
  // block overrides what is inherited.
  it('serves the session worktree with telemetry and peer credentials off', () => {
    expect(
      JSON.parse(codegraphMcpConfig('/bin/codegraph', '/repo/.worktrees/s-1')).mcpServers.codegraph,
    ).toEqual({
      type: 'stdio',
      command: '/bin/codegraph',
      args: ['serve', '--mcp', '--path', '/repo/.worktrees/s-1'],
      env: {
        CODEGRAPH_TELEMETRY: '0',
        CLAUDE_CODE_MESSAGING_SOCKET: '',
        CLAUDE_CODE_MESSAGING_TOKEN: '',
      },
    });
  });
});

describe('codegraphLabel', () => {
  it('answers the installed version, for the line beside the sandbox one', () => {
    fakeCodegraph('#!/bin/sh\necho "codegraph 1.6.0"\nexit 0');

    expect(codegraphLabel(makeRepo())).toBe('codegraph 1.6.0');
  });

  it('says so plainly when the operator has none — detected, never depended on', () => {
    vi.stubEnv('PATH', tempDir('pup-cg-empty-'));

    expect(codegraphLabel(makeRepo())).toBe('not installed');
  });

  // The version is a third-party CLI's stdout on its way to the terminal an
  // operator reads a decision from, so it goes through the same scrubbing every
  // other shell-out's output does (decision 29).
  it('strips control characters out of what the binary prints', () => {
    fakeCodegraph('#!/bin/sh\nprintf "1.6.0\\r\\033[2KPASS\\n"\nexit 0');

    const label = codegraphLabel(makeRepo());

    // The escape byte is what makes the rest a cursor instruction; without it
    // `[2K` is four characters of an odd version string and nothing more.
    expect(label).not.toContain('\u001b');
    expect(label).not.toContain('\r');
    expect(label).toBe('1.6.0 [2KPASS');
  });

  // A binary pup would still index with is not the same as no binary, and
  // reporting "not installed" for one would send an operator installing a
  // second copy of what they already have.
  it('reports a binary that will not answer as installed, not as absent', () => {
    const fake = fakeCodegraph('#!/bin/sh\nexit 3');

    expect(codegraphLabel(makeRepo())).toBe(
      `installed at ${join(fake.dir, 'codegraph')}, version unknown`,
    );
  });
});

describe('prepareGraph', () => {
  const INDEXES = [
    '#!/bin/sh',
    'mkdir -p "$2/.codegraph"',
    'printf \'*\\n!.gitignore\\n\' > "$2/.codegraph/.gitignore"',
    'echo sqlite > "$2/.codegraph/codegraph.db"',
    'exit 0',
  ].join('\n');

  function quiet(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(console, 'error').mockImplementation(() => {});
  }

  // The one call that makes a launch's graph the caller's own directory: it
  // indexes what it was handed, and excludes the index from the repo the gate
  // reads.
  it('indexes the directory it was given and leaves the checkout clean', () => {
    const errors = quiet();
    const fake = fakeCodegraph(INDEXES);
    const repo = makeRepo();

    expect(prepareGraph(join(fake.dir, 'codegraph'), repo, repo)).toBe(true);

    expect(sh(repo, 'git', 'status', '--porcelain')).toBe('');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('withholds the graph and says so once when the operator has no binary', () => {
    const errors = quiet();

    expect(prepareGraph(undefined, makeRepo(), makeRepo())).toBe(false);

    expect(errors.mock.calls.flat().join(' ')).toContain('without a code graph');
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  // No graph, never the wrong one: codegraph walks PARENTS for a `.codegraph/`,
  // so a directory with no index of its own is answered out of whatever sits
  // above it.
  it('withholds the graph when the index fails, with the reason scrubbed', () => {
    const errors = quiet();
    const fake = fakeCodegraph('#!/bin/sh\nprintf "out \\033[31mof\\033[0m disk\\n" >&2\nexit 1');
    const repo = makeRepo();

    expect(prepareGraph(join(fake.dir, 'codegraph'), repo, repo)).toBe(false);

    const printed = errors.mock.calls.flat().join(' ');
    expect(printed).toContain('out');
    expect(printed).toContain('disk');
    expect(printed).not.toContain('\u001b');
    errors.mockRestore();
  });
});
