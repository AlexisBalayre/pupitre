import { execFileSync } from 'node:child_process';
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
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';
import {
  ArmedGitDriverError,
  armedGitDrivers,
  assertNoArmedGitDrivers,
  currentBranch,
  gitDiffAddedLines,
  gitDiffBinaryRecount,
  gitDiffNumstat,
  gitDiffPaths,
  rethrowIfKilled,
  runGit,
  verifiedWorktreeGitEnv,
  WorktreeRepointedError,
  worktreeGitEnv,
} from './git-diff.client.js';

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
});

// `--text` restores the `-U0` patch above but not `--numstat`: under the same
// `* -diff` line every file reads `-\t-`, and a null skipped as a real binary
// lets any diff count as zero changed lines (decision 53).
describe('gitDiffBinaryRecount', () => {
  function repoWith(base: Record<string, string>, feature: Record<string, string>): string {
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
    expect(gitDiffBinaryRecount(repo, 'main', 'feature', 'a.ts')).toEqual({ added: 3, deleted: 2 });
  });

  it('recounts a new text file under core.attributesFile and core.bigFileThreshold', () => {
    const repo = repoWith({ 'a.ts': 'one\n' }, { 'fresh.ts': 'one\ntwo\n' });
    const attributes = join(repo, '.git', 'forged-attributes');
    writeFileSync(attributes, '* binary\n');
    sh(repo, 'git', 'config', 'core.attributesFile', attributes);

    expect(gitDiffBinaryRecount(repo, 'main', 'feature', 'fresh.ts')).toEqual({
      added: 2,
      deleted: 0,
    });

    sh(repo, 'git', 'config', '--unset', 'core.attributesFile');
    sh(repo, 'git', 'config', 'core.bigFileThreshold', '1');

    expect(gitDiffNumstat(repo, 'main', 'feature')[0]?.added).toBeNull();
    expect(gitDiffBinaryRecount(repo, 'main', 'feature', 'fresh.ts')).toEqual({
      added: 2,
      deleted: 0,
    });
  });

  // `--text` parses hunks out of a real binary as well, so the patch cannot be
  // what tells the two apart.
  it('answers null for a real binary, armed or not, on either side of the diff', () => {
    const repo = repoWith(
      { 'image.bin': 'x\0y\nline\n', 'gone.bin': 'keep\n' },
      { 'image.bin': 'x\0z\nline\nmore\n', 'gone.bin': 'now\0binary\n', 'new.bin': 'q\0\n' },
    );

    expect(gitDiffAddedLines(repo, 'main', 'feature')['image.bin']).toEqual([1, 3]);
    for (const path of ['image.bin', 'gone.bin', 'new.bin']) {
      expect(gitDiffBinaryRecount(repo, 'main', 'feature', path)).toBeNull();
    }

    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -diff\n');

    for (const path of ['image.bin', 'gone.bin', 'new.bin']) {
      expect(gitDiffBinaryRecount(repo, 'main', 'feature', path)).toBeNull();
    }
  });

  // Git only sniffs the first 8000 bytes, so a NUL past them is text to git
  // itself — reading the whole blob would let a session append one and pass.
  it('treats a NUL past the first 8000 bytes as text, the way git does', () => {
    const late = `${'a'.repeat(9000)}\n\0\n`;
    const repo = repoWith({ 'a.ts': 'one\n' }, { 'a.ts': `one\n${late}` });

    expect(gitDiffNumstat(repo, 'main', 'feature')[0]?.added).toBe(2);

    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -diff\n');

    expect(gitDiffBinaryRecount(repo, 'main', 'feature', 'a.ts')).toEqual({ added: 2, deleted: 0 });
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
});
