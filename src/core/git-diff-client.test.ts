import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ArmedGitDriverError,
  armedGitDrivers,
  assertMainCheckout,
  assertNoArmedGitDrivers,
  assertNoWorktreeConfig,
  BINARY_FREE_MAX_BYTES,
  BINARY_FREE_TOTAL_MAX_BYTES,
  currentBranch,
  GIT_SAFE_CONFIG,
  gitDiffAddedLines,
  gitDiffBinaryRecount,
  gitDiffNumstat,
  gitDiffPaths,
  RewrittenGitDirError,
  rethrowIfKilled,
  runGit,
  verifiedWorktreeGitEnv,
  WorktreeConfigError,
  WorktreeRepointedError,
  worktreeGitEnv,
} from './git-diff.client.js';
import {
  extensionOf,
  formatsNamed,
  knownBinarySize,
  mayBeKnownBinary,
  spendKnownBinarySkip,
} from './known-binary.utils.js';
import { LOCKFILE_NAMES } from './merge-gate.constants.js';

// Same scrub as merge-gate.test: keep the developer's git config and any
// surrounding hook's GIT_DIR away from the temp repos.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cwd: string, ...args: string[]): void {
  execFileSync(args[0] as string, args.slice(1), { cwd, encoding: 'utf8', env: GIT_ENV });
}

function makeRepo(): string {
  const repo = tempDir('pup-diff-');
  sh(repo, 'git', 'init', '-b', 'main');
  sh(repo, 'git', 'config', 'user.email', 'diff@test');
  sh(repo, 'git', 'config', 'user.name', 'diff-test');
  return repo;
}

function commitAll(repo: string, message: string): void {
  sh(repo, 'git', 'add', '.');
  sh(repo, 'git', 'commit', '-m', message);
}

/** Whether the git on PATH is at least `major.minor`. */
function gitAtLeast(major: number, minor: number): boolean {
  const version = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }));
  const [got, gotMinor] = [Number(version?.[1]), Number(version?.[2])];
  return got > major || (got === major && gotMinor >= minor);
}

describe('gitDiffAddedLines', () => {
  it('reports modified and appended line numbers per file, skipping pure deletions', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\nthree\n');
    writeFileSync(join(repo, 'b.ts'), 'keep\ndrop\n');
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-b', 'feature');
    writeFileSync(join(repo, 'a.ts'), 'one\nTWO\nthree\nfour\nfive\n');
    writeFileSync(join(repo, 'b.ts'), 'keep\n');
    commitAll(repo, 'change');

    const added = gitDiffAddedLines(repo, 'main', 'feature');

    expect(added).toEqual({ 'a.ts': [2, 4, 5] });
  });

  it('reports every line of a new file', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-b', 'feature');
    writeFileSync(join(repo, 'fresh.ts'), 'one\ntwo\n');
    commitAll(repo, 'add file');

    expect(gitDiffAddedLines(repo, 'main', 'feature')).toEqual({ 'fresh.ts': [1, 2] });
  });
});

describe('gitDiffAddedLines under an inherited pathspec mode', () => {
  it('still reads the hunks when git was told to take every pathspec literally', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-b', 'feature');
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\n');
    commitAll(repo, 'change');
    vi.stubEnv('GIT_LITERAL_PATHSPECS', '1');

    expect(gitDiffAddedLines(repo, 'main', 'feature')).toEqual({ 'a.ts': [2] });
    vi.unstubAllEnvs();
  });
});

// Each file's hunks are read with its path as a pathspec, which git would
// parse as magic unless told it is literal (decision 113).
describe('a changed path that reads as pathspec magic', () => {
  it('has its hunks read, so patch coverage and the recount count its lines', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'b.ts'), 'base\n');
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-b', 'feature');
    writeFileSync(join(repo, ':(top)foo'), 'one\ntwo\n');
    commitAll(repo, 'magic');

    expect(gitDiffAddedLines(repo, 'main', 'feature')).toEqual({ ':(top)foo': [1, 2] });
    // `-diff` makes numstat withhold its counts, so the recount runs.
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -diff\n');
    expect(recount(repo, ':(top)foo')).toEqual({
      added: 2,
      deleted: 0,
    });
  });
});

// On macOS `core.precomposeUnicode`, which `git init` turns on and a session
// can write into the shared config, rewrites an NFD path argument to NFC, so
// the gate read the hunks and blob of an NFC sibling instead (decision 114).
// Elsewhere git ignores the key and these pass either way.
describe('a changed NFD path with an NFC sibling under core.precomposeUnicode', () => {
  const nfd = 'e\u0301.ts';
  const nfc = '\u00e9.ts';

  // A working tree on APFS cannot hold both spellings, so they go straight to the index.
  function siblingRepo(nfcContent: string): string {
    const repo = makeRepo();
    sh(repo, 'git', 'config', 'core.precomposeUnicode', 'false');
    writeFileSync(join(repo, 'b.ts'), 'base\n');
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-b', 'feature');
    for (const [path, content] of [
      [nfd, 'one\ntwo\nthree\n'],
      [nfc, nfcContent],
    ] as const) {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: repo,
        env: GIT_ENV,
        input: content,
        encoding: 'utf8',
      }).trim();
      sh(repo, 'git', 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
    }
    sh(repo, 'git', 'commit', '-m', 'siblings');
    sh(repo, 'git', 'config', 'core.precomposeUnicode', 'true');
    return repo;
  }

  it('reads the NFD file its own hunks', () => {
    const repo = siblingRepo('x\n');

    expect(gitDiffAddedLines(repo, 'main', 'feature')).toEqual({ [nfd]: [1, 2, 3], [nfc]: [1] });
  });

  it('recounts the NFD file when its NFC sibling is binary', () => {
    const repo = siblingRepo('x\0y\n');
    // `-diff` makes numstat withhold the NFD file's counts, so the recount runs.
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -diff\n');

    expect(recount(repo, nfd)).toEqual({
      added: 3,
      deleted: 0,
    });
  });
});

// A session can write `diff.external` or a textconv driver into the shared,
// untracked `$GIT_COMMON_DIR/config` and `info/attributes`. Without the
// per-call disarm git runs the command and emits no hunks, and an empty
// `added` map reads as "no instrumentable changed lines" — a pass (decision 41).
// `-z` output must not be trimmed: a leading space is part of the first path.
describe('a changed path that starts with a space', () => {
  function spacedRepo(): string {
    const repo = makeRepo();
    writeFileSync(join(repo, 'b.ts'), 'base\n');
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-b', 'feature');
    writeFileSync(join(repo, ' a.ts'), 'one\ntwo\n');
    commitAll(repo, 'spaced');
    return repo;
  }

  it('is listed whole by gitDiffPaths and gitDiffNumstat', () => {
    const repo = spacedRepo();

    expect(gitDiffPaths(repo, 'main', 'feature')).toEqual([' a.ts']);
    expect(gitDiffNumstat(repo, 'main', 'feature')).toEqual([
      { path: ' a.ts', added: 2, deleted: 0 },
    ]);
  });

  it('has its hunk read, so patch coverage counts its lines', () => {
    const repo = spacedRepo();

    expect(gitDiffAddedLines(repo, 'main', 'feature')).toEqual({ ' a.ts': [1, 2] });
  });
});

// `-z` never quotes a path, so a tab in one reaches the numstat line as is. Cut
// at its first tab, a file under a directory named `a.test.ts<TAB>z` read as a
// test, and one under `pnpm-lock.yaml<TAB>x` as the root lockfile. A path that
// starts with a tab left the third field empty and read as a rename, swallowing
// the two records after it (decision 111).
describe('a changed path with a tab in it', () => {
  function tabbedRepo(files: string[]): string {
    const repo = makeRepo();
    writeFileSync(join(repo, 'b.ts'), 'base\n');
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-b', 'feature');
    for (const file of files) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), 'one\ntwo\n');
    }
    commitAll(repo, 'tabbed');
    return repo;
  }

  it('is counted under its full path, so a source file never reads as a test', () => {
    const repo = tabbedRepo(['src/a.test.ts\tz/impl.ts', 'src/c.ts']);

    expect(gitDiffNumstat(repo, 'main', 'feature')).toEqual([
      { path: 'src/a.test.ts\tz/impl.ts', added: 2, deleted: 0 },
      { path: 'src/c.ts', added: 2, deleted: 0 },
    ]);
  });

  it('is not the lockfile when only its root directory starts with the lockfile name', () => {
    const repo = tabbedRepo(['pnpm-lock.yaml\tx/big.ts']);

    const paths = gitDiffNumstat(repo, 'main', 'feature').map((stat) => stat.path);

    expect(paths).toEqual(['pnpm-lock.yaml\tx/big.ts']);
    expect(paths.filter((path) => LOCKFILE_NAMES.includes(path))).toEqual([]);
  });

  it('starting the path is no rename, so the records after it parse whole', () => {
    const repo = tabbedRepo(['\tlead.ts']);
    writeFileSync(join(repo, 'a.bin'), 'x\0y\n');
    writeFileSync(join(repo, 'c.bin'), 'q\0z\n');
    writeFileSync(join(repo, 'd.ts'), 'one\n');
    commitAll(repo, 'after');

    expect(gitDiffNumstat(repo, 'main', 'feature')).toMatchObject([
      { path: '\tlead.ts', added: 2, deleted: 0 },
      { path: 'a.bin', added: null, deleted: null },
      { path: 'c.bin', added: null, deleted: null },
      { path: 'd.ts', added: 1, deleted: 0 },
    ]);
  });
});

describe('gitDiffAddedLines under a session-armed diff driver', () => {
  function armedRepo(): string {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-b', 'feature');
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\n');
    commitAll(repo, 'change');
    return repo;
  }

  it('still sees the hunks when diff.external is set', () => {
    const repo = armedRepo();
    sh(repo, 'git', 'config', 'diff.external', '/usr/bin/true');

    expect(gitDiffAddedLines(repo, 'main', 'feature')).toEqual({ 'a.ts': [2] });
    expect(gitDiffPaths(repo, 'main', 'feature')).toEqual(['a.ts']);
  });

  // Forced colour puts an escape sequence before every `@@`, so the hunk
  // regex matches nothing; the config is honoured even through a pipe.
  it('still sees the hunks when color.ui=always is set', () => {
    const repo = armedRepo();
    sh(repo, 'git', 'config', 'color.ui', 'always');

    expect(gitDiffAddedLines(repo, 'main', 'feature')).toEqual({ 'a.ts': [2] });
  });

  // `* -diff` makes git report every file as "Binary files differ", zero hunks.
  it('still sees the hunks when info/attributes marks every file binary', () => {
    const repo = armedRepo();
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -diff\n');

    expect(gitDiffAddedLines(repo, 'main', 'feature')).toEqual({ 'a.ts': [2] });
  });

  it('still sees the hunks when a textconv driver is attached through info/attributes', () => {
    const repo = armedRepo();
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* diff=pwn\n');
    sh(repo, 'git', 'config', 'diff.pwn.textconv', '/usr/bin/true');

    expect(gitDiffAddedLines(repo, 'main', 'feature')).toEqual({ 'a.ts': [2] });
  });

  // Merged, the two hunks would report every line between them as added, lines
  // tests already cover, and lift an untested change over the bar (decision 113).
  it('keeps the hunks exact when diff.interHunkContext is set', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), `${lines.join('\n')}\n`);
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-b', 'feature');
    writeFileSync(join(repo, 'a.ts'), `top\n${lines.join('\n')}\nend\n`);
    commitAll(repo, 'change');
    sh(repo, 'git', 'config', 'diff.interHunkContext', '1000');

    expect(gitDiffAddedLines(repo, 'main', 'feature')).toEqual({ 'a.ts': [1, 102] });
  });

  // Patience and histogram anchor only on lines unique to each file, so they
  // read the block a swap moves past as deleted and re-added: 101 covered
  // lines that would lift an untested change over the bar (decision 113).
  it('keeps the hunks to the swapped lines when diff.algorithm is set', () => {
    const repeated = Array.from({ length: 100 }, () => 'x++;').join('\n');
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), `first\n${repeated}\nlast\n`);
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-b', 'feature');
    writeFileSync(join(repo, 'a.ts'), `last\n${repeated}\nfirst\n`);
    commitAll(repo, 'swap');
    sh(repo, 'git', 'config', 'diff.algorithm', 'patience');

    expect(gitDiffAddedLines(repo, 'main', 'feature')).toEqual({ 'a.ts': [1, 102] });
  });
});

// Under `diff.renames=copies` a new file copied from one the branch changes is
// scored as its edits from that file's old content, so a 300-line file counted
// as a few lines and slipped under the oversize flag (decision 113).
describe('gitDiffNumstat under a session-written diff.renames=copies', () => {
  it('counts every line of a new file copied from a changed one', () => {
    const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`);
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), `${lines.join('\n')}\n`);
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-b', 'feature');
    writeFileSync(join(repo, 'a.ts'), `${lines.join('\n')}\nend\n`);
    writeFileSync(join(repo, 'b.ts'), `${lines.join('\n')}\n`);
    commitAll(repo, 'copy');
    sh(repo, 'git', 'config', 'diff.renames', 'copies');

    expect(gitDiffNumstat(repo, 'main', 'feature')).toEqual([
      { path: 'a.ts', added: 1, deleted: 0 },
      { path: 'b.ts', added: 300, deleted: 0 },
    ]);
  });
});

/** The budget one diff's known-binary skips start from (decision 154). */
/** The full oid `spec` names. */
function oidOf(repo: string, spec: string): string {
  return execFileSync('git', ['rev-parse', spec], {
    cwd: repo,
    env: GIT_ENV,
    encoding: 'utf8',
  }).trim();
}

function fullBudget(): { bytes: number } {
  return { bytes: BINARY_FREE_TOTAL_MAX_BYTES };
}

/** `gitDiffBinaryRecount` of `path`'s numstat entry, main to feature, as the merge gate calls it. */
function recount(
  repo: string,
  path: string,
  budget = fullBudget(),
): { added: number; deleted: number } | null {
  const entry = gitDiffNumstat(repo, 'main', 'feature').find((stat) => stat.path === path);
  if (entry === undefined) throw new Error(`numstat lists no ${path}`);
  return gitDiffBinaryRecount(repo, entry, budget);
}

// `--text` restores the `-U0` patch above but not `--numstat`: under the same
// `* -diff` line every file reads `-\t-`, and a null skipped as a real binary
// lets any diff count as zero changed lines (decision 53).
describe('gitDiffBinaryRecount', () => {
  function repoWith(
    base: Record<string, string | Buffer>,
    feature: Record<string, string | Buffer>,
  ): string {
    const repo = makeRepo();
    for (const [file, content] of Object.entries(base)) writeFileSync(join(repo, file), content);
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-b', 'feature');
    for (const [file, content] of Object.entries(feature)) writeFileSync(join(repo, file), content);
    commitAll(repo, 'change');
    return repo;
  }

  it('recounts adds and deletes of a text file info/attributes marks binary', () => {
    const repo = repoWith({ 'a.ts': 'one\ntwo\nthree\n' }, { 'a.ts': 'one\nTWO\nfour\nfive\n' });
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -diff\n');

    expect(gitDiffNumstat(repo, 'main', 'feature')).toMatchObject([
      { path: 'a.ts', added: null, deleted: null },
    ]);
    expect(recount(repo, 'a.ts')).toEqual({
      added: 3,
      deleted: 2,
    });
  });

  it('recounts a new text file under core.attributesFile', () => {
    const repo = repoWith({ 'a.ts': 'one\n' }, { 'fresh.ts': 'one\ntwo\n' });
    const attributes = join(repo, '.git', 'forged-attributes');
    writeFileSync(attributes, '* binary\n');
    sh(repo, 'git', 'config', 'core.attributesFile', attributes);

    expect(recount(repo, 'fresh.ts')).toEqual({
      added: 2,
      deleted: 0,
    });
  });

  // Below the threshold git calls every file binary; pinned, a text file is
  // counted plainly and never needs the recount (decision 113).
  it('counts a text file plainly under a session-written core.bigFileThreshold of 1', () => {
    const repo = repoWith({ 'a.ts': 'one\n' }, { 'a.ts': 'one\ntwo\n', 'fresh.ts': 'one\ntwo\n' });
    sh(repo, 'git', 'config', 'core.bigFileThreshold', '1');

    expect(gitDiffNumstat(repo, 'main', 'feature')).toEqual([
      { path: 'a.ts', added: 1, deleted: 0 },
      { path: 'fresh.ts', added: 2, deleted: 0 },
    ]);
    expect(gitDiffAddedLines(repo, 'main', 'feature')).toEqual({
      'a.ts': [2],
      'fresh.ts': [1, 2],
    });
  });

  /** A PNG's signature and IHDR length, then `rest`: binary by NUL and by magic. */
  const png = (rest: string): Buffer =>
    Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n\0\0\0\rIHDR', 'latin1'), Buffer.from(rest)]);

  // `--text` parses hunks out of a real binary as well, so the patch cannot be
  // what tells the two apart.
  it('answers null for a known binary, armed or not, on either side of the diff', () => {
    const repo = repoWith(
      { 'image.png': png('y\nline\n'), 'gone.png': png('old\n'), 'icon.ICO': '\0\0\x01\0a\n' },
      {
        'image.png': png('z\nline\nmore\n'),
        'new.png': png('q\n'),
        'icon.ICO': '\0\0\x01\0b\n',
        'cap.png': png('x'.repeat(BINARY_FREE_MAX_BYTES - 16)),
      },
    );
    sh(repo, 'git', 'rm', '-q', 'gone.png');
    sh(repo, 'git', 'commit', '-q', '-m', 'drop');
    const paths = ['image.png', 'gone.png', 'new.png', 'icon.ICO', 'cap.png'];

    // The signature's CR and LF make its first three lines; the fourth is `line`.
    expect(gitDiffAddedLines(repo, 'main', 'feature')['image.png']).toEqual([3, 5]);
    for (const path of paths) {
      expect(recount(repo, path)).toBeNull();
    }

    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -diff\n');

    for (const path of paths) {
      expect(recount(repo, path)).toBeNull();
    }
  });

  // One NUL in a comment makes git call a 5 000-line source file binary, and
  // a null skipped for it counted the file as no lines at all (decision 154).
  it('recounts a source file with a NUL in its first 8000 bytes', () => {
    const source = `// \0\n${'export const v = 1;\n'.repeat(5000)}`;
    const repo = repoWith({ 'a.ts': 'one\n' }, { 'a.ts': source, 'fresh.js': source });

    expect(gitDiffNumstat(repo, 'main', 'feature')).toMatchObject([
      { path: 'a.ts', added: null, deleted: null },
      { path: 'fresh.js', added: null, deleted: null },
    ]);
    expect(recount(repo, 'a.ts')).toEqual({
      added: 5001,
      deleted: 1,
    });
    expect(recount(repo, 'fresh.js')).toEqual({
      added: 5001,
      deleted: 0,
    });
  });

  // Numstat lists a rename under its new path only, so a source file renamed
  // into a known binary had no merge-base side and skipped, every line it
  // deleted uncounted (decision 154).
  it('reads a rename source as the merge-base side, and recounts the pair', () => {
    const source = Array.from({ length: 40 }, (_, at) => `export const v${at} = ${at};\n`).join('');
    const repo = repoWith({ 'auth.ts': source }, { 'a.png': png(source) });
    sh(repo, 'git', 'rm', '-q', 'auth.ts');
    sh(repo, 'git', 'commit', '-q', '-m', 'rename');

    expect(gitDiffNumstat(repo, 'main', 'feature')).toEqual([
      {
        path: 'a.png',
        added: null,
        deleted: null,
        renamedFrom: 'auth.ts',
        sides: [
          { mode: '100644', oid: oidOf(repo, 'main:auth.ts') },
          { mode: '100644', oid: oidOf(repo, 'feature:a.png') },
        ],
      },
    ]);
    // The signature's CR and LF split auth.ts's first line into three.
    expect(recount(repo, 'a.png')).toEqual({ added: 3, deleted: 1 });
  });

  /** Stages `content` at `path`'s bytes: no argument carries a byte that is not UTF-8. */
  function stageBytes(repo: string, path: Buffer, content: Buffer): void {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo,
      env: GIT_ENV,
      input: content,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: repo,
      env: GIT_ENV,
      input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), path, Buffer.from('\n')]),
    });
  }

  const ZIP_END_RECORD = Buffer.from(`PK\x05\x06${'\0'.repeat(18)}`, 'latin1');

  // runGit decodes git's output as UTF-8, so a name that is not UTF-8 reaches
  // a path lookup as U+FFFD, a name the tree does not hold: the branch side
  // read as absent and a renamed image skipped whatever it carried.
  it('reads a rename onto a name that is not UTF-8 by oid, and recounts what it carries', () => {
    const image = png('a\n'.repeat(200));
    const repo = repoWith({ 'logo.png': image }, { 'other.ts': 'x\n' });
    sh(repo, 'git', 'rm', '-q', 'logo.png');
    stageBytes(
      repo,
      Buffer.from([0xff, ...Buffer.from('.png')]),
      Buffer.concat([image, Buffer.from('export const v = 1;\n'.repeat(5)), ZIP_END_RECORD]),
    );
    sh(repo, 'git', 'commit', '-q', '-m', 'rename');

    expect(gitDiffNumstat(repo, 'main', 'feature')).toMatchObject([
      { path: 'other.ts', added: 1, deleted: 0 },
      { path: '\ufffd.png', added: null, deleted: null, renamedFrom: 'logo.png' },
    ]);
    // Recounted from the two blobs: the five appended lines and the record's.
    expect(recount(repo, '\ufffd.png')).toEqual({ added: 6, deleted: 0 });
  });

  // Read by its decoded path, such a file's recount found no hunks at all.
  it('recounts a source file with a NUL whose name is not UTF-8 from its blob', () => {
    const repo = repoWith({ 'keep.ts': 'x\n' }, { 'other.ts': 'y\n' });
    const source = `// \0\n${'export const v = 1;\n'.repeat(5000)}`;
    stageBytes(repo, Buffer.from([0xff, ...Buffer.from('.ts')]), Buffer.from(source));
    sh(repo, 'git', 'commit', '-q', '-m', 'source');

    expect(recount(repo, '\ufffd.ts')).toEqual({ added: 5001, deleted: 0 });
  });

  // A decoy committed under the U+FFFD spelling answered the lookup for the
  // name that is not UTF-8, and its verdict skipped the other file.
  it('judges a file whose name is not UTF-8 by its own blob, not a decoy under the decoded name', () => {
    const repo = repoWith({ 'keep.ts': 'x\n' }, { '\ufffd.png': png('q\n') });
    stageBytes(
      repo,
      Buffer.from([0xff, ...Buffer.from('.png')]),
      png(`${'export const v = 1;\n'.repeat(7)}${'x'.repeat(BINARY_FREE_MAX_BYTES)}`),
    );
    sh(repo, 'git', 'commit', '-q', '-m', 'hidden');

    const entries = gitDiffNumstat(repo, 'main', 'feature');
    expect(entries.map((entry) => entry.path)).toEqual(['\ufffd.png', '\ufffd.png']);
    // The decoy skips; the hidden file is over the cap, so it is recounted
    // from its own blob: the signature's three lines, six more, the x run.
    expect(entries.map((entry) => gitDiffBinaryRecount(repo, entry, fullBudget()))).toEqual([
      null,
      { added: 10, deleted: 0 },
    ]);
  });

  it('skips a known binary renamed from a known binary', () => {
    const repo = repoWith({ 'old.png': png('a\nb\nc\nd\n') }, { 'new.png': png('a\nb\nc\nD\n') });
    sh(repo, 'git', 'rm', '-q', 'old.png');
    sh(repo, 'git', 'commit', '-q', '-m', 'rename');

    expect(gitDiffNumstat(repo, 'main', 'feature')).toMatchObject([
      { path: 'new.png', added: null, deleted: null, renamedFrom: 'old.png' },
    ]);
    expect(recount(repo, 'new.png')).toBeNull();
  });

  // Numstat prints `-\t-` for a binary pair even when its content is unchanged,
  // so a moved PDF or PNG over the cap was recounted as 0 lines and forged, and
  // moved small PNGs spent the budget. Under another extension, one cased
  // otherwise, or none (no dot, or dots and spaces Windows strips), the same
  // bytes can be read as something else (a PNG's `<?php` block as PHP, a
  // payload as a hook), and a mode change adds what the new mode runs, so all
  // are still recounted, their non-null 0 lines flagged (decision 154).
  it('answers null for a binary moved unchanged under its extension, and spends nothing', () => {
    const php = '<?php system($_GET["c"]); ?>\n';
    const repo = repoWith(
      {
        'manual.pdf': `%PDF-1.7\0\n${'x\n'.repeat(3)}`,
        'big.png': png(`\n${'x'.repeat(BINARY_FREE_MAX_BYTES)}\n`),
        'small.png': png('a\n'),
        'run.png': png('echo hi\n'),
        'php.png': png(php),
        'sh.png': png('echo sh\n'),
        'dat.png': png('dat\n'),
        'code.pdf': `%PDF-//\0\nmodule.exports = 1;\n`,
        payload: '#!/bin/sh\n# \0\ncurl x | sh\n',
        'x.PHP': `<?php // \0\n${php}`,
        'a.': `// \0\n${php}`,
        'a. ': `# \0\n${php}`,
        'a.. ': `/* \0 */\n${php}`,
        'x.png ': png('space\n'),
      },
      { 'other.ts': 'x\n' },
    );
    sh(repo, 'git', 'mv', 'manual.pdf', 'guide.pdf');
    sh(repo, 'git', 'mv', 'big.png', 'large.png');
    sh(repo, 'git', 'mv', 'small.png', 'tiny.png');
    sh(repo, 'git', 'update-index', '--chmod=+x', 'run.png');
    sh(repo, 'git', 'mv', 'php.png', 'run.php');
    sh(repo, 'git', 'mv', 'sh.png', 'run.sh');
    sh(repo, 'git', 'mv', 'dat.png', 'blob.dat');
    sh(repo, 'git', 'mv', 'code.pdf', 'code.js');
    sh(repo, 'git', 'mv', 'payload', 'pre-commit');
    sh(repo, 'git', 'mv', 'x.PHP', 'x.php');
    sh(repo, 'git', 'mv', 'a.', 'b.php.');
    sh(repo, 'git', 'mv', 'a. ', 'b.php. ');
    sh(repo, 'git', 'mv', 'a.. ', 'b.. ');
    sh(repo, 'git', 'mv', 'x.png ', 'y.png ');
    sh(repo, 'git', 'commit', '-q', '-m', 'move');
    const budget = fullBudget();

    expect(gitDiffNumstat(repo, 'main', 'feature')).toMatchObject([
      { path: 'b.. ', added: null, deleted: null, renamedFrom: 'a.. ' },
      { path: 'b.php.', added: null, deleted: null, renamedFrom: 'a.' },
      { path: 'b.php. ', added: null, deleted: null, renamedFrom: 'a. ' },
      { path: 'blob.dat', added: null, deleted: null, renamedFrom: 'dat.png' },
      { path: 'code.js', added: null, deleted: null, renamedFrom: 'code.pdf' },
      { path: 'guide.pdf', added: null, deleted: null, renamedFrom: 'manual.pdf' },
      { path: 'large.png', added: null, deleted: null, renamedFrom: 'big.png' },
      { path: 'other.ts', added: 1, deleted: 0 },
      { path: 'pre-commit', added: null, deleted: null, renamedFrom: 'payload' },
      { path: 'run.php', added: null, deleted: null, renamedFrom: 'php.png' },
      { path: 'run.png', added: null, deleted: null },
      { path: 'run.sh', added: null, deleted: null, renamedFrom: 'sh.png' },
      { path: 'tiny.png', added: null, deleted: null, renamedFrom: 'small.png' },
      { path: 'x.php', added: null, deleted: null, renamedFrom: 'x.PHP' },
      { path: 'y.png ', added: null, deleted: null, renamedFrom: 'x.png ' },
    ]);
    for (const path of ['guide.pdf', 'large.png', 'tiny.png']) {
      expect(recount(repo, path, budget)).toBeNull();
    }
    expect(budget.bytes).toBe(BINARY_FREE_TOTAL_MAX_BYTES);
    for (const path of [
      'run.png',
      'run.php',
      'run.sh',
      'blob.dat',
      'code.js',
      'pre-commit',
      'x.php',
      'b.php.',
      'b.php. ',
      'b.. ',
      'y.png ',
    ]) {
      expect(recount(repo, path, budget)).toEqual({ added: 0, deleted: 0 });
    }
    expect(budget.bytes).toBe(BINARY_FREE_TOTAL_MAX_BYTES);
  });

  // A copy keeps its source, so the same oid on both sides would add a file
  // and spend nothing. Plain rename detection is pinned, so a session-written
  // `diff.renames=copies` lists the copy as added, and its skip spends its size.
  it('lists a known binary copied from a changed one as added under diff.renames=copies', () => {
    const repo = repoWith(
      { 'a.png': png('a\n') },
      { 'a.png': png('a\nb\n'), 'copy.png': png('a\n') },
    );
    sh(repo, 'git', 'config', 'diff.renames', 'copies');
    const unpinned = execFileSync('git', ['diff', '--raw', 'main...feature'], {
      cwd: repo,
      env: GIT_ENV,
      encoding: 'utf8',
    });
    const budget = fullBudget();

    expect(unpinned).toMatch(/ C100\ta\.png\tcopy\.png\n/);
    expect(gitDiffNumstat(repo, 'main', 'feature')).toMatchObject([
      { path: 'a.png', added: null, deleted: null },
      { path: 'copy.png', added: null, deleted: null, sides: [undefined, { mode: '100644' }] },
    ]);
    expect(
      gitDiffNumstat(repo, 'main', 'feature').find((stat) => stat.path === 'copy.png')?.renamedFrom,
    ).toBeUndefined();
    expect(recount(repo, 'copy.png', budget)).toBeNull();
    expect(budget.bytes).toBe(BINARY_FREE_TOTAL_MAX_BYTES - png('a\n').length);
  });

  // Extension and magic are both the session's to write, so either alone
  // would let code with a NUL in it pass as an image.
  it('recounts a binary whose extension and magic do not name one format', () => {
    const repo = repoWith(
      { 'swapped.png': png('a\n'), 'text.png': 'one\n' },
      {
        'swapped.png': 'two\nthree\n',
        'text.png': 'one\0\ntwo\n',
        'code.js': png('x\ny\n'),
        'gif.png': 'GIF89a\0\nz\n',
      },
    );

    // The signature splits into three lines at its CR and LF.
    expect(recount(repo, 'swapped.png')).toEqual({
      added: 2,
      deleted: 3,
    });
    expect(recount(repo, 'text.png')).toEqual({
      added: 2,
      deleted: 1,
    });
    expect(recount(repo, 'code.js')).toEqual({
      added: 4,
      deleted: 0,
    });
    expect(recount(repo, 'gif.png')).toEqual({
      added: 2,
      deleted: 0,
    });
  });

  // A printable magic is valid code ahead of a comment holding the NUL, a magic
  // read past free leading bytes leaves those bytes to code, and an archive
  // or compiled code is content a loader unpacks: none of them is skipped.
  it('recounts a printable or offset magic, an archive, compiled code and a binary past the cap', () => {
    const lines = 'module.exports = 1;\n'.repeat(3);
    const repo = repoWith(
      { 'base.ts': 'one\n' },
      {
        'anim.gif': `GIF89a=0//\0\n${lines}`,
        'font.ttf': `true//\0\n${lines}`,
        'doc.pdf': `%PDF-//\0\n${lines}`,
        'clip.mp4': `x=1;ftyp//\0\n${lines}`,
        'lib.zip': `PK\x03\x04\0\n${lines}`,
        'mod.wasm': `\0asm\n${lines}`,
        'big.png': png(`\n${'x'.repeat(BINARY_FREE_MAX_BYTES)}\n`),
      },
    );

    for (const path of ['anim.gif', 'font.ttf', 'doc.pdf', 'clip.mp4', 'lib.zip', 'mod.wasm']) {
      expect(recount(repo, path)).toEqual({
        added: 4,
        deleted: 0,
      });
    }
    // The signature's CR and LF make three lines, then the IHDR line and the filler.
    expect(recount(repo, 'big.png')).toEqual({
      added: 4,
      deleted: 0,
    });
  });

  // zipimport, runpy and `java -jar` find a zip by its end record, whatever
  // comes first, so a PNG with a zip appended is an importable module. A
  // Zip64-aware zipimport searches past the classic 64 KiB plus 22 bytes, so
  // a record anywhere in the blob counts.
  it('recounts a known binary with a zip end record anywhere in it', () => {
    const endRecord = `PK\x05\x06${'\0'.repeat(18)}`;
    const repo = repoWith(
      { 'base.ts': 'one\n' },
      {
        'zipped.png': png(`\n${endRecord}`),
        'far.png': png(`${endRecord}\n${'x'.repeat(64 * 1024 + 22)}`),
      },
    );

    expect(recount(repo, 'zipped.png')).toEqual({
      added: 4,
      deleted: 0,
    });
    // The signature's CR and LF make three lines; the record ends the third.
    expect(recount(repo, 'far.png')).toEqual({
      added: 4,
      deleted: 0,
    });
  });

  // The PNG signature's CR and LF come before its first NUL, so bash runs an
  // executable PNG's later lines; no real image needs the exec bit.
  it('recounts an executable PNG', () => {
    const repo = repoWith({ 'base.ts': 'one\n' }, { 'run.png': png('echo hi\n') });
    sh(repo, 'git', 'update-index', '--chmod=+x', 'run.png');
    sh(repo, 'git', 'commit', '-q', '-m', 'exec');

    expect(gitDiffNumstat(repo, 'main', 'feature')).toMatchObject([
      { path: 'run.png', added: null, deleted: null, sides: [undefined, { mode: '100755' }] },
    ]);
    // The signature's CR and LF make three lines; `echo hi` ends the third.
    expect(recount(repo, 'run.png')).toEqual({ added: 3, deleted: 0 });
  });

  // A known binary is a regular file: a symlink blob holding a PNG signature
  // and a NUL is no image a checkout writes, so it is recounted (decision 154).
  it('recounts a symlink whose blob opens with a known magic and holds a NUL', () => {
    const repo = repoWith({ 'base.ts': 'one\n' }, { 'other.ts': 'x\n' });
    const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo,
      env: GIT_ENV,
      input: png('q\n'),
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: repo,
      env: GIT_ENV,
      input: `120000 ${oid}\tlink.png\n`,
      encoding: 'utf8',
    });
    sh(repo, 'git', 'commit', '-q', '-m', 'link');

    expect(
      execFileSync('git', ['ls-tree', 'feature', 'link.png'], {
        cwd: repo,
        env: GIT_ENV,
        encoding: 'utf8',
      }),
    ).toMatch(/^120000 blob /);
    // The signature's CR and LF make three lines; `q` ends the third.
    expect(recount(repo, 'link.png')).toEqual({
      added: 3,
      deleted: 0,
    });
  });

  // `toLowerCase` folds the Kelvin sign U+212A to `k`, which made `.mKv`
  // written with it name Matroska. Written through the index, so no file
  // system or precompose step rewrites the name.
  it('folds only ASCII case in the extension', () => {
    const repo = repoWith({ 'base.ts': 'one\n' }, { 'other.ts': 'x\n' });
    const path = 'clip.mKv';
    const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo,
      env: GIT_ENV,
      input: `\x1a\x45\xdf\xa3\0\n${'module.exports = 1;\n'.repeat(3)}`,
      encoding: 'latin1',
    }).trim();
    execFileSync('git', ['-c', 'core.precomposeUnicode=false', 'update-index', '--index-info'], {
      cwd: repo,
      env: GIT_ENV,
      input: `100644 ${oid}\t${path}\n`,
      encoding: 'utf8',
    });
    sh(repo, 'git', 'commit', '-q', '-m', 'kelvin');

    expect(recount(repo, path)).toEqual({
      added: 4,
      deleted: 0,
    });
  });

  // Magic alone is not enough: with no NUL in its first 8000 bytes a `.png`
  // is text to git, and under a forged `* -diff` it is still recounted.
  it('recounts a .png that opens with the PNG magic but holds no NUL', () => {
    const repo = repoWith(
      { 'base.ts': 'one\n' },
      { 'nonul.png': Buffer.from('\x89PNG\r\n\x1a\nx\ny\n', 'latin1') },
    );
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -diff\n');

    expect(gitDiffNumstat(repo, 'main', 'feature')).toMatchObject([
      { path: 'nonul.png', added: null, deleted: null },
    ]);
    // The signature's CR and LF make two lines, then `x` and `y`.
    expect(recount(repo, 'nonul.png')).toEqual({
      added: 4,
      deleted: 0,
    });
  });

  // Many files under the per-file cap would otherwise add up to an unread tree.
  it('skips known binaries from one shared budget and recounts the one past it', () => {
    const repo = repoWith(
      { 'gone.png': png('old\n') },
      { 'a.png': png('a\n'), 'b.png': png('b\n') },
    );
    sh(repo, 'git', 'rm', '-q', 'gone.png');
    sh(repo, 'git', 'commit', '-q', '-m', 'drop');
    const size = png('a\n').length;
    const budget = { bytes: size + 1 };

    expect(recount(repo, 'gone.png', budget)).toBeNull();
    expect(budget.bytes).toBe(size + 1);
    expect(recount(repo, 'a.png', budget)).toBeNull();
    expect(budget.bytes).toBe(1);
    // The signature's CR and LF make three lines; `b` ends the third.
    expect(recount(repo, 'b.png', budget)).toEqual({
      added: 3,
      deleted: 0,
    });
  });

  // Sides are what the recount reads; without them there is nothing to read
  // by oid, and a path is no key to fall back on.
  it('throws for an entry without the sides numstat pairs with it', () => {
    const repo = repoWith({ 'base.ts': 'one\n' }, { 'image.png': png('q\n') });

    expect(() => gitDiffBinaryRecount(repo, { path: 'image.png' }, fullBudget())).toThrow(
      /no --raw sides to recount image\.png from/,
    );
    // Two absent sides would match as one oid and mode and skip unread.
    const neither = [undefined, undefined] as unknown as Parameters<
      typeof gitDiffBinaryRecount
    >[1]['sides'];
    expect(() =>
      gitDiffBinaryRecount(repo, { path: 'image.png', sides: neither }, fullBudget()),
    ).toThrow(/no --raw sides to recount image\.png from/);
  });

  // An object read that fails was read as "this side does not exist", and a
  // known-format path then went uncounted; only `--raw`'s all-zero mode is absence.
  it('throws when the blob of a side cannot be read, rather than skip the file', () => {
    const repo = repoWith({ 'base.ts': 'one\n' }, { 'image.png': png('q\n') });
    const [entry] = gitDiffNumstat(repo, 'main', 'feature');
    const oid = oidOf(repo, 'feature:image.png');
    unlinkSync(join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));

    expect(entry?.sides?.[1]?.oid).toBe(oid);
    expect(() => gitDiffBinaryRecount(repo, entry ?? { path: '' }, fullBudget())).toThrow(
      /cat-file -s/,
    );
  });

  // Git only sniffs the first 8000 bytes, so a NUL past them is text to git
  // itself — reading the whole blob would let a session append one and pass.
  it('treats a NUL past the first 8000 bytes as text, the way git does', () => {
    const late = `${'a'.repeat(9000)}\n\0\n`;
    const repo = repoWith({ 'a.ts': 'one\n' }, { 'a.ts': `one\n${late}` });

    expect(gitDiffNumstat(repo, 'main', 'feature')[0]?.added).toBe(2);

    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -diff\n');

    expect(recount(repo, 'a.ts')).toEqual({
      added: 2,
      deleted: 0,
    });
  });
});

// The two surfaces `GIT_SAFE_CONFIG` cannot cover, because the driver name is
// chosen by whoever wrote it: there is no `-c` disarm, only a refusal
// (decision 50). Everything here is writable from a worktree with a plain
// `git config`, and none of it appears in a diff.
describe('armedGitDrivers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function repoWithCommit(): string {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    commitAll(repo, 'base');
    return repo;
  }

  it('names nothing in a repo where nothing is armed', () => {
    const repo = repoWithCommit();

    expect(armedGitDrivers(repo)).toEqual([]);
    expect(() => assertNoArmedGitDrivers(repo)).not.toThrow();
  });

  it.each(['smudge', 'clean', 'process'])(
    'names a filter.<name>.%s in the shared config',
    (key) => {
      const repo = repoWithCommit();
      sh(repo, 'git', 'config', `filter.pwn.${key}`, '/usr/bin/true');

      expect(armedGitDrivers(repo)).toEqual([`filter.pwn.${key}`]);
    },
  );

  it('names a merge.<name>.driver, which runs on a conflicting rebase', () => {
    const repo = repoWithCommit();
    sh(repo, 'git', 'config', 'merge.pwn.driver', '/usr/bin/true %A %O %B');

    expect(armedGitDrivers(repo)).toEqual(['merge.pwn.driver']);
  });

  // An operator's global `git lfs install` arms the lfs smudge filter for every
  // checkout, and git-lfs runs the transfer agent these keys name (decision 82).
  it.each([
    ['lfs.customtransfer.pwn.path', '/usr/bin/true'],
    ['lfs.customtransfer.pwn.args', '--pwn'],
    ['lfs.standalonetransferagent', 'pwn'],
    ['lfs.extension.pwn.clean', '/usr/bin/true %f'],
    ['lfs.extension.pwn.smudge', '/usr/bin/true %f'],
    // The looser forms git-lfs accepts (see `ARMED_DRIVER_KEY`, decision 82).
    ['lfs.CustomTransfer.pwn.path', '/usr/bin/true'],
    ['x.lfs.customtransfer.pwn.path', '/usr/bin/true'],
    ['lfs.customtransfer pwn.path', '/usr/bin/true'],
    ['lfs.https://example.com.standalonetransferagent', 'pwn'],
  ])('names %s, which git-lfs runs from the shared config', (key, value) => {
    const repo = repoWithCommit();
    sh(repo, 'git', 'config', key, value);

    expect(armedGitDrivers(repo)).toEqual([key]);
    expect(() => assertNoArmedGitDrivers(repo)).toThrow(
      new RegExp(`a filter or merge driver is armed.*${key.replaceAll('.', '\\.')}`),
    );
  });

  // git allows `\r` and the Unicode line separators in a subsection, and its
  // attribute parser keeps them in a filter name; a `.` without `s` skips them.
  it.each(['filter.a\u2028b.smudge', 'lfs.https://example.com/?\u2029.standalonetransferagent'])(
    'names %s, whose subsection holds a line terminator',
    (key) => {
      const repo = repoWithCommit();
      sh(repo, 'git', 'config', key, '/usr/bin/true');

      expect(armedGitDrivers(repo)).toHaveLength(1);
    },
  );

  // git-lfs reads plain `git config -l`, so a line inside a value, or an `=`
  // inside a subsection, is a key to it; a line without `=` is not (decision 82).
  it("names an lfs key hidden on a second line of another key's value", () => {
    const repo = repoWithCommit();
    sh(repo, 'git', 'config', 'pup.note', 'x\nlfs.customtransfer.pwn.path=/usr/bin/true');

    expect(armedGitDrivers(repo)).toEqual(['lfs.customtransfer.pwn.path']);
  });

  it('ignores a line without = in a value, as git-lfs does', () => {
    const repo = repoWithCommit();
    sh(repo, 'git', 'config', 'alias.note', '!echo\nlfs.customtransfer.pwn.path');

    expect(armedGitDrivers(repo)).toEqual([]);
  });

  it('names an lfs key an = in its subsection hides from the listed key', () => {
    const repo = repoWithCommit();
    sh(repo, 'git', 'config', 'lfs.extension.pwn.clean=/usr/bin/true.x', '1');

    expect(armedGitDrivers(repo)).toEqual(['lfs.extension.pwn.clean']);
  });

  it('ignores lfs keys that name no program', () => {
    const repo = repoWithCommit();
    sh(repo, 'git', 'config', 'lfs.customtransfer.pwn.concurrent', 'false');
    sh(repo, 'git', 'config', 'branch.feature/customtransfer-agent.remote', 'origin');
    sh(repo, 'git', 'config', 'lfs.fetchexclude', '*');
    sh(repo, 'git', 'config', 'lfs.extension.pwn.priority', '0');

    expect(armedGitDrivers(repo)).toEqual([]);
  });

  // The file is inert until a driver is named, but nothing else writes it, and
  // a `-diff` pattern there already forges the diff the coverage stage reads.
  it('names info/attributes on its own, quoting the pattern that armed it', () => {
    const repo = repoWithCommit();
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '# a comment\n\n* filter=pwn\n');

    expect(armedGitDrivers(repo)).toEqual(['info/attributes (* filter=pwn)']);
  });

  it('ignores an attributes file holding only comments and blank lines', () => {
    const repo = repoWithCommit();
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '# nothing here\n\n');

    expect(armedGitDrivers(repo)).toEqual([]);
  });

  // Refusing on the whole `filter`/`merge` namespace would refuse a repo whose
  // operator set an ordinary preference; neither of these executes anything.
  it('ignores keys in the same namespaces that name no command', () => {
    const repo = repoWithCommit();
    sh(repo, 'git', 'config', 'merge.conflictstyle', 'diff3');
    sh(repo, 'git', 'config', 'filter.pwn.required', 'true');

    expect(armedGitDrivers(repo)).toEqual([]);
  });

  // The operator's own global config is theirs to set — a developer with
  // git-lfs installed would otherwise be unable to launch anything.
  it('ignores a driver the operator set globally', () => {
    const repo = repoWithCommit();
    const global = join(tempDir('pup-gitglobal-'), 'config');
    writeFileSync(global, '[filter "lfs"]\n\tsmudge = git-lfs smudge -- %f\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);

    expect(armedGitDrivers(repo)).toEqual([]);
  });

  // `extensions.worktreeConfig` lives in the shared config, so a session can
  // turn it on and write `config.worktree` from its own worktree. A `--local`
  // read would miss it, and `--worktree` cannot be read on its own: it falls
  // back to the local file when the extension is off.
  it('names a driver set in worktree scope', () => {
    const repo = repoWithCommit();
    sh(repo, 'git', 'config', 'extensions.worktreeConfig', 'true');
    sh(repo, 'git', 'config', '--worktree', 'filter.pwn.smudge', '/usr/bin/true');

    expect(armedGitDrivers(repo)).toEqual(['filter.pwn.smudge']);
  });

  // The shared config and `info/attributes` are shared, so a worktree sees
  // everything the main checkout does; reading there only ever adds findings.
  it('sees the shared config from inside a linked worktree', () => {
    const repo = repoWithCommit();
    const worktree = join(repo, 'wt');
    sh(repo, 'git', 'worktree', 'add', '-q', '-b', 'feature', worktree, 'HEAD');
    sh(repo, 'git', 'config', 'filter.pwn.smudge', '/usr/bin/true');

    expect(armedGitDrivers(worktree)).toEqual(['filter.pwn.smudge']);
  });

  it('refuses loudly, naming the path and everything that is armed', () => {
    const repo = repoWithCommit();
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* filter=pwn\n');
    sh(repo, 'git', 'config', 'filter.pwn.smudge', '/usr/bin/true');

    expect(() => assertNoArmedGitDrivers(repo)).toThrow(ArmedGitDriverError);
    expect(() => assertNoArmedGitDrivers(repo)).toThrow(
      new RegExp(`${repo}.*info/attributes.*filter\\.pwn\\.smudge`),
    );
  });

  // The pattern is written by whoever armed the file and this message is
  // printed to the operator's terminal (decision 29).
  it('strips control characters out of the pattern it quotes', () => {
    const repo = repoWithCommit();
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '*\u001b[2J filter=pwn\n');

    expect(armedGitDrivers(repo)[0]).toBe('info/attributes (* [2J filter=pwn)');
  });
});

// Both keys are writable from a worktree with a plain `git config` and both
// run a command of the writer's choosing: `core.hooksPath` on a commit,
// `core.fsmonitor` on any index read (decisions 28 and 41).
describe('runGit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function armedRepo(): { repo: string; fired: string } {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    commitAll(repo, 'base');
    const fired = join(repo, '.git', 'fired');
    const hooks = join(repo, '.git', 'planted-hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\necho hook >> ${fired}\n`, { mode: 0o755 });
    const monitor = join(repo, '.git', 'planted-fsmonitor');
    writeFileSync(monitor, `#!/bin/sh\necho fsmonitor >> ${fired}\nexit 1\n`, { mode: 0o755 });
    sh(repo, 'git', 'config', 'core.hooksPath', hooks);
    sh(repo, 'git', 'config', 'core.fsmonitor', monitor);
    return { repo, fired };
  }

  // The control: a plain git call in the same repo runs both, so the planted
  // config is live and a quiet `runGit` is a disarm, not a dud.
  it('runs in a repo where a plain git call fires the planted hook and fsmonitor', () => {
    const { repo, fired } = armedRepo();
    sh(repo, 'git', 'status');
    sh(repo, 'git', 'commit', '--allow-empty', '-m', 'plain');

    expect(readFileSync(fired, 'utf8')).toMatch(/fsmonitor[\s\S]*hook/);
  });

  it('runs neither the planted core.hooksPath nor the planted core.fsmonitor', () => {
    const { repo, fired } = armedRepo();

    runGit(repo, ['status']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'through runGit']);

    expect(runGit(repo, ['log', '-1', '--format=%s']).trim()).toBe('through runGit');
    expect(existsSync(fired)).toBe(false);
  });

  // A hook that runs pup inherits GIT_DIR, which would aim every git call pup
  // makes at the hook's repo instead of the path it was handed.
  it('answers for the path it is given, not an inherited GIT_DIR', () => {
    const repo = makeRepo();
    const other = makeRepo();
    sh(other, 'git', 'checkout', '-q', '-b', 'elsewhere');
    vi.stubEnv('GIT_DIR', join(other, '.git'));

    expect(currentBranch(repo)).toBe('main');
  });

  // Verifying a signature runs `gpg.program` as surely as signing does, and a
  // session can forge the `gpgsig` header it verifies (decision 79).
  function signatureArmedRepo(): { repo: string; fired: string } {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    commitAll(repo, 'base');
    const tree = runGit(repo, ['rev-parse', 'HEAD^{tree}']).trim();
    const parent = runGit(repo, ['rev-parse', 'HEAD']).trim();
    const forged = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: repo,
      encoding: 'utf8',
      env: GIT_ENV,
      input:
        `tree ${tree}\nparent ${parent}\n` +
        'author f <f@test> 1 +0000\ncommitter f <f@test> 1 +0000\n' +
        'gpgsig -----BEGIN PGP SIGNATURE-----\n \n AAAA\n -----END PGP SIGNATURE-----\n' +
        '\nforged\n',
    }).trim();
    sh(repo, 'git', 'branch', 'feature', forged);
    const fired = join(repo, '.git', 'fired');
    const gpg = join(repo, '.git', 'planted-gpg');
    writeFileSync(gpg, `#!/bin/sh\necho gpg >> ${fired}\nexit 1\n`, { mode: 0o755 });
    sh(repo, 'git', 'config', 'gpg.program', gpg);
    sh(repo, 'git', 'config', 'log.showSignature', 'true');
    sh(repo, 'git', 'config', 'merge.verifySignatures', 'true');
    sh(repo, 'git', 'config', 'rebase.instructionFormat', '%G?%s');
    // Read after `-c` and before argv, so only a flag outranks it.
    sh(repo, 'git', 'config', 'branch.main.mergeOptions', '--verify-signatures');
    return { repo, fired };
  }

  // The control: without the `-c` pairs, `log` and `merge` both run it.
  it('runs in a repo where a plain log and ff-only merge fire the planted gpg.program', () => {
    const { repo, fired } = signatureArmedRepo();
    sh(repo, 'git', 'log', '-1', '--format=%s', 'feature');
    expect(readFileSync(fired, 'utf8')).toBe('gpg\n');

    expect(() => sh(repo, 'git', 'merge', '--ff-only', 'feature')).toThrow();
    expect(readFileSync(fired, 'utf8')).toBe('gpg\ngpg\n');
  });

  // The gate rebases the session's branch; the todo list it builds formats
  // every replayed commit, so this path is taken whenever the target has moved.
  it('runs in a repo where a plain rebase onto a moved target fires it too', () => {
    const { repo, fired } = signatureArmedRepo();
    writeFileSync(join(repo, 'b.ts'), 'two\n');
    commitAll(repo, 'advance main');
    sh(repo, 'git', 'checkout', '-q', 'feature');

    sh(repo, 'git', 'rebase', 'main');

    expect(readFileSync(fired, 'utf8')).toContain('gpg');
  });

  it('formats no signature on rebase, so the planted gpg.program never runs there', () => {
    const { repo, fired } = signatureArmedRepo();
    writeFileSync(join(repo, 'b.ts'), 'two\n');
    commitAll(repo, 'advance main');
    sh(repo, 'git', 'checkout', '-q', 'feature');

    runGit(repo, ['rebase', 'main'], { stdio: 'pipe' });

    expect(runGit(repo, ['log', '-1', '--format=%s']).trim()).toBe('forged');
    expect(existsSync(fired)).toBe(false);
  });

  // A repo tracking `*.bin filter=lfs`, with a pointer committed before the
  // filter was armed, and the lfs filter then pointed at a marker, standing in
  // for the operator's global `git lfs install` whose download runs programs
  // the shared config names (decision 82).
  function lfsArmedRepo(filter: 'smudge' | 'process' = 'smudge'): {
    repo: string;
    fired: string;
    pointer: string;
  } {
    const repo = makeRepo();
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12\n`;
    writeFileSync(join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    writeFileSync(join(repo, 'asset.bin'), pointer);
    commitAll(repo, 'base');
    const fired = join(repo, '.git', 'fired');
    const lfs = join(repo, '.git', 'planted-lfs');
    writeFileSync(lfs, `#!/bin/sh\necho lfs >> ${fired}\ncat\n`, { mode: 0o755 });
    sh(repo, 'git', 'config', `filter.lfs.${filter}`, filter === 'smudge' ? `${lfs} %f` : lfs);
    sh(repo, 'git', 'config', 'filter.lfs.required', 'true');
    return { repo, fired, pointer };
  }

  // The control: a plain checkout runs the lfs smudge on the pointer.
  it('runs in a repo where a plain worktree add fires the planted lfs smudge', () => {
    const { repo, fired } = lfsArmedRepo();

    sh(repo, 'git', 'worktree', 'add', '-q', '--detach', join(repo, 'plain'), 'HEAD');

    expect(readFileSync(fired, 'utf8')).toBe('lfs\n');
  });

  // `process` is the key a global `git lfs install` writes. The marker speaks
  // no pkt-line, so git kills it and fails the checkout, after it fired.
  it('runs in a repo where a plain worktree add starts the planted lfs process filter', () => {
    const { repo, fired } = lfsArmedRepo('process');

    expect(() =>
      sh(repo, 'git', 'worktree', 'add', '-q', '--detach', join(repo, 'plain'), 'HEAD'),
    ).toThrow();
    expect(readFileSync(fired, 'utf8')).toBe('lfs\n');
  });

  it.each(['smudge', 'process'] as const)(
    'checks out the lfs pointer unchanged and never runs the lfs %s filter',
    (filter) => {
      const { repo, fired, pointer } = lfsArmedRepo(filter);
      const checkout = join(repo, 'through-rungit');

      runGit(repo, ['worktree', 'add', '-q', '--detach', checkout, 'HEAD']);

      expect(readFileSync(join(checkout, 'asset.bin'), 'utf8')).toBe(pointer);
      expect(existsSync(fired)).toBe(false);
    },
  );

  it('verifies no signature on log or ff-only merge, so the planted gpg.program never runs', () => {
    const { repo, fired } = signatureArmedRepo();

    expect(runGit(repo, ['log', '-1', '--format=%s', 'feature']).trim()).toBe('forged');
    runGit(repo, ['merge', '--ff-only', '--no-verify-signatures', 'feature'], { stdio: 'pipe' });

    expect(currentBranch(repo)).toBe('main');
    expect(runGit(repo, ['log', '-1', '--format=%s']).trim()).toBe('forged');
    expect(existsSync(fired)).toBe(false);
  });
});

/** Every `file:line` that spawns git directly, rather than through `runGit`. */
function gitSpawns(file: string, source: string): string[] {
  const spawn =
    /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec)\(\s*(['"`])git(?:\1|\s)/g;
  return [...source.matchAll(spawn)].map(
    (match) => `${file}:${source.slice(0, match.index).split('\n').length}`,
  );
}

/** Production sources under `src/`, the one module allowed to spawn git excepted. */
function productionSources(): string[] {
  const root = join(process.cwd(), 'src');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => join('src', file))
    .filter((file) => file !== join('src', 'core', 'git-diff.client.ts'));
}

/**
 * Sixteen call sites each remembered `GIT_SAFE_CONFIG` and `scrubbedGitEnv` by
 * hand, and one that forgot either would run whatever a session wrote into the
 * shared config. This reads the source so the next direct spawn fails the suite
 * instead of shipping (decision 73, in the style of decision 68).
 */
describe('the single git entry point', () => {
  it('finds no git spawn outside git-diff.client.ts', () => {
    const found = productionSources().flatMap((file) =>
      gitSpawns(file, readFileSync(join(process.cwd(), file), 'utf8')),
    );

    expect(found).toEqual([]);
  });

  it('flags a planted git spawn, and leaves runGit and other binaries alone', () => {
    const source = [
      `execFileSync('git', ['status'], { encoding: 'utf8' });`,
      `runGit(repoPath, ['status']);`,
      `execFileSync('gh', ['--version']);`,
      `spawnSync(`,
      `  "git",`,
      `  ['log'],`,
      `);`,
      `execSync('git status');`,
      `execFileSync('gitleaks', ['detect']);`,
    ].join('\n');

    expect(gitSpawns('planted.ts', source)).toEqual([
      'planted.ts:1',
      'planted.ts:4',
      'planted.ts:8',
    ]);
  });
});

describe('rethrowIfKilled', () => {
  const failureOf = (script: string): unknown => {
    try {
      execFileSync('sh', ['-c', script], { stdio: 'ignore' });
    } catch (error) {
      return error;
    }
    throw new Error('the child was expected to fail');
  };

  it.each(['INT', 'TERM', 'HUP'])('rethrows a child SIG%s killed', (signal) => {
    const error = failureOf(`kill -${signal} $$`);
    expect(() => rethrowIfKilled(error)).toThrow(
      expect.objectContaining({ signal: `SIG${signal}` }),
    );
  });

  it("leaves git's own failure and a crash to the caller's catch", () => {
    expect(() => rethrowIfKilled(failureOf('exit 1'))).not.toThrow();
    expect(() => rethrowIfKilled(failureOf('kill -SEGV $$'))).not.toThrow();
  });
});

// A session can rewrite its worktree's `.git` gitfile and its admin dir's
// `commondir` from inside the sandbox, and an index read that followed either
// would run a clean filter armed in the repo they name (decision 101).
describe('worktree git pins (decision 101)', () => {
  let repo: string;
  let worktree: string;
  let marker: string;

  beforeEach(() => {
    repo = makeRepo();
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/app.ts'), 'export const app = 1;\n');
    commitAll(repo, 'base');
    worktree = join(repo, '.worktrees', 's-1');
    sh(repo, 'git', 'worktree', 'add', '-q', '-b', 'pup/s-1', worktree);
    marker = join(tempDir('pup-marker-'), 'fired');
  });

  /** Arms a clean filter on every path of the repo at `gitDir`, writing `marker` if it runs. */
  function plantCleanFilter(gitDir: string): void {
    sh(
      gitDir,
      'git',
      'config',
      '--file',
      join(gitDir, 'config'),
      'filter.pwn.clean',
      `sh -c 'echo pwned >> ${marker}; cat'`,
    );
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(join(gitDir, 'info', 'attributes'), '* filter=pwn\n');
  }

  /** A repo of the session's own, holding the worktree's file and an armed filter. */
  function plantedRepo(): string {
    const elsewhere = makeRepo();
    mkdirSync(join(elsewhere, 'src'));
    writeFileSync(join(elsewhere, 'src/app.ts'), 'export const app = 1;\n');
    commitAll(elsewhere, 'planted');
    plantCleanFilter(join(elsewhere, '.git'));
    return join(elsewhere, '.git');
  }

  /** Same size, new mtime: git must re-read the file, through the filter, to compare it. */
  function touchLater(file: string): void {
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
  }

  /** The plant is live: plain git in the worktree runs it. Then reset for the pinned run. */
  function expectPlainGitFires(stale: string): void {
    touchLater(stale);
    sh(worktree, 'git', 'status', '--porcelain');
    expect(existsSync(marker)).toBe(true);
    unlinkSync(marker);
    touchLater(stale);
  }

  const pinnedStatus = () =>
    runGit(worktree, ['status', '--porcelain', '--ignore-submodules=all'], {
      env: { ...worktreeGitEnv(repo, worktree) },
    });

  it('names the admin and common dirs of a worktree whose pointers are untouched', () => {
    expect(verifiedWorktreeGitEnv(repo, worktree)).toEqual({
      GIT_DIR: join(repo, '.git', 'worktrees', 's-1'),
      GIT_COMMON_DIR: join(repo, '.git'),
      GIT_WORK_TREE: worktree,
    });
  });

  it.each([
    ['a repointed gitfile', (planted: string) => [join(worktree, '.git'), `gitdir: ${planted}\n`]],
    [
      'a rewritten commondir',
      (planted: string) => [join(repo, '.git', 'worktrees', 's-1', 'commondir'), `${planted}\n`],
    ],
  ])('refuses %s, and pinned git never runs its clean filter', (_, pointer) => {
    const [file, content] = pointer(plantedRepo()) as [string, string];
    writeFileSync(file, content);
    expectPlainGitFires(join(worktree, 'src/app.ts'));

    expect(() => verifiedWorktreeGitEnv(repo, worktree)).toThrow(WorktreeRepointedError);
    // The repair advice unless a caller passes its own (a launch that removed the worktree).
    expect(() => verifiedWorktreeGitEnv(repo, worktree)).toThrow(
      /a repo it chose\. Restore them \(`git -c worktree\.useRelativePaths=false worktree repair` from the main checkout\) and retry, and treat the session that did it as compromised\.$/,
    );
    // Pinned, git reads neither pointer: a rewrite after the check changes nothing.
    pinnedStatus();
    expect(existsSync(marker)).toBe(false);
  });

  it('never runs a child git in a gitlink over a .git of the session', () => {
    const sub = join(worktree, 'sub');
    mkdirSync(sub);
    sh(sub, 'git', 'init', '-q');
    writeFileSync(join(sub, 'f'), 'a\n');
    sh(sub, 'git', 'add', 'f');
    sh(sub, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'sub');
    plantCleanFilter(join(sub, '.git'));
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sub,
      env: GIT_ENV,
      encoding: 'utf8',
    }).trim();
    sh(worktree, 'git', 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
    expectPlainGitFires(join(sub, 'f'));

    pinnedStatus();
    expect(existsSync(marker)).toBe(false);
  });

  // Pinned git still reads `<admin>/config.worktree` while the extension is on,
  // and the file sits beside commondir, where the session can write it.
  it('refuses while git would read the worktree config, and runs no filter from it', () => {
    const worktreeConfig = join(repo, '.git/worktrees/s-1/config.worktree');
    sh(
      repo,
      'git',
      'config',
      '--file',
      worktreeConfig,
      'filter.pwn.clean',
      `sh -c 'echo pwned >> ${marker}; cat'`,
    );
    writeFileSync(join(worktree, '.gitattributes'), '* filter=pwn\n');
    expect(() => verifiedWorktreeGitEnv(repo, worktree)).toThrow(/config\.worktree/);

    sh(repo, 'git', 'config', 'extensions.worktreeConfig', 'true');
    touchLater(join(worktree, 'src/app.ts'));
    pinnedStatus();
    // The plant is live: with the extension on, pinned git runs it.
    expect(existsSync(marker)).toBe(true);
    unlinkSync(worktreeConfig);
    // Written from outside the repo, which git refuses to open once the value is unreadable.
    const setExtension = (value: string) =>
      sh(
        dirname(marker),
        'git',
        'config',
        '--file',
        join(repo, '.git/config'),
        'extensions.worktreeConfig',
        value,
      );
    // The extension alone refuses too: a file written after the check would be read.
    expect(() => verifiedWorktreeGitEnv(repo, worktree)).toThrow(/extensions\.worktreeConfig/);
    setExtension('maybe');
    expect(() => verifiedWorktreeGitEnv(repo, worktree)).toThrow(WorktreeRepointedError);
    setExtension('false');
    expect(() => verifiedWorktreeGitEnv(repo, worktree)).not.toThrow();
  });

  // A session window sets `diff.ignoreSubmodules=all` through the environment,
  // and pup run from it, its tests included, must not inherit that into the
  // scope audit's diff, where it would hide a gitlink change.
  it("leaves out the config a caller's environment hands git", () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'diff.ignoreSubmodules');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'all');
    vi.stubEnv('GIT_CONFIG_PARAMETERS', "'diff.ignoresubmodules'='all'");
    const sub = makeRepo();
    writeFileSync(join(sub, 'f'), 'a\n');
    commitAll(sub, 'sub');
    sh(repo, 'git', 'checkout', '-q', '-b', 'feature');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sub,
      env: GIT_ENV,
      encoding: 'utf8',
    });
    sh(repo, 'git', 'update-index', '--add', '--cacheinfo', `160000,${head.trim()},vendored`);
    sh(repo, 'git', 'commit', '-q', '-m', 'gitlink');

    expect(gitDiffPaths(repo, 'main', 'feature')).toEqual(['vendored']);
    vi.unstubAllEnvs();
  });

  it('refuses a gitfile that is a symlink or a fifo, without blocking on the fifo', () => {
    const copy = join(tempDir('pup-gitfile-'), 'gitfile');
    writeFileSync(copy, readFileSync(join(worktree, '.git')));
    unlinkSync(join(worktree, '.git'));
    symlinkSync(copy, join(worktree, '.git'));
    expect(() => verifiedWorktreeGitEnv(repo, worktree)).toThrow(WorktreeRepointedError);

    unlinkSync(join(worktree, '.git'));
    sh(worktree, 'mkfifo', '.git');
    expect(() => verifiedWorktreeGitEnv(repo, worktree)).toThrow(WorktreeRepointedError);
  });

  // The gate's driver check runs pinned, as the rebase it guards does: unpinned,
  // it would read whichever repo the pointer named at that moment.
  it('reads armed drivers from the trusted dirs, whatever the gitfile names', () => {
    sh(repo, 'git', 'config', 'filter.real.smudge', 'cat');
    writeFileSync(join(worktree, '.git'), `gitdir: ${plantedRepo()}\n`);

    expect(armedGitDrivers(worktree, worktreeGitEnv(repo, worktree))).toEqual([
      'filter.real.smudge',
    ]);
  });

  // Git 2.48+ writes `gitdir: ../../.git/worktrees/<id>` under the operator's
  // global `worktree.useRelativePaths`, which the exact checks refuse as a
  // rewrite. pup's own `worktree add` pins the option off instead.
  describe('with worktree.useRelativePaths on in the global config', () => {
    let globalConfig: string;

    beforeEach(() => {
      globalConfig = join(tempDir('pup-global-'), 'gitconfig');
      writeFileSync(globalConfig, '[worktree]\n\tuseRelativePaths = true\n');
      vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("has pup's worktree add write the absolute gitfile the check accepts", () => {
      const added = join(repo, '.worktrees', 's-2');
      runGit(repo, ['worktree', 'add', '-b', 'pup/s-2', added, 'HEAD']);

      expect(readFileSync(join(added, '.git'), 'utf8')).toBe(
        `gitdir: ${join(repo, '.git', 'worktrees', 's-2')}\n`,
      );
      expect(verifiedWorktreeGitEnv(repo, added).GIT_WORK_TREE).toBe(added);
    });

    // An older git knows no such option, so the plant is live from 2.48 on only.
    it.runIf(gitAtLeast(2, 48))(
      'is live: plain git writes a relative gitfile, which the check refuses',
      () => {
        const added = join(repo, '.worktrees', 's-3');
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'pup/s-3', added], {
          cwd: repo,
          env: { ...GIT_ENV, GIT_CONFIG_GLOBAL: globalConfig },
        });

        expect(readFileSync(join(added, '.git'), 'utf8')).toMatch(/^gitdir: \.\./);
        expect(() => verifiedWorktreeGitEnv(repo, added)).toThrow(WorktreeRepointedError);
      },
    );
  });
});

// Usually the operator's config: `git sparse-checkout` turns the extension on
// and writes `config.worktree`, which the launch's own check would refuse only
// once the worktree and the session row exist (decision 101). A session that
// can write the shared config can do the same, so the refusal asks for both
// files to be read before anything is removed.
describe('assertNoWorktreeConfig', () => {
  let repo: string;

  // Written from outside the repo, which git refuses to open once the value is unreadable.
  const setExtension = (target: string, value: string) =>
    sh(
      dirname(target),
      'git',
      'config',
      '--file',
      join(target, '.git/config'),
      'extensions.worktreeConfig',
      value,
    );

  /** The commands the refusal's hint asks the operator to paste, in order. */
  const hintCommands = (target: string): string[] => {
    try {
      assertNoWorktreeConfig(target);
    } catch (error) {
      const steps = (error as Error).message.split('Otherwise run ')[1] ?? '';
      return [...steps.matchAll(/`(git [^`]*)`/g)].map((match) => match[1] as string);
    }
    throw new Error(`${target} was not refused`);
  };

  /** What pasting `command` into a shell in `cwd` does. */
  const paste = (cwd: string, command: string) =>
    execFileSync('sh', ['-c', command], { cwd, encoding: 'utf8', env: GIT_ENV, stdio: 'pipe' });

  beforeEach(() => {
    repo = makeRepo();
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/app.ts'), 'export const app = 1;\n');
    writeFileSync(join(repo, 'README.md'), 'readme\n');
    commitAll(repo, 'base');
  });

  it('refuses a repo sparse-checkout has touched, disabled or not, naming it', () => {
    sh(repo, 'git', 'sparse-checkout', 'set', 'src');
    expect(() => assertNoWorktreeConfig(repo)).toThrow(WorktreeConfigError);
    expect(() => assertNoWorktreeConfig(repo)).toThrow(/git sparse-checkout/);
    expect(() => assertNoWorktreeConfig(repo)).toThrow(
      /inspect \.git\/config and \.git\/config\.worktree before removing anything/,
    );

    // `disable` leaves both the extension and the file behind.
    sh(repo, 'git', 'sparse-checkout', 'disable');
    expect(() => assertNoWorktreeConfig(repo)).toThrow(WorktreeConfigError);
  });

  it('refuses the file alone, the extension alone and a value git cannot read', () => {
    expect(() => assertNoWorktreeConfig(repo)).not.toThrow();
    writeFileSync(join(repo, '.git/config.worktree'), '');
    expect(() => assertNoWorktreeConfig(repo)).toThrow(/config\.worktree exists/);
    unlinkSync(join(repo, '.git/config.worktree'));

    setExtension(repo, 'true');
    expect(() => assertNoWorktreeConfig(repo)).toThrow(/extensions\.worktreeConfig is on in /);
    setExtension(repo, 'maybe');
    expect(() => assertNoWorktreeConfig(repo)).toThrow(
      /extensions\.worktreeConfig is on, or holds a value git cannot read, in /,
    );
    setExtension(repo, 'false');
    expect(() => assertNoWorktreeConfig(repo)).not.toThrow();
  });

  // `git sparse-checkout disable` fails while the value is unreadable, and turns
  // the extension back on once it runs, so the hint unsets before and after it.
  it('leads an unreadable value with the unset, and its steps clear a sparse checkout', () => {
    sh(repo, 'git', 'sparse-checkout', 'set', 'src');
    setExtension(repo, 'maybe');
    const [unset, disable] = hintCommands(repo);
    expect(unset).toBe(
      `git -C / config --file ${join(repo, '.git/config')} --unset-all extensions.worktreeConfig`,
    );
    expect(disable).toBe('git sparse-checkout disable');
    expect(() => paste(repo, disable as string)).toThrow(/bad boolean config value/);

    paste(repo, unset as string);
    paste(repo, disable as string);
    expect(() => assertNoWorktreeConfig(repo)).toThrow(/extensions\.worktreeConfig is on in /);
    paste(repo, unset as string);
    unlinkSync(join(repo, '.git/config.worktree'));
    expect(() => assertNoWorktreeConfig(repo)).not.toThrow();
  });

  // `--unset` refuses a key set twice ("multiple values"), so the hint's would fail here.
  it('unsets every copy of a key set twice', () => {
    writeFileSync(
      join(repo, '.git/config'),
      `${readFileSync(join(repo, '.git/config'), 'utf8')}[extensions]\n` +
        '\tworktreeConfig = maybe\n\tworktreeConfig = maybe\n',
    );
    const [unset] = hintCommands(repo);

    paste(repo, unset as string);
    expect(() => assertNoWorktreeConfig(repo)).not.toThrow();
  });

  // sanitizeReason folds whitespace, blanks control chars and truncates, so a
  // command built from its output would unset some other file.
  it.each([
    ['two spaces', 'My  Project'],
    ['a tab', 'My\tProject'],
    ['a newline', 'My\nProject'],
    ['ESC and CSI', 'My\u001b[31m\u009bProject'],
    // Two components: under Linux's short /tmp one name of NAME_MAX stays under the cap.
    ['a path past the truncation', `${'p'.repeat(200)}/${'p'.repeat(200)}`],
  ])('prints no paste-ready unset for a path with %s, and no control char', (_, name) => {
    const odd = join(tempDir('pup-diff-'), name);
    mkdirSync(odd, { recursive: true });
    sh(odd, 'git', 'init', '-q', '-b', 'main');
    setExtension(odd, 'maybe');
    let message = '';
    try {
      assertNoWorktreeConfig(odd);
    } catch (error) {
      message = (error as Error).message;
    }

    // biome-ignore lint/suspicious/noControlCharactersInRegex: their absence is the point
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(hintCommands(odd)[0]).toBe(
      'git -C / config --file <repo>/.git/config --unset-all extensions.worktreeConfig',
    );
    expect(message).toContain('with <repo> typed by hand');
  });

  it.each(['true', 'maybe'])(
    'quotes a repo path a shell would split, so the pasted unset runs alone (%s)',
    (value) => {
      const parent = tempDir('pup-diff-');
      const odd = join(parent, 'a b; $(touch pwned) repo');
      mkdirSync(odd);
      sh(odd, 'git', 'init', '-q', '-b', 'main');
      setExtension(odd, value);
      const unset = hintCommands(odd).find((command) => command.startsWith('git -C / config'));

      paste(parent, unset as string);
      expect(existsSync(join(parent, 'pwned'))).toBe(false);
      expect(() => assertNoWorktreeConfig(odd)).not.toThrow();
    },
  );

  // Under a gitfile, `<repo>/.git/config` names nothing: the check would read
  // no config and pass, and the pins built from the same path would be refused
  // only once the row and the worktree exist (decision 101).
  it('refuses a repo whose .git is a gitfile, as a linked worktree has', () => {
    const linked = join(repo, '.worktrees', 'linked');
    sh(repo, 'git', 'worktree', 'add', '-q', '--detach', linked);

    expect(() => assertNoWorktreeConfig(linked)).toThrow(
      /its \.git is not a directory\. pup pins a session to the repository at <repo>\/\.git/,
    );
    expect(() => assertNoWorktreeConfig(repo)).not.toThrow();
  });
});

/** A sha in `repo`, read with plain git. */
function revParse(repo: string, rev: string): string {
  return execFileSync('git', ['rev-parse', rev], {
    cwd: repo,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim();
}

// Replace refs, `info/grafts` and the commit-graph all sit in the shared
// `$GIT_COMMON_DIR`, untracked, and each changes what a sha reads as for every
// git that consults it. The gate reads the pinned commit through `runGit`, so
// each forgery must leave `runGit` reading the commits as they are (decision 89).
describe('history a session can rewrite in the shared git dir (decision 89)', () => {
  /**
   * main: base, m; feature: base, x, y. Re-parenting `m` onto `x` moves the
   * merge-base to `x`, so the branch diff would hide x.ts.
   */
  function forkedRepo(): { repo: string; mainTip: string; firstOnFeature: string } {
    const repo = makeRepo();
    writeFileSync(join(repo, 'base.ts'), 'base\n');
    commitAll(repo, 'base');
    sh(repo, 'git', 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'x.ts'), 'x\n');
    commitAll(repo, 'x');
    const firstOnFeature = revParse(repo, 'HEAD');
    writeFileSync(join(repo, 'y.ts'), 'y\n');
    commitAll(repo, 'y');
    sh(repo, 'git', 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'm.ts'), 'm\n');
    commitAll(repo, 'm');
    return { repo, mainTip: revParse(repo, 'HEAD'), firstOnFeature };
  }

  /** The branch diff as a plain git reads it: the control that shows the forgery is live. */
  function plainDiffPaths(repo: string): string[] {
    return execFileSync('git', ['diff', '--name-only', 'main...feature'], {
      cwd: repo,
      encoding: 'utf8',
      env: GIT_ENV,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  }

  it('reads the commits a replace ref stands in for', () => {
    const { repo, mainTip, firstOnFeature } = forkedRepo();
    sh(repo, 'git', 'replace', '--graft', mainTip, firstOnFeature);

    expect(plainDiffPaths(repo)).toEqual(['y.ts']);
    expect(gitDiffPaths(repo, 'main', 'feature')).toEqual(['x.ts', 'y.ts']);
    expect(runGit(repo, ['rev-parse', 'main']).trim()).toBe(mainTip);
    expect(runGit(repo, ['log', '--format=%s', 'main']).split('\n').filter(Boolean)).toEqual([
      'm',
      'base',
    ]);
  });

  it('reads the parents a graft rewrites', () => {
    const { repo, mainTip, firstOnFeature } = forkedRepo();
    writeFileSync(join(repo, '.git', 'info', 'grafts'), `${mainTip} ${firstOnFeature}\n`);

    expect(plainDiffPaths(repo)).toEqual(['y.ts']);
    expect(gitDiffPaths(repo, 'main', 'feature')).toEqual(['x.ts', 'y.ts']);
  });

  it('reads the tree a forged commit-graph names in place of the tip’s own', () => {
    const { repo } = forkedRepo();
    sh(repo, 'git', 'commit-graph', 'write', '--reachable');
    const graph = join(repo, '.git', 'objects', 'info', 'commit-graph');
    const tipTree = Buffer.from(revParse(repo, 'feature^{tree}'), 'hex');
    const baseTree = Buffer.from(revParse(repo, 'main~1^{tree}'), 'hex');
    const bytes = readFileSync(graph);
    const at = bytes.indexOf(tipTree);
    expect(at).toBeGreaterThan(-1);
    baseTree.copy(bytes, at);
    unlinkSync(graph);
    writeFileSync(graph, bytes);

    // A three-dot diff happens to load the tip from its object; a log or a
    // two-dot diff from the merge-base takes the tree from the graph.
    const plainTree = execFileSync('git', ['log', '-1', '--format=%T', 'feature'], {
      cwd: repo,
      encoding: 'utf8',
      env: GIT_ENV,
    }).trim();
    expect(plainTree).toBe(baseTree.toString('hex'));
    expect(runGit(repo, ['log', '-1', '--format=%T', 'feature']).trim()).toBe(
      tipTree.toString('hex'),
    );
    expect(runGit(repo, ['diff', '--name-only', 'main~1', 'feature']).split('\n')).toEqual([
      'x.ts',
      'y.ts',
      '',
    ]);
  });
});

// Each of these arms a driver no listing of the file as it stands would show,
// or names one under a subsection the old pattern required to be non-empty.
describe('armedGitDrivers: includes and empty driver names (decision 89)', () => {
  function repoWithCommit(): string {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    commitAll(repo, 'base');
    return repo;
  }

  // The file is refused whatever it holds now: a session can fill it after the check.
  it('names a local include.path, not reading the file it names', () => {
    const repo = repoWithCommit();
    const included = join(tempDir('pup-include-'), 'config');
    writeFileSync(included, '[filter "pwn"]\n\tsmudge = /usr/bin/true\n');
    sh(repo, 'git', 'config', 'include.path', included);

    expect(armedGitDrivers(repo)).toEqual(['include.path']);
    expect(() => assertNoArmedGitDrivers(repo)).toThrow(
      /a config include could arm one.*include\.path/,
    );
  });

  // False where the check runs, true on the branch the rebase checks out.
  it('names an includeIf, whatever its condition reads here', () => {
    const repo = repoWithCommit();
    const included = join(tempDir('pup-include-'), 'config');
    writeFileSync(included, '[merge "pwn"]\n\tdriver = /usr/bin/true %A %O %B\n');
    sh(repo, 'git', 'config', 'includeIf.onbranch:feature.path', included);

    expect(armedGitDrivers(repo)).toEqual(['includeif.onbranch:feature.path']);
  });

  it.each(['filter..smudge', 'filter..clean', 'filter..process', 'merge..driver'])(
    'names %s, a driver whose name is empty',
    (key) => {
      const repo = repoWithCommit();
      sh(repo, 'git', 'config', key, '/usr/bin/true');

      expect(armedGitDrivers(repo)).toEqual([key]);
    },
  );
});

// The open-PR merge re-runs the check under the merge lock; a fifo read with a
// plain open blocks node where no handled signal reaches it (decision 50, as
// amended by 89).
describe('armedGitDrivers: an info/attributes that is not a regular file', () => {
  function attributesPath(): { repo: string; attributes: string } {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    commitAll(repo, 'base');
    return { repo, attributes: join(repo, '.git', 'info', 'attributes') };
  }

  const REFUSED = 'info/attributes (not a regular file of 1 MiB or less)';

  it('refuses a fifo at once rather than block on it', () => {
    const { repo, attributes } = attributesPath();
    sh(repo, 'mkfifo', attributes);
    // Opens the fifo for writing after a while, so a blocking read returns
    // empty and fails this test rather than hang the run.
    const writer = spawn('sh', ['-c', 'sleep 3; : > "$0"', attributes], { stdio: 'ignore' });
    try {
      const started = Date.now();
      expect(armedGitDrivers(repo)).toEqual([REFUSED]);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      writer.kill('SIGKILL');
    }
  });

  it('refuses a symlink rather than follow it', () => {
    const { repo, attributes } = attributesPath();
    const target = join(tempDir('pup-attributes-'), 'attributes');
    writeFileSync(target, '# inert where it points\n');
    symlinkSync(target, attributes);

    expect(armedGitDrivers(repo)).toEqual([REFUSED]);
  });

  it('refuses a directory', () => {
    const { repo, attributes } = attributesPath();
    mkdirSync(attributes);

    expect(armedGitDrivers(repo)).toEqual([REFUSED]);
  });

  it('reads a regular file as before, and none at all as nothing armed', () => {
    const { repo, attributes } = attributesPath();
    expect(armedGitDrivers(repo)).toEqual([]);

    writeFileSync(attributes, '# a comment\n*.ts diff\n');
    expect(armedGitDrivers(repo)).toEqual(['info/attributes (*.ts diff)']);
  });
});

// The known-binary decision behind `gitDiffBinaryRecount`, without git
// (known-binary.utils.ts, decision 154).
describe('known-binary.utils', () => {
  /** A PNG's signature and IHDR length, then `rest`: binary by NUL and by magic. */
  const png = (rest: string): Buffer =>
    Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n\0\0\0\rIHDR', 'latin1'), Buffer.from(rest)]);
  const pngFormats = formatsNamed('image.png');

  describe('formatsNamed', () => {
    it('names a format by its extension in any ASCII case', () => {
      expect(formatsNamed('a/image.png')).toHaveLength(1);
      expect(formatsNamed('icon.ICO')).toHaveLength(1);
      expect(formatsNamed('photo.JpEg')).toEqual(formatsNamed('photo.jpg'));
    });

    // `toLowerCase` folds the Kelvin sign U+212A to `k`.
    it('names nothing for an extension spelled with a non-ASCII case fold', () => {
      expect(formatsNamed('clip.mkv')).toHaveLength(1);
      expect(formatsNamed('clip.mKv')).toEqual([]);
    });

    it('names nothing for a path no format is committed under', () => {
      expect(formatsNamed('a.ts')).toEqual([]);
      expect(formatsNamed('anim.gif')).toEqual([]);
      expect(formatsNamed('png')).toEqual([]);
    });
  });

  // A same-oid rename skips only under one extension as written, so this is
  // what the recount compares, and what `formatsNamed` folds.
  describe('extensionOf', () => {
    it('reads the basename from its last dot as written, or nothing', () => {
      expect(extensionOf('docs/guide/Manual.PDF')).toBe('.PDF');
      expect(extensionOf('a.tar.GZ')).toBe('.GZ');
      expect(extensionOf('assets/.png')).toBe('.png');
      expect(extensionOf('b.php.')).toBe('.');
      expect(extensionOf('v1.2/Makefile')).toBe('');
      expect(extensionOf('clip.mKv')).toBe('.mKv');
      expect(formatsNamed('assets/.png')).toEqual(pngFormats);
    });
  });

  describe('mayBeKnownBinary', () => {
    it('admits a non-executable regular file up to the cap', () => {
      expect(mayBeKnownBinary('100644', BINARY_FREE_MAX_BYTES)).toBe(true);
    });

    it('refuses an executable, a symlink, a gitlink, no mode and a file past the cap', () => {
      expect(mayBeKnownBinary('100755', 0)).toBe(false);
      expect(mayBeKnownBinary('120000', 10)).toBe(false);
      expect(mayBeKnownBinary('160000', 10)).toBe(false);
      expect(mayBeKnownBinary('', 10)).toBe(false);
      expect(mayBeKnownBinary('100644', BINARY_FREE_MAX_BYTES + 1)).toBe(false);
    });

    // `ls-tree` lists `BAD` for an object it cannot read; the read must go
    // ahead so `readBlobs` throws, not answer "not binary" and recount quietly.
    it('admits a size that is no number, so the read refuses it', () => {
      expect(mayBeKnownBinary('100644', Number('BAD'))).toBe(true);
    });
  });

  describe('knownBinarySize', () => {
    it('answers the size of a blob opening with a named magic and holding a NUL', () => {
      const blob = png('q\n');
      expect(knownBinarySize(blob, pngFormats)).toBe(blob.length);
    });

    it('answers false without a NUL in the first 8000 bytes', () => {
      const magic = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');
      expect(knownBinarySize(Buffer.concat([magic, Buffer.from('x\n')]), pngFormats)).toBe(false);
      const late = Buffer.concat([magic, Buffer.from(`${'a'.repeat(8000)}\0`)]);
      expect(knownBinarySize(late, pngFormats)).toBe(false);
    });

    it('answers false for a magic the formats do not name', () => {
      expect(knownBinarySize(png('q\n'), formatsNamed('photo.jpg'))).toBe(false);
      expect(knownBinarySize(Buffer.from('GIF89a\0\n'), pngFormats)).toBe(false);
      expect(knownBinarySize(png('q\n'), [])).toBe(false);
    });

    // A Zip64-aware zipimport searches past the classic 64 KiB plus 22 bytes.
    it('answers false for a zip end record anywhere in the blob', () => {
      const endRecord = `PK\x05\x06${'\0'.repeat(18)}`;
      expect(knownBinarySize(png(`\n${endRecord}`), pngFormats)).toBe(false);
      const far = png(`${endRecord}${'x'.repeat(256 * 1024)}`);
      expect(knownBinarySize(far, pngFormats)).toBe(false);
    });

    // `phar://` finds an archive by its stub's end after any leading bytes,
    // and PHP reads the token in any case.
    it('answers false for a phar stub anywhere in the blob, in any case', () => {
      expect(knownBinarySize(png('<?php __HALT_COMPILER(); ?>\n'), pngFormats)).toBe(false);
      expect(knownBinarySize(png(`${'x'.repeat(65536)}__halt_Compiler();`), pngFormats)).toBe(
        false,
      );
      expect(knownBinarySize(png('__HALT_COMPILE\n'), pngFormats)).toBe(
        png('__HALT_COMPILE\n').length,
      );
    });

    // A streaming zip reader walks local headers, not the end record.
    it('answers false for a zip local file header anywhere in the blob', () => {
      expect(knownBinarySize(png(`${'x'.repeat(4096)}PK\x03\x04\n`), pngFormats)).toBe(false);
    });

    /**
     * A PNG whose first 512 bytes are a tar header: the signature and IHDR,
     * then a chunk's worth of filler with high bytes, so signed and unsigned
     * sums differ, and the checksum field holding the sum plus `off`.
     */
    function tarPolyglot(signed: boolean, off = 0): Buffer {
      const header = Buffer.alloc(512, 'A');
      png('').copy(header, 0);
      header.fill(0xc8, 200, 260);
      header.fill(' ', 148, 156);
      let sum = 0;
      for (const byte of header) sum += signed && byte > 0x7f ? byte - 0x100 : byte;
      Buffer.from(`${(sum + off).toString(8).padStart(6, '0')}\0 `, 'latin1').copy(header, 148);
      return Buffer.concat([header, Buffer.from('<?php echo 1;\n')]);
    }

    // PHP opens a file whose first 512 bytes pass the checksum as a tar phar,
    // with no stub and no zip record to find.
    it('answers false for a blob opening with a tar header, by unsigned or signed sum', () => {
      expect(knownBinarySize(tarPolyglot(false), pngFormats)).toBe(false);
      expect(knownBinarySize(tarPolyglot(true), pngFormats)).toBe(false);
      const missed = tarPolyglot(false, 1);
      expect(knownBinarySize(missed, pngFormats)).toBe(missed.length);
    });
  });

  describe('spendKnownBinarySkip', () => {
    it('skips when every side that exists is known, spending the branch side', () => {
      const budget = { bytes: 100 };
      expect(spendKnownBinarySkip([40, 30], budget)).toBe(true);
      expect(budget.bytes).toBe(70);
      expect(spendKnownBinarySkip([undefined, 70], budget)).toBe(true);
      expect(budget.bytes).toBe(0);
    });

    it('spends nothing for a side the branch deleted', () => {
      const budget = { bytes: 0 };
      expect(spendKnownBinarySkip([40, undefined], budget)).toBe(true);
      expect(budget.bytes).toBe(0);
    });

    it('does not skip when a side is not known or no side exists', () => {
      const budget = { bytes: 100 };
      expect(spendKnownBinarySkip([false, 10], budget)).toBe(false);
      expect(spendKnownBinarySkip([10, false], budget)).toBe(false);
      expect(spendKnownBinarySkip([false], budget)).toBe(false);
      expect(spendKnownBinarySkip([undefined, undefined], budget)).toBe(false);
      expect(budget.bytes).toBe(100);
    });

    it('does not skip, or spend, past the budget', () => {
      const budget = { bytes: 10 };
      expect(spendKnownBinarySkip([undefined, 11], budget)).toBe(false);
      expect(budget.bytes).toBe(10);
      expect(spendKnownBinarySkip([undefined, 10], budget)).toBe(true);
      expect(budget.bytes).toBe(0);
    });
  });
});

// A session can write the main checkout's `.git`. git follows a `commondir`
// planted in it under `-C`, `--git-dir` and `GIT_COMMON_DIR`, and a `.git`
// swapped for a gitfile or a symlink names another repo outright, so each hands
// every ref read to a decoy (decision 172).
describe("a main checkout's .git a session rewrote (decision 172)", () => {
  /**
   * `repo` with a commit on main, and a bare decoy that borrows its objects and
   * whose main names another commit. `objects` is where the real objects are,
   * so a test that moves the real git dir aside points the decoy there.
   */
  function repoAndDecoy(objects?: string): { repo: string; decoy: string; realMain: string } {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'a\n');
    commitAll(repo, 'a');
    const realMain = revParse(repo, 'refs/heads/main');
    const decoy = join(tempDir('pup-decoy-'), 'decoy.git');
    sh(dirname(decoy), 'git', 'init', '-q', '--bare', '-b', 'main', decoy);
    writeFileSync(
      join(decoy, 'objects', 'info', 'alternates'),
      `${objects ?? join(repo, '.git', 'objects')}\n`,
    );
    const own = execFileSync(
      'git',
      [
        '-c',
        'user.name=d',
        '-c',
        'user.email=d@test',
        'commit-tree',
        '-m',
        'decoy',
        `${realMain}^{tree}`,
      ],
      { cwd: decoy, encoding: 'utf8', env: GIT_ENV },
    ).trim();
    sh(decoy, 'git', 'update-ref', 'refs/heads/main', own);
    return { repo, decoy, realMain };
  }

  /** Moves the real git dir aside and points the decoy's alternates at its objects. */
  function swapGitDir(repo: string, decoy: string): void {
    const aside = join(tempDir('pup-aside-'), 'git');
    renameSync(join(repo, '.git'), aside);
    writeFileSync(join(decoy, 'objects', 'info', 'alternates'), `${join(aside, 'objects')}\n`);
  }

  const plants: Record<string, (commondir: string, decoy: string) => void> = {
    'a file': (commondir, decoy) => writeFileSync(commondir, `${decoy}\n`),
    'a symlink': (commondir, decoy) => {
      const pointer = join(tempDir('pup-pointer-'), 'commondir');
      writeFileSync(pointer, `${decoy}\n`);
      symlinkSync(pointer, commondir);
    },
    'a dangling symlink': (commondir) => symlinkSync('/nonexistent/commondir', commondir),
    'a directory': (commondir) => mkdirSync(commondir),
  };

  it.each(Object.keys(plants))('refuses every git call while its commondir is %s', (kind) => {
    const { repo, decoy, realMain } = repoAndDecoy();
    const commondir = join(repo, '.git', 'commondir');
    plants[kind]?.(commondir, decoy);

    expect(() => runGit(repo, ['rev-parse', 'refs/heads/main'])).toThrow(
      /\.git\/commondir exists.*decision 172/s,
    );
    expect(() => gitDiffPaths(repo, 'main', 'main')).toThrow(/\.git\/commondir exists/);
    expect(() => currentBranch(repo)).toThrow(/\.git\/commondir exists/);
    expect(() => assertMainCheckout(repo)).toThrow(/\.git\/commondir exists/);

    rmSync(commondir, { recursive: true });
    expect(runGit(repo, ['rev-parse', 'refs/heads/main']).trim()).toBe(realMain);
  });

  it('is live: plain git reads the decoy refs the check refuses', () => {
    const { repo, decoy, realMain } = repoAndDecoy();
    writeFileSync(join(repo, '.git', 'commondir'), `${decoy}\n`);

    expect(revParse(repo, 'refs/heads/main')).not.toBe(realMain);
    expect(revParse(repo, 'refs/heads/main')).toBe(revParse(decoy, 'refs/heads/main'));
  });

  it('refuses a .git swapped for a gitfile naming a decoy, at a main checkout it passed', () => {
    const { repo, decoy, realMain } = repoAndDecoy();
    assertMainCheckout(repo);
    swapGitDir(repo, decoy);
    writeFileSync(join(repo, '.git'), `gitdir: ${decoy}\n`);
    // The control: plain git now reads the decoy's main.
    expect(revParse(repo, 'refs/heads/main')).not.toBe(realMain);

    expect(() => runGit(repo, ['rev-parse', 'refs/heads/main'])).toThrow(
      /\.git is no longer a directory.*decision 172/s,
    );
    expect(() => currentBranch(repo)).toThrow(/\.git is no longer a directory/);
    expect(() => assertMainCheckout(repo)).toThrow(/\.git is not a directory/);
  });

  it('refuses a .git swapped for a symlink to a decoy, on every spawn and as a main checkout', () => {
    const { repo, decoy, realMain } = repoAndDecoy();
    swapGitDir(repo, decoy);
    symlinkSync(decoy, join(repo, '.git'));
    // The decoy has no commondir: only the link itself gives it away.
    expect(revParse(repo, 'refs/heads/main')).not.toBe(realMain);

    expect(() => runGit(repo, ['rev-parse', 'refs/heads/main'])).toThrow(
      /\.git is a symlink.*decision 172/s,
    );
    expect(() => gitDiffPaths(repo, 'main', 'main')).toThrow(/\.git is a symlink/);
    expect(() => assertMainCheckout(repo)).toThrow(/\.git is not a directory/);
  });

  it('runs git in a linked worktree, whose .git is a gitfile, but never takes it for a main checkout', () => {
    const { repo, realMain } = repoAndDecoy();
    const worktree = join(tempDir('pup-wt-'), 'wt');
    sh(repo, 'git', 'worktree', 'add', '-q', '--detach', worktree);

    expect(runGit(worktree, ['rev-parse', 'HEAD']).trim()).toBe(realMain);
    expect(() => assertMainCheckout(repo)).not.toThrow();
    expect(() => assertMainCheckout(worktree)).toThrow(/\.git is not a directory/);
    expect(runGit(worktree, ['rev-parse', 'HEAD']).trim()).toBe(realMain);
  });

  it.each([
    ['a trailing slash', (repo: string) => `${repo}/`],
    [
      'a symlink to it',
      (repo: string) => {
        const link = join(tempDir('pup-link-'), 'repo');
        symlinkSync(repo, link);
        return link;
      },
    ],
  ])('holds a main checkout passed through %s, under its real path', (_, spelling) => {
    const { repo, decoy } = repoAndDecoy();
    assertMainCheckout(spelling(repo));
    swapGitDir(repo, decoy);
    writeFileSync(join(repo, '.git'), `gitdir: ${decoy}\n`);

    expect(() => runGit(join(repo, '.'), ['rev-parse', 'HEAD'])).toThrow(
      /\.git is no longer a directory/,
    );
  });

  it('names a .git directory to git outright, and leaves a gitfile to git', () => {
    const { repo } = repoAndDecoy();
    const worktree = join(tempDir('pup-wt-'), 'wt');
    sh(repo, 'git', 'worktree', 'add', '-q', '--detach', worktree);

    // Discovered from the root, git would print `.git`.
    expect(runGit(repo, ['rev-parse', '--git-dir']).trim()).toBe(join(repo, '.git'));
    expect(runGit(repo, ['rev-parse', '--show-toplevel']).trim()).toBe(realpathSync(repo));
    expect(runGit(worktree, ['rev-parse', '--git-dir']).trim()).toBe(
      join(realpathSync(repo), '.git', 'worktrees', 'wt'),
    );
  });

  /**
   * A minimal git dir at `dotGit`: HEAD on main, empty `refs/`, the objects at
   * `objects` borrowed, and a packed-refs naming `main` at `own`. Every check
   * but the identity passes it.
   */
  function plantDecoyGitDir(dotGit: string, objects: string, own: string): void {
    mkdirSync(join(dotGit, 'refs', 'heads'), { recursive: true });
    mkdirSync(join(dotGit, 'objects', 'info'), { recursive: true });
    writeFileSync(join(dotGit, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dotGit, 'objects', 'info', 'alternates'), `${objects}\n`);
    writeFileSync(join(dotGit, 'packed-refs'), `${own} refs/heads/main\n`);
  }

  it('refuses a .git swapped for a decoy directory, at a main checkout it passed', () => {
    const { repo, decoy, realMain } = repoAndDecoy();
    const own = revParse(decoy, 'refs/heads/main');
    expect(runGit(repo, ['rev-parse', 'refs/heads/main']).trim()).toBe(realMain);
    assertMainCheckout(repo);
    const aside = join(tempDir('pup-aside-'), 'git');
    renameSync(join(repo, '.git'), aside);
    plantDecoyGitDir(join(repo, '.git'), join(aside, 'objects'), own);
    // The control: plain git, and a check that knows no identity, take the decoy.
    expect(revParse(repo, 'refs/heads/main')).toBe(own);
    const elsewhere = join(tempDir('pup-copy-'), 'repo');
    mkdirSync(elsewhere);
    plantDecoyGitDir(join(elsewhere, '.git'), join(aside, 'objects'), own);
    expect(runGit(elsewhere, ['rev-parse', 'refs/heads/main']).trim()).toBe(own);

    expect(() => runGit(repo, ['rev-parse', 'refs/heads/main'])).toThrow(
      /\.git or its objects\/ is not the directory pup found there first.*decision 172/s,
    );
    expect(() => assertMainCheckout(repo)).toThrow(RewrittenGitDirError);
  });

  it('refuses a .git whose objects/ was swapped for another, at a main checkout it passed', () => {
    const { repo } = repoAndDecoy();
    assertMainCheckout(repo);
    const objects = join(repo, '.git', 'objects');
    const aside = join(tempDir('pup-aside-'), 'objects');
    renameSync(objects, aside);
    mkdirSync(join(objects, 'info'), { recursive: true });
    writeFileSync(join(objects, 'info', 'alternates'), `${aside}\n`);

    expect(() => runGit(repo, ['rev-parse', 'HEAD'])).toThrow(
      /is not the directory pup found there first/,
    );
    // Put back: the identity is the real directory's, so git runs again.
    rmSync(objects, { recursive: true });
    renameSync(aside, objects);
    expect(() => runGit(repo, ['rev-parse', 'HEAD'])).not.toThrow();
  });

  it("keeps a pinned worktree's GIT_DIR, and refuses its .git turned into a directory", () => {
    const { repo, decoy } = repoAndDecoy();
    const own = revParse(decoy, 'refs/heads/main');
    const worktree = join(tempDir('pup-wt-'), 'wt');
    sh(repo, 'git', 'worktree', 'add', '-q', '--detach', worktree);
    const env = { ...verifiedWorktreeGitEnv(realpathSync(repo), realpathSync(worktree)) };
    // Pinned, git reads the admin dir pup verified, not one pup named over it.
    expect(runGit(worktree, ['rev-parse', '--git-dir'], { env }).trim()).toBe(env.GIT_DIR);

    rmSync(join(worktree, '.git'));
    plantDecoyGitDir(join(worktree, '.git'), join(repo, '.git', 'objects'), own);
    // The control: a --git-dir naming the new directory outranks the pinned GIT_DIR.
    const named = join(worktree, '.git');
    expect(
      execFileSync('git', ['-C', worktree, `--git-dir=${named}`, 'rev-parse', '--git-dir'], {
        encoding: 'utf8',
        env: { ...GIT_ENV, ...env },
      }).trim(),
    ).toBe(named);

    expect(() => runGit(worktree, ['rev-parse', '--git-dir'], { env })).toThrow(
      /\.git is a directory other than the GIT_DIR this git is pinned to.*decision 172/s,
    );
  });

  /**
   * The checkout's own root made a bare repo whose main names a commit of the
   * session's, borrowing the real objects: git's discovery falls back to it
   * once `.git` is not a repo it would use. Returns the decoy commit.
   */
  function plantBareCheckout(repo: string, realMain: string): string {
    const own = execFileSync(
      'git',
      [
        '-c',
        'user.name=d',
        '-c',
        'user.email=d@test',
        'commit-tree',
        '-m',
        'decoy',
        `${realMain}^{tree}`,
      ],
      { cwd: repo, encoding: 'utf8', env: GIT_ENV },
    ).trim();
    writeFileSync(join(repo, 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(repo, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(repo, 'refs', 'heads', 'main'), `${own}\n`);
    mkdirSync(join(repo, 'objects', 'info'), { recursive: true });
    writeFileSync(
      join(repo, 'objects', 'info', 'alternates'),
      `${join(repo, '.git', 'objects')}\n`,
    );
    return own;
  }

  const breaks: Record<string, (dotGit: string) => void> = {
    'a junk HEAD': (dotGit) => writeFileSync(join(dotGit, 'HEAD'), 'ref: x\n'),
    'no HEAD': (dotGit) => rmSync(join(dotGit, 'HEAD')),
    'an unreadable HEAD': (dotGit) => chmodSync(join(dotGit, 'HEAD'), 0o200),
    'no refs/': (dotGit) => renameSync(join(dotGit, 'refs'), join(tempDir('pup-refs-'), 'refs')),
    // `chmod a-x`: still a directory, with HEAD valid, but one git cannot search.
    'a refs/ git cannot search': (dotGit) => chmodSync(join(dotGit, 'refs'), 0o644),
  };

  it.each(Object.keys(breaks))(
    'refuses a .git with %s, which would make git read the checkout as a bare decoy',
    (kind) => {
      const { repo, realMain } = repoAndDecoy();
      const own = plantBareCheckout(repo, realMain);
      breaks[kind]?.(join(repo, '.git'));
      // The control: plain git, at its default `safe.bareRepository=all`, reads the decoy.
      expect(revParse(repo, 'refs/heads/main')).toBe(own);

      expect(() => runGit(repo, ['rev-parse', 'refs/heads/main'])).toThrow(
        /\.git is not a repo git would use.*decision 172/s,
      );
      expect(() => assertMainCheckout(repo)).toThrow(RewrittenGitDirError);
      // Put back, so the temp dir can be removed.
      if (existsSync(join(repo, '.git', 'refs'))) chmodSync(join(repo, '.git', 'refs'), 0o755);
    },
  );

  it('pins safe.bareRepository=explicit, so pinned git refuses the fallback on its own', () => {
    const { repo, realMain } = repoAndDecoy();
    plantBareCheckout(repo, realMain);
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: x\n');

    expect(() =>
      execFileSync('git', [...GIT_SAFE_CONFIG, '-C', repo, 'rev-parse', 'refs/heads/main'], {
        encoding: 'utf8',
        env: GIT_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow(/cannot use bare repository/);
  });
});

/**
 * Every use of a `child_process` binding in `source`, in source order, with the
 * function that builds a call's argv: undefined for a call whose argv no
 * function builds, a use that is not a call, and a `require` or dynamic import
 * of the module, which no import list names. Whatever the binary: a literal
 * path, a variable and an aliased or namespace import all count.
 */
function childProcessUses(source: string): (string | undefined)[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fromModule = /import\s+([^;]*?)\s+from\s+['"](?:node:)?child_process['"];?/g;
  const names: string[] = [];
  for (const [, clause = ''] of code.matchAll(fromModule)) {
    if (clause.startsWith('type ')) continue;
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? '';
    for (const spec of named.split(',').map((part) => part.trim())) {
      if (spec && !spec.startsWith('type ')) names.push(spec.split(/\s+as\s+/).at(-1) as string);
    }
    // A namespace or default binding: `* as cp`, `cp`.
    const whole = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/[*,]|\bas\b/g, ' ')
      .trim();
    if (whole) names.push(...whole.split(/\s+/));
  }
  const body = code.replace(fromModule, '');
  const uses: { at: number; builder: string | undefined }[] = [];
  for (const name of names) {
    for (const match of body.matchAll(new RegExp(`(?<![.\\w$])${name}(?:\\.\\w+)?\\b`, 'g'))) {
      const call = /\s*\(\s*[^,()]+,\s*(\w+)\(/y;
      call.lastIndex = match.index + match[0].length;
      uses.push({ at: match.index, builder: call.exec(body)?.[1] });
    }
  }
  for (const match of body.matchAll(/\b(?:require|import)\(\s*['"`](?:node:)?child_process/g)) {
    uses.push({ at: match.index, builder: undefined });
  }
  return uses.sort((a, b) => a.at - b.at).map((use) => use.builder);
}

describe('the .git check on every git spawn (decision 172)', () => {
  it('is what every child_process call in git-diff.client.ts builds its argv through', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'core', 'git-diff.client.ts'), 'utf8');
    const safeArgv = /function safeArgv\([^)]*\)[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? '';

    expect(childProcessUses(source).length).toBeGreaterThan(0);
    expect(childProcessUses(source).every((builder) => builder === 'safeArgv')).toBe(true);
    expect(safeArgv).toMatch(/^\s*const gitDir = assertGitDirUnplanted\(cwd, env\.GIT_DIR\);/);
  });

  it('flags any child_process use whose argv safeArgv does not build, whatever the binary', () => {
    const source = [
      `import { execFileSync, spawn as run, type ExecFileSyncOptions } from 'node:child_process';`,
      `import * as cp from 'child_process';`,
      `execFileSync('git', safeArgv(cwd, args), {});`,
      `execFileSync('/usr/bin/git', ['rev-parse', 'HEAD']);`,
      `const bin = 'git'; run(bin, safeArgv(cwd, args));`,
      `run(bin, args);`,
      `cp.spawnSync(gitPath, otherArgv(cwd));`,
      `const alias = execFileSync;`,
      `// execFileSync in a comment is no use`,
      `const options: ExecFileSyncOptions = {};`,
      `const legacy = require('node:child_process');`,
    ].join('\n');

    expect(childProcessUses(source)).toEqual([
      'safeArgv',
      undefined,
      'safeArgv',
      undefined,
      'otherArgv',
      undefined,
      undefined,
    ]);
  });
});
