import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';
import {
  ArmedGitDriverError,
  armedGitDrivers,
  assertNoArmedGitDrivers,
  assertNoWorktreeConfig,
  BINARY_FREE_MAX_BYTES,
  BINARY_FREE_TOTAL_MAX_BYTES,
  currentBranch,
  gitDiffAddedLines,
  gitDiffBinaryRecount,
  gitDiffNumstat,
  gitDiffPaths,
  readBlobs,
  rethrowIfKilled,
  runGit,
  verifiedWorktreeGitEnv,
  WorktreeConfigError,
  WorktreeRepointedError,
  worktreeGitEnv,
} from './git-diff.client.js';
import {
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
    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', ':(top)foo', fullBudget(), undefined),
    ).toEqual({
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

    expect(gitDiffBinaryRecount(repo, 'main', 'feature', nfd, fullBudget(), undefined)).toEqual({
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

    expect(gitDiffNumstat(repo, 'main', 'feature')).toEqual([
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
function fullBudget(): { bytes: number } {
  return { bytes: BINARY_FREE_TOTAL_MAX_BYTES };
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

    expect(gitDiffNumstat(repo, 'main', 'feature')).toEqual([
      { path: 'a.ts', added: null, deleted: null },
    ]);
    expect(gitDiffBinaryRecount(repo, 'main', 'feature', 'a.ts', fullBudget(), undefined)).toEqual({
      added: 3,
      deleted: 2,
    });
  });

  it('recounts a new text file under core.attributesFile', () => {
    const repo = repoWith({ 'a.ts': 'one\n' }, { 'fresh.ts': 'one\ntwo\n' });
    const attributes = join(repo, '.git', 'forged-attributes');
    writeFileSync(attributes, '* binary\n');
    sh(repo, 'git', 'config', 'core.attributesFile', attributes);

    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', 'fresh.ts', fullBudget(), undefined),
    ).toEqual({
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
      expect(
        gitDiffBinaryRecount(repo, 'main', 'feature', path, fullBudget(), undefined),
      ).toBeNull();
    }

    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -diff\n');

    for (const path of paths) {
      expect(
        gitDiffBinaryRecount(repo, 'main', 'feature', path, fullBudget(), undefined),
      ).toBeNull();
    }
  });

  // One NUL in a comment makes git call a 5 000-line source file binary, and
  // a null skipped for it counted the file as no lines at all (decision 154).
  it('recounts a source file with a NUL in its first 8000 bytes', () => {
    const source = `// \0\n${'export const v = 1;\n'.repeat(5000)}`;
    const repo = repoWith({ 'a.ts': 'one\n' }, { 'a.ts': source, 'fresh.js': source });

    expect(gitDiffNumstat(repo, 'main', 'feature')).toEqual([
      { path: 'a.ts', added: null, deleted: null },
      { path: 'fresh.js', added: null, deleted: null },
    ]);
    expect(gitDiffBinaryRecount(repo, 'main', 'feature', 'a.ts', fullBudget(), undefined)).toEqual({
      added: 5001,
      deleted: 1,
    });
    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', 'fresh.js', fullBudget(), undefined),
    ).toEqual({
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
      { path: 'a.png', added: null, deleted: null, renamedFrom: 'auth.ts' },
    ]);
    // The signature's CR and LF split auth.ts's first line into three.
    expect(gitDiffBinaryRecount(repo, 'main', 'feature', 'a.png', fullBudget(), 'auth.ts')).toEqual(
      { added: 3, deleted: 1 },
    );
  });

  it('skips a known binary renamed from a known binary', () => {
    const repo = repoWith({ 'old.png': png('a\nb\nc\nd\n') }, { 'new.png': png('a\nb\nc\nD\n') });
    sh(repo, 'git', 'rm', '-q', 'old.png');
    sh(repo, 'git', 'commit', '-q', '-m', 'rename');

    expect(gitDiffNumstat(repo, 'main', 'feature')).toEqual([
      { path: 'new.png', added: null, deleted: null, renamedFrom: 'old.png' },
    ]);
    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', 'new.png', fullBudget(), 'old.png'),
    ).toBeNull();
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
    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', 'swapped.png', fullBudget(), undefined),
    ).toEqual({
      added: 2,
      deleted: 3,
    });
    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', 'text.png', fullBudget(), undefined),
    ).toEqual({
      added: 2,
      deleted: 1,
    });
    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', 'code.js', fullBudget(), undefined),
    ).toEqual({
      added: 4,
      deleted: 0,
    });
    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', 'gif.png', fullBudget(), undefined),
    ).toEqual({
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
      expect(gitDiffBinaryRecount(repo, 'main', 'feature', path, fullBudget(), undefined)).toEqual({
        added: 4,
        deleted: 0,
      });
    }
    // The signature's CR and LF make three lines, then the IHDR line and the filler.
    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', 'big.png', fullBudget(), undefined),
    ).toEqual({
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

    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', 'zipped.png', fullBudget(), undefined),
    ).toEqual({
      added: 4,
      deleted: 0,
    });
    // The signature's CR and LF make three lines; the record ends the third.
    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', 'far.png', fullBudget(), undefined),
    ).toEqual({
      added: 4,
      deleted: 0,
    });
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
    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', 'link.png', fullBudget(), undefined),
    ).toEqual({
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

    expect(gitDiffBinaryRecount(repo, 'main', 'feature', path, fullBudget(), undefined)).toEqual({
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

    expect(gitDiffNumstat(repo, 'main', 'feature')).toEqual([
      { path: 'nonul.png', added: null, deleted: null },
    ]);
    // The signature's CR and LF make two lines, then `x` and `y`.
    expect(
      gitDiffBinaryRecount(repo, 'main', 'feature', 'nonul.png', fullBudget(), undefined),
    ).toEqual({
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

    expect(gitDiffBinaryRecount(repo, 'main', 'feature', 'gone.png', budget, undefined)).toBeNull();
    expect(budget.bytes).toBe(size + 1);
    expect(gitDiffBinaryRecount(repo, 'main', 'feature', 'a.png', budget, undefined)).toBeNull();
    expect(budget.bytes).toBe(1);
    // The signature's CR and LF make three lines; `b` ends the third.
    expect(gitDiffBinaryRecount(repo, 'main', 'feature', 'b.png', budget, undefined)).toEqual({
      added: 3,
      deleted: 0,
    });
  });

  // An object read that fails was read as "this side does not exist", and a
  // known-format path then went uncounted; only an empty listing is absence.
  it('throws when the blob of a side cannot be read, rather than skip the file', () => {
    const repo = repoWith({ 'base.ts': 'one\n' }, { 'image.png': png('q\n') });
    const oid = execFileSync('git', ['rev-parse', 'feature:image.png'], {
      cwd: repo,
      env: GIT_ENV,
      encoding: 'utf8',
    }).trim();
    unlinkSync(join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));

    expect(() =>
      gitDiffBinaryRecount(repo, 'main', 'feature', 'image.png', fullBudget(), undefined),
    ).toThrow(/no byte count for .*: its object cannot be read/);
  });

  // Git only sniffs the first 8000 bytes, so a NUL past them is text to git
  // itself — reading the whole blob would let a session append one and pass.
  it('treats a NUL past the first 8000 bytes as text, the way git does', () => {
    const late = `${'a'.repeat(9000)}\n\0\n`;
    const repo = repoWith({ 'a.ts': 'one\n' }, { 'a.ts': `one\n${late}` });

    expect(gitDiffNumstat(repo, 'main', 'feature')[0]?.added).toBe(2);

    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -diff\n');

    expect(gitDiffBinaryRecount(repo, 'main', 'feature', 'a.ts', fullBudget(), undefined)).toEqual({
      added: 2,
      deleted: 0,
    });
  });
});

describe('readBlobs', () => {
  function blobsOf(repo: string): { oid: string; size: number }[] {
    return execFileSync('git', ['ls-tree', '-r', '-l', '-z', 'HEAD'], {
      cwd: repo,
      env: GIT_ENV,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const [, , oid = '', size] = entry.slice(0, entry.indexOf('\t')).split(/ +/);
        return { oid, size: Number(size) };
      });
  }

  it('reads every blob byte for byte, a NUL, an empty one and a repeat included', () => {
    const repo = makeRepo();
    const files: Record<string, Buffer> = {
      'a.ts': Buffer.from('one\ntwo\n'),
      'b.bin': Buffer.from([0, 0x89, 0x0a, 0xff]),
      'empty.ts': Buffer.alloc(0),
      'no-eol.ts': Buffer.from('last'),
      'same.ts': Buffer.from('one\ntwo\n'),
    };
    for (const [file, content] of Object.entries(files)) writeFileSync(join(repo, file), content);
    commitAll(repo, 'blobs');
    const blobs = blobsOf(repo);

    expect(readBlobs(repo, blobs)).toEqual(Object.values(files));
  });

  it('refuses an oid git does not hold', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    commitAll(repo, 'base');

    expect(() => readBlobs(repo, [...blobsOf(repo), { oid: 'f'.repeat(40), size: 0 }])).toThrow(
      /missing/,
    );
  });

  it('refuses an answer whose size is not the one listed', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    commitAll(repo, 'base');
    const [{ oid = '' } = {}] = blobsOf(repo);

    // One byte short overflows the buffer sized from the listing before any parse.
    expect(() => readBlobs(repo, [{ oid, size: 3 }])).toThrow(/ENOBUFS/);
    expect(() => readBlobs(repo, [{ oid, size: 5 }])).toThrow(/not a blob of 5 bytes/);
  });

  // Each read alone was capped at 64 MiB; the batch holds them all at once.
  it('refuses, before running git, a batch whose sizes add past the cap', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    commitAll(repo, 'base');
    const [{ oid = '' } = {}] = blobsOf(repo);
    const half = 32 * 1024 * 1024;

    expect(() =>
      readBlobs(repo, [
        { oid, size: half },
        { oid, size: half + 1 },
      ]),
    ).toThrow(/past the 67108864-byte cap/);
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
      `git -C / config --file '${join(repo, '.git/config')}' --unset-all extensions.worktreeConfig`,
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

  describe('mayBeKnownBinary', () => {
    it('admits a regular file up to the cap', () => {
      expect(mayBeKnownBinary('100644', BINARY_FREE_MAX_BYTES)).toBe(true);
      expect(mayBeKnownBinary('100755', 0)).toBe(true);
    });

    it('refuses a symlink, a gitlink, no mode and a file past the cap', () => {
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
