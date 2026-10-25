import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';
import {
  codegraphBinary,
  codegraphLabel,
  codegraphMcpConfig,
  ensureCodegraphExcluded,
  indexDirectory,
  prepareGraph,
} from './codegraph.client.js';
import { type WorktreeGitEnv, WorktreeRepointedError } from './git-diff.client.js';

// Shortened by the one test that runs pup's own git out of its timeout.
const gitTimeout = vi.hoisted(() => ({ ms: undefined as number | undefined }));
vi.mock('./git-diff.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-diff.client.js')>();
  return {
    ...actual,
    runGit: (...[cwd, args, opts]: Parameters<typeof actual.runGit>) =>
      actual.runGit(
        cwd,
        args,
        opts?.timeout !== undefined && gitTimeout.ms !== undefined
          ? { ...opts, timeout: gitTimeout.ms }
          : opts,
      ),
  };
});

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

function makeRepo(): string {
  const repo = tempDir('pup-cg-repo-');
  sh(repo, 'git', 'init', '-q', '-b', 'main', '.');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  sh(repo, 'git', 'add', '-A');
  sh(repo, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return repo;
}

/**
 * The pins for a main checkout, which indexes the same way as a linked
 * worktree: the tests here are about what codegraph is handed, not about
 * which dirs those are.
 */
function pins(repo: string): WorktreeGitEnv {
  return { GIT_DIR: join(repo, '.git'), GIT_COMMON_DIR: join(repo, '.git'), GIT_WORK_TREE: repo };
}

/** The command-scope config an environment hands git, as key -> value. */
function gitConfigOf(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [
      env[`GIT_CONFIG_KEY_${index}`] ?? '',
      env[`GIT_CONFIG_VALUE_${index}`] ?? '',
    ]),
  );
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

    indexDirectory(join(fake.dir, 'codegraph'), pins(repo));

    expect(fake.calls()).toEqual([`init ${repo} --yes telemetry=0`]);
  });

  // `index` refuses to run before an init, and `init` indexes as it goes.
  it('re-indexes a directory that already has one instead of re-initializing it', () => {
    const fake = fakeCodegraph(LOGGING_CODEGRAPH);
    const repo = makeRepo();
    fakeIndexDir(repo);

    indexDirectory(join(fake.dir, 'codegraph'), pins(repo));

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

    indexDirectory(join(fake.dir, 'codegraph'), pins(makeRepo()));

    expect(fake.calls()).toEqual(['node_options=[] secret=[] download=[] nodl=[1]']);
  });

  // codegraph runs `ls-files` and `status` outside any sandbox, in the tree
  // and with the cwd in every nested repo it finds. Pinned, each of those reads
  // the dirs pup trusts, whatever `.git` the cwd holds; the config disarms an
  // fsmonitor and keeps git out of submodules (decision 101). Its index is a
  // copy pup owns, gone once the binary returns.
  it("pins the binary's git to the dirs it is handed, under pup's git config", () => {
    const fake = fakeCodegraph(
      [
        '#!/bin/sh',
        'printf "%s|%s|%s\\n" "$GIT_DIR" "$GIT_COMMON_DIR" "$GIT_WORK_TREE" >> __LOG__',
        'printf "%s\\n" "$GIT_INDEX_FILE" >> __LOG__',
        'env | grep "^GIT_CONFIG_" >> __LOG__',
        'exit 0',
      ].join('\n'),
    );
    const repo = makeRepo();

    indexDirectory(join(fake.dir, 'codegraph'), pins(repo));

    const [pinned, index = '', ...config] = fake.calls();
    expect(pinned).toBe(`${join(repo, '.git')}|${join(repo, '.git')}|${repo}`);
    expect(index).toMatch(/\/pup-index-[^/]+\/index$/);
    expect(existsSync(index)).toBe(false);
    expect(
      gitConfigOf(Object.fromEntries(config.map((line) => line.split(/=(.*)/s).slice(0, 2)))),
    ).toMatchObject({
      'core.fsmonitor': '',
      'core.hooksPath': '/dev/null',
      'diff.ignoreSubmodules': 'all',
      'status.submoduleSummary': 'false',
    });
  });

  // Over a gitlink, `status` runs a child git in the submodule's directory,
  // which clears the pins, and a `.gitmodules` `ignore = none` outranks any
  // config: only a command-line flag beats it, and codegraph's argv is not
  // pup's (decision 101).
  it('refuses a tree whose index holds a gitlink, before the binary runs', () => {
    const fake = fakeCodegraph(LOGGING_CODEGRAPH);
    const repo = makeRepo();
    const head = sh(repo, 'git', 'rev-parse', 'HEAD');
    sh(repo, 'git', 'update-index', '--add', '--cacheinfo', `160000,${head},lib/sub`);

    expect(() => indexDirectory(join(fake.dir, 'codegraph'), pins(repo))).toThrow(
      /lib\/sub is a gitlink in the index/,
    );
    expect(fake.calls()).toEqual([]);
  });

  // The admin dir's index is the session's to write, so a gitlink it adds
  // after the check would reach codegraph's git, whose child in the submodule
  // clears the pins. codegraph reads the snapshot pup checked instead (CI
  // review of #173).
  it('hands the binary the index it checked, whatever the admin dir holds by then', () => {
    const fake = fakeCodegraph(
      [
        '#!/bin/sh',
        'head=$(git rev-parse HEAD)',
        'GIT_INDEX_FILE="$GIT_DIR/index" git update-index --add --cacheinfo "160000,$head,lib/sub"',
        'git ls-files --stage >> __LOG__',
        'exit 0',
      ].join('\n'),
    );
    const repo = makeRepo();

    indexDirectory(join(fake.dir, 'codegraph'), pins(repo));

    expect(sh(repo, 'git', 'ls-files', '--stage')).toContain('160000');
    expect(fake.calls()).toEqual([expect.stringMatching(/^100644 \w+ 0\ta\.ts$/)]);
  });

  // A split index reads its entries from `$GIT_DIR/sharedindex.*`, which the
  // session can write too: the snapshot carries every entry itself.
  it('flattens a split index, so the binary reads nothing more from the admin dir', () => {
    const fake = fakeCodegraph(
      ['#!/bin/sh', 'rm -f "$GIT_DIR"/sharedindex.*', 'git ls-files >> __LOG__', 'exit 0'].join(
        '\n',
      ),
    );
    const repo = makeRepo();
    sh(repo, 'git', 'update-index', '--split-index');

    indexDirectory(join(fake.dir, 'codegraph'), pins(repo));

    expect(fake.calls()).toEqual(['a.ts']);
  });

  // The flatten reads the admin dir's `sharedindex.*`, which git opens
  // itself: a fifo there would hold the respawn, the fix round or the
  // conductor until something fed it.
  it('gives up on a split index whose shared half is a fifo, rather than hanging', () => {
    const fake = fakeCodegraph(LOGGING_CODEGRAPH);
    const repo = makeRepo();
    sh(repo, 'git', 'update-index', '--split-index');
    const shared = readdirSync(join(repo, '.git')).find((name) => name.startsWith('sharedindex.'));
    rmSync(join(repo, '.git', shared ?? ''));
    sh(repo, 'mkfifo', join(repo, '.git', shared ?? ''));

    gitTimeout.ms = 2_000;
    try {
      expect(() => indexDirectory(join(fake.dir, 'codegraph'), pins(repo))).toThrow(/ETIMEDOUT/);
    } finally {
      gitTimeout.ms = undefined;
    }
    expect(fake.calls()).toEqual([]);
  });

  it('refuses an index that is not a regular file, without blocking on a fifo', () => {
    const fake = fakeCodegraph(LOGGING_CODEGRAPH);
    const repo = makeRepo();
    rmSync(join(repo, '.git', 'index'));
    sh(repo, 'mkfifo', join(repo, '.git', 'index'));

    expect(() => indexDirectory(join(fake.dir, 'codegraph'), pins(repo))).toThrow(
      /index is not a regular file: refusing to index/,
    );
    expect(fake.calls()).toEqual([]);
  });

  /**
   * The index is addressed by PATH, and the directory handed over is one an
   * agent can write inside. A session that points its worktree's `.codegraph`
   * at the conductor's gets `existsSync` to follow the link, which picks the
   * `index` branch, and `codegraph index <worktree>` then rebuilds the
   * CONDUCTOR's database from the session's files: the victim's own files drop
   * out of its graph and its agent is answered verbatim out of the attacker's
   * tree. Refused before anything runs, so the caller's catch turns it into one
   * printed line and no config.
   */
  describe('refuses to index through an index that is not its own', () => {
    function plantedLink(name: string): { repo: string; victim: string } {
      const repo = makeRepo();
      const victim = tempDir('pup-cg-victim-');
      fakeIndexDir(victim);
      const link = join(repo, '.codegraph');
      if (name === 'codegraph.db') {
        mkdirSync(link, { recursive: true });
        symlinkSync(join(victim, '.codegraph', 'codegraph.db'), join(link, 'codegraph.db'));
      } else {
        symlinkSync(join(victim, '.codegraph'), link);
      }
      return { repo, victim };
    }

    it('refuses a .codegraph symlinked at another checkout', () => {
      const fake = fakeCodegraph(LOGGING_CODEGRAPH);
      const { repo } = plantedLink('.codegraph');

      expect(() => indexDirectory(join(fake.dir, 'codegraph'), pins(repo))).toThrow(
        /refusing to index through it/,
      );
      // The point of the guard: the binary never ran, so the victim's database
      // was never rebuilt from this tree.
      expect(fake.calls()).toEqual([]);
    });

    // The directory can be real and only the database linked away — `index`
    // writes the db, so that is the same rebuild by a narrower path.
    it('refuses a codegraph.db symlinked at another checkout', () => {
      const fake = fakeCodegraph(LOGGING_CODEGRAPH);
      const { repo } = plantedLink('codegraph.db');

      expect(() => indexDirectory(join(fake.dir, 'codegraph'), pins(repo))).toThrow(
        /refusing to index through it/,
      );
      expect(fake.calls()).toEqual([]);
    });

    // The whole guard must not cost the normal paths: a real index of its own
    // still re-indexes, and no index at all still initializes.
    it('indexes normally when the directory owns its own .codegraph', () => {
      const fake = fakeCodegraph(LOGGING_CODEGRAPH);
      const repo = makeRepo();
      fakeIndexDir(repo);

      indexDirectory(join(fake.dir, 'codegraph'), pins(repo));

      expect(fake.calls()).toEqual([`index ${repo} --quiet telemetry=0`]);
    });

    // A dangling link is still a link, and still names somewhere else.
    it('refuses a dangling symlink rather than initializing through it', () => {
      const fake = fakeCodegraph(LOGGING_CODEGRAPH);
      const { repo, victim } = plantedLink('.codegraph');
      rmSync(victim, { recursive: true, force: true });

      expect(() => indexDirectory(join(fake.dir, 'codegraph'), pins(repo))).toThrow(
        /refusing to index through it/,
      );
      expect(fake.calls()).toEqual([]);
    });
  });

  it('throws when the binary fails, so the caller can decide what a missing graph costs', () => {
    const fake = fakeCodegraph('#!/bin/sh\necho "boom" >&2\nexit 1\n');
    const repo = makeRepo();

    expect(() => indexDirectory(join(fake.dir, 'codegraph'), pins(repo))).toThrow();
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
  // Its `git status` runs outside the sandbox for the whole session, so it
  // gets the indexer's git config, which disarms a planted fsmonitor in
  // whatever repo it reads (decision 101).
  it('serves the session worktree with telemetry and peer credentials off', () => {
    const server = JSON.parse(codegraphMcpConfig('/bin/codegraph', '/repo/.worktrees/s-1'))
      .mcpServers.codegraph;
    expect(server).toMatchObject({
      type: 'stdio',
      command: '/bin/codegraph',
      args: ['serve', '--mcp', '--path', '/repo/.worktrees/s-1'],
      env: {
        CODEGRAPH_TELEMETRY: '0',
        CLAUDE_CODE_MESSAGING_SOCKET: '',
        CLAUDE_CODE_MESSAGING_TOKEN: '',
      },
    });
    expect(gitConfigOf(server.env)).toMatchObject({
      'core.fsmonitor': '',
      'diff.ignoreSubmodules': 'all',
      'status.submoduleSummary': 'false',
    });
    expect(Object.keys(server.env).filter((key) => /^GIT_(?!CONFIG_)/.test(key))).toEqual([]);
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

    expect(prepareGraph(join(fake.dir, 'codegraph'), repo, repo, () => pins(repo))).toBe(true);

    expect(sh(repo, 'git', 'status', '--porcelain')).toBe('');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('withholds the graph and says so once when the operator has no binary', () => {
    const errors = quiet();

    const repo = makeRepo();
    const pinned = vi.fn(() => pins(repo));

    expect(prepareGraph(undefined, repo, repo, pinned)).toBe(false);

    expect(errors.mock.calls.flat().join(' ')).toContain('without a code graph');
    expect(errors).toHaveBeenCalledTimes(1);
    // With no binary, the pins' check (and the conductor's checkout) never run.
    expect(pinned).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  // No graph, never the wrong one: codegraph walks PARENTS for a `.codegraph/`,
  // so a directory with no index of its own is answered out of whatever sits
  // above it.
  it('withholds the graph when the index fails, with the reason scrubbed', () => {
    const errors = quiet();
    const fake = fakeCodegraph('#!/bin/sh\nprintf "out \\033[31mof\\033[0m disk\\n" >&2\nexit 1');
    const repo = makeRepo();

    expect(prepareGraph(join(fake.dir, 'codegraph'), repo, repo, () => pins(repo))).toBe(false);

    const printed = errors.mock.calls.flat().join(' ');
    expect(printed).toContain('out');
    expect(printed).toContain('disk');
    expect(printed).not.toContain('\u001b');
    errors.mockRestore();
  });

  // A check that refuses the pins costs the graph, never the window: the
  // window's own check then decides whether it opens (decision 101).
  it('withholds the graph, indexing nothing, when the pins are refused', () => {
    const errors = quiet();
    const fake = fakeCodegraph(INDEXES);
    const repo = makeRepo();

    expect(
      prepareGraph(join(fake.dir, 'codegraph'), repo, repo, () => {
        throw new WorktreeRepointedError(repo, 'its .git no longer names the admin dir');
      }),
    ).toBe(false);

    // The fake writes the index when it runs; none was written.
    expect(existsSync(join(repo, '.codegraph'))).toBe(false);
    expect(errors.mock.calls.flat().join(' ')).toContain('without a code graph');
    errors.mockRestore();
  });
});
