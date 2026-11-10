import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADR_NUMBER_STAGE, adrNumberStage } from './adr-number.service.js';
import type { SessionState } from './db.client.js';
import { openStore } from './db.client.js';
import { runGit } from './git-diff.client.js';
import {
  appendEvent,
  ensureProject,
  insertSession,
  insertTask,
  transitionSession,
} from './session.repository.js';

// The real git, which one test makes an interrupt kill on one branch's diff.
vi.mock('./git-diff.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-diff.client.js')>();
  return { ...actual, runGit: vi.fn(actual.runGit) };
});

// Test repos must not inherit the developer's global git config nor GIT_DIR & co.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_ENV }).trim();
}

/** Commit `files` on `branch`, cut from main when it does not exist yet; main is checked out. */
function commitOn(repo: string, branch: string, ...files: string[]): void {
  const exists = git(repo, 'branch', '--list', branch) !== '';
  if (branch !== 'main')
    git(repo, 'checkout', '-q', ...(exists ? [branch] : ['-b', branch, 'main']));
  for (const file of files) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), `# ${file} on ${branch}\n`);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', `add ${files.join(' ')}`);
  git(repo, 'checkout', '-q', 'main');
}

const PATHS: Record<SessionState, SessionState[]> = {
  queued: [],
  running: ['running'],
  'awaiting-review': ['running', 'awaiting-review'],
  rejected: ['running', 'awaiting-review', 'rejected'],
  blocked: ['running', 'blocked'],
  merged: ['running', 'awaiting-review', 'merged'],
  killed: ['killed'],
};

function seedSession(db: Database, id: string, state: SessionState): void {
  insertTask(db, { id: `task-${id}`, projectId: 'proj', spec: '{}' });
  insertSession(db, {
    id,
    taskId: `task-${id}`,
    worktreePath: `/nowhere/${id}`,
    branch: `pup/${id}`,
    profileHash: 'hash',
  });
  for (const to of PATHS[state]) transitionSession(db, id, to);
}

// Each test runs a dozen git commands, which a loaded host stretches past 5 s.
describe('adrNumberStage', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = tempDir('pup-adr-number-');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'adr@test');
    git(repo, 'config', 'user.name', 'adr-test');
    commitOn(repo, 'main', 'docs/adr/0001-first.md', 'docs/adr/0002-second.md');
    ensureProject(db, 'proj', repo);
    seedSession(db, 'me', 'awaiting-review');
  });

  const stage = () =>
    adrNumberStage(
      db,
      repo,
      'me',
      git(repo, 'rev-parse', 'refs/heads/main'),
      git(repo, 'rev-parse', 'refs/heads/pup/me'),
    );
  /** The failed stage's lines, or none when the stage passed or was not run. */
  const refusals = (): string[] => {
    const result = stage();
    return result?.status === 'fail' ? (result.detail ?? '').split('\n') : [];
  };

  it('adds no stage for a branch adding no ADR', () => {
    commitOn(repo, 'pup/me', 'src/app.ts');
    expect(stage()).toBeUndefined();
  });

  it('passes a free number, and edits to a decision already on the target', () => {
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md', 'docs/adr/0002-second.md');
    seedSession(db, 'other', 'running');
    commitOn(repo, 'pup/other', 'docs/adr/0004-theirs.md');
    expect(stage()).toBeUndefined();
  });

  it('passes a slug-only rename of a decision on the target', () => {
    seedSession(db, 'other', 'running');
    commitOn(repo, 'pup/other', 'docs/adr/0003-theirs.md');
    git(repo, 'checkout', '-q', '-b', 'pup/me', 'main');
    git(repo, 'mv', 'docs/adr/0002-second.md', 'docs/adr/0002-renamed.md');
    git(repo, 'commit', '-q', '-m', 'rename');
    git(repo, 'checkout', '-q', 'main');
    expect(stage()).toBeUndefined();
  });

  it('refuses a file under the number of a decision the branch deletes, as a rename changed too much', () => {
    git(repo, 'checkout', '-q', '-b', 'pup/me', 'main');
    git(repo, 'rm', '-q', 'docs/adr/0002-second.md');
    writeFileSync(
      join(repo, 'docs/adr/0002-other.md'),
      '# 0002. Something else entirely\n\nA different decision, with\nnothing in common.\n',
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'replace');
    git(repo, 'checkout', '-q', 'main');
    expect(refusals()).toEqual([
      'ADR numbers already taken:',
      '  docs/adr/0002-other.md: decision 0002 is already on the target as docs/adr/0002-second.md, ' +
        'which the branch deletes: this looks like a slug rename that changed too much of the file ' +
        "to be paired; keep the ADR's text closer to the original",
    ]);
  });

  it('tells an unrelated file to renumber when the target file under its number was renumbered away', () => {
    git(repo, 'checkout', '-q', '-b', 'pup/me', 'main');
    git(repo, 'mv', 'docs/adr/0002-second.md', 'docs/adr/0003-second.md');
    writeFileSync(
      join(repo, 'docs/adr/0002-x.md'),
      '# 0002. Something else entirely\n\nA different decision, with\nnothing in common.\n',
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'renumber and add');
    git(repo, 'checkout', '-q', 'main');
    expect(refusals()).toEqual([
      'ADR numbers already taken:',
      '  docs/adr/0002-x.md: decision 0002 is already on the target; renumber it 0004, the lowest free number',
    ]);
  });

  it('refuses a slug rename another session branch also makes of the same decision', () => {
    seedSession(db, 'other', 'running');
    for (const [branch, slug] of [
      ['pup/other', 'b'],
      ['pup/me', 'a'],
    ] as const) {
      git(repo, 'checkout', '-q', '-b', branch, 'main');
      git(repo, 'mv', 'docs/adr/0002-second.md', `docs/adr/0002-${slug}.md`);
      git(repo, 'commit', '-q', '-m', `rename to ${slug}`);
      git(repo, 'checkout', '-q', 'main');
    }
    expect(refusals()).toEqual([
      'ADR numbers already taken:',
      '  docs/adr/0002-a.md: decision 0002 renames docs/adr/0002-second.md, which pup/other, a ' +
        'session branch that is live or whose PR has not landed, also renames or adds under that ' +
        "number; settle one name with it or keep the target's",
    ]);
  });

  it('refuses a second file with the same number on the branch', () => {
    commitOn(repo, 'pup/me', 'docs/adr/0003-a.md', 'docs/adr/0003-b.md');
    expect(refusals()).toEqual([
      'ADR numbers already taken:',
      '  docs/adr/0003-b.md: decision 0003 is also added by docs/adr/0003-a.md on this branch; ' +
        'renumber it 0004, the lowest free number',
    ]);
  });

  it('skips a competing branch git cannot diff, naming it, and still checks the rest', () => {
    seedSession(db, 'orphan', 'running');
    // A parentless commit shares no merge base with the target.
    const orphan = git(repo, 'commit-tree', '-m', 'orphan', 'main^{tree}');
    git(repo, 'update-ref', 'refs/heads/pup/orphan', orphan);
    seedSession(db, 'other', 'running');
    commitOn(repo, 'pup/other', 'docs/adr/0004-theirs.md');
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
    expect(stage()).toMatchObject({
      stage: ADR_NUMBER_STAGE,
      status: 'pass',
      detail: 'not checked against pup/orphan: git could not read it against the target',
    });
    commitOn(repo, 'pup/me', 'docs/adr/0004-mine.md');
    expect(stage()).toMatchObject({ status: 'fail' });
    expect(stage()?.detail).toBe(
      'ADR numbers already taken:\n' +
        '  docs/adr/0004-mine.md: decision 0004 is also added by pup/other, a session branch ' +
        'that is live or whose PR has not landed; renumber it 0005, the lowest free number\n' +
        'not checked against pup/orphan: git could not read it against the target',
    );
  });

  it('refuses a number already on the target, naming the lowest free number', () => {
    commitOn(repo, 'pup/me', 'docs/adr/0002-mine.md');
    expect(refusals()).toEqual([
      'ADR numbers already taken:',
      '  docs/adr/0002-mine.md: decision 0002 is already on the target; renumber it 0003, the lowest free number',
    ]);
  });

  it('counts a decision renamed onto a taken number as the add of its new name', () => {
    seedSession(db, 'other', 'running');
    commitOn(repo, 'pup/other', 'docs/adr/0003-theirs.md');
    git(repo, 'checkout', '-q', '-b', 'pup/me', 'main');
    git(repo, 'mv', 'docs/adr/0002-second.md', 'docs/adr/0003-second.md');
    git(repo, 'commit', '-q', '-m', 'renumber');
    git(repo, 'checkout', '-q', 'main');
    expect(refusals()).toEqual([
      'ADR numbers already taken:',
      expect.stringContaining('docs/adr/0003-second.md: decision 0003 is also added by pup/other'),
    ]);
  });

  it.each(['queued', 'running', 'awaiting-review', 'rejected', 'blocked'] as const)(
    'refuses a number a %s session branch adds, naming it',
    (state) => {
      seedSession(db, 'other', state);
      commitOn(repo, 'pup/other', 'docs/adr/0003-theirs.md');
      commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
      expect(refusals()).toEqual([
        'ADR numbers already taken:',
        '  docs/adr/0003-mine.md: decision 0003 is also added by pup/other, a session branch that ' +
          'is live or whose PR has not landed; renumber it 0004, the lowest free number',
      ]);
    },
  );

  /** Seed `other` as merged with an open PR whose merge event records `sha`. */
  const openPrPeer = (sha?: string): void => {
    seedSession(db, 'other', 'merged');
    appendEvent(db, 'other', 'merge', {
      branch: 'pup/other',
      ...(sha === undefined ? {} : { sha }),
      target: 'main',
      files: [],
      prUrl: 'https://github.com/o/r/pull/1',
    });
  };

  it('refuses a number a merged session with an open PR adds, read at its gated sha once the gate deleted its branch', () => {
    commitOn(repo, 'pup/other', 'docs/adr/0003-theirs.md');
    openPrPeer(git(repo, 'rev-parse', 'refs/heads/pup/other'));
    // A passing gate deletes the branch in both modes; a PR keeps only its head.
    git(repo, 'branch', '-q', '-D', 'pup/other');
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
    expect(refusals()).toEqual([
      'ADR numbers already taken:',
      '  docs/adr/0003-mine.md: decision 0003 is also added by pup/other, a session branch that ' +
        'is live or whose PR has not landed; renumber it 0004, the lowest free number',
    ]);
  });

  it('reads a merged peer with an open PR at its gated sha, not a branch moved after it', () => {
    commitOn(repo, 'pup/other', 'docs/adr/0004-theirs.md');
    openPrPeer(git(repo, 'rev-parse', 'refs/heads/pup/other'));
    commitOn(repo, 'pup/other', 'docs/adr/0003-later.md');
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
    expect(stage()).toBeUndefined();
  });

  it.each([
    ['records no sha', undefined, 'its merge recorded no gated commit sha'],
    [
      'names a commit the repo lacks',
      'f'.repeat(40),
      `its gated commit ${'f'.repeat(40)} is not in this repo; fetch the PR's head here`,
    ],
    ['records a sha that is no commit sha', '--output=x', 'its merge recorded no gated commit sha'],
  ])("refuses, naming the peer and its PR, when an open PR peer's merge %s", (_, sha, why) => {
    openPrPeer(sha);
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
    expect(refusals()).toEqual([
      'PRs not landed whose gated commit cannot be read, so no number this branch adds can ' +
        'be cleared against them:',
      `  pup/other (https://github.com/o/r/pull/1): ${why}`,
    ]);
  });

  it.each([
    ['is parentless', () => git(repo, 'commit-tree', '-m', 'orphan', 'main^{tree}')],
    [
      'has its history cut by a shallow file a session wrote',
      () => {
        commitOn(repo, 'pup/other', 'docs/adr/0003-theirs.md');
        const sha = git(repo, 'rev-parse', 'refs/heads/pup/other');
        git(repo, 'branch', '-q', '-D', 'pup/other');
        writeFileSync(join(repo, '.git', 'shallow'), `${sha}\n`);
        return sha;
      },
    ],
  ])(
    'refuses, rather than skips, an open PR peer whose gated commit %s, so git cannot diff it',
    (_, pin) => {
      const sha = pin();
      openPrPeer(sha);
      commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
      expect(refusals()).toEqual([
        'PRs not landed whose gated commit cannot be read, so no number this branch adds can ' +
          'be cleared against them:',
        `  pup/other (https://github.com/o/r/pull/1): its gated commit ${sha} is in this repo, ` +
          'but git could not diff it against the target (a history a shallow file cuts, a ' +
          'missing object, a read past its time); repair the repo, then gate again',
      ]);
    },
  );

  it("withholds an open PR peer's url that is not a pull request's", () => {
    seedSession(db, 'other', 'merged');
    appendEvent(db, 'other', 'merge', {
      branch: 'pup/other',
      target: 'main',
      files: [],
      prUrl: 'https://evil.example/$(touch x)',
    });
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
    expect(refusals()).toContain(
      '  pup/other (a pull request url pup withholds): its merge recorded no gated commit sha',
    );
  });

  it('ignores a retired PR peer, even once its gated commit is pruned', () => {
    openPrPeer('1'.repeat(40));
    appendEvent(db, 'other', 'retired', {
      prUrl: 'https://github.com/o/r/pull/1',
      supersededBy: 'https://github.com/o/r/pull/2',
    });
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
    expect(stage()).toBeUndefined();
  });

  it('adds no stage for a branch adding no ADR beside an unreadable open PR peer', () => {
    openPrPeer();
    commitOn(repo, 'pup/me', 'src/app.ts');
    expect(stage()).toBeUndefined();
  });

  it('ignores killed sessions, landed PRs, local merges and pup branches no session holds', () => {
    seedSession(db, 'killed', 'killed');
    seedSession(db, 'landed', 'merged');
    appendEvent(db, 'landed', 'merge', {
      branch: 'pup/landed',
      target: 'main',
      files: [],
      prUrl: 'https://github.com/o/r/pull/2',
    });
    appendEvent(db, 'landed', 'landed', {
      sha: 'abc',
      target: 'main',
      prUrl: 'https://github.com/o/r/pull/2',
    });
    seedSession(db, 'local', 'merged');
    appendEvent(db, 'local', 'merge', { branch: 'pup/local', target: 'main', files: [] });
    for (const branch of ['killed', 'landed', 'local', 'stray']) {
      commitOn(repo, `pup/${branch}`, `docs/adr/0003-${branch}.md`);
    }
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
    expect(stage()).toBeUndefined();
  });

  it('lets an interrupt that kills a competing diff through, rather than skip the branch', async () => {
    seedSession(db, 'other', 'running');
    commitOn(repo, 'pup/other', 'docs/adr/0004-theirs.md');
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
    const theirs = git(repo, 'rev-parse', 'refs/heads/pup/other');
    const actual =
      await vi.importActual<typeof import('./git-diff.client.js')>('./git-diff.client.js');
    const interrupt = Object.assign(new Error('git killed'), { signal: 'SIGINT' });
    vi.mocked(runGit).mockImplementation((cwd, args, opts) => {
      if (args.some((arg) => arg.endsWith(`...${theirs}`))) throw interrupt;
      return actual.runGit(cwd, args, opts);
    });
    try {
      expect(() => stage()).toThrow(interrupt);
    } finally {
      vi.mocked(runGit).mockImplementation(actual.runGit);
    }
  });

  it.each(['ETIMEDOUT', 'ENOBUFS'])(
    'skips a competing branch whose read Node killed with %s, not reading it as an interrupt',
    async (code) => {
      seedSession(db, 'other', 'running');
      commitOn(repo, 'pup/other', 'docs/adr/0003-theirs.md');
      commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
      const theirs = git(repo, 'rev-parse', 'refs/heads/pup/other');
      const actual =
        await vi.importActual<typeof import('./git-diff.client.js')>('./git-diff.client.js');
      // What Node throws for an overrun: SIGTERM, with the code naming why.
      const overrun = Object.assign(new Error('spawnSync git'), { signal: 'SIGTERM', code });
      let peerRead: unknown;
      vi.mocked(runGit).mockImplementation((cwd, args, opts) => {
        if (args.some((arg) => arg.endsWith(`...${theirs}`))) {
          peerRead = opts;
          throw overrun;
        }
        return actual.runGit(cwd, args, opts);
      });
      try {
        expect(stage()).toMatchObject({
          status: 'pass',
          detail: 'not checked against pup/other: git could not read it against the target',
        });
        expect(peerRead).toEqual({ timeout: 10_000 });
      } finally {
        vi.mocked(runGit).mockImplementation(actual.runGit);
      }
    },
  );

  it('skips a competing branch that is a symbolic ref, naming it', () => {
    seedSession(db, 'other', 'running');
    git(repo, 'symbolic-ref', 'refs/heads/pup/other', 'refs/heads/main');
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
    expect(stage()).toMatchObject({
      status: 'pass',
      detail: 'not checked against pup/other: git could not read it against the target',
    });
  });

  it('leaves a competing branch adding more than three decisions unchecked, with a note', () => {
    seedSession(db, 'squatter', 'running');
    commitOn(
      repo,
      'pup/squatter',
      'docs/adr/0003-a.md',
      'docs/adr/0004-b.md',
      'docs/adr/0005-c.md',
      'docs/adr/0006-d.md',
    );
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
    expect(stage()).toMatchObject({
      status: 'pass',
      detail:
        'not checked against pup/squatter: it adds 4 decisions, more than the 3 a session ' +
        'branch is checked for',
    });
  });

  it('suggests no five-digit number when none above the target is free', () => {
    commitOn(repo, 'main', 'docs/adr/9999-last.md');
    commitOn(repo, 'pup/me', 'docs/adr/0002-mine.md');
    expect(refusals()).toEqual([
      'ADR numbers already taken:',
      "  docs/adr/0002-mine.md: decision 0002 is already on the target; no four-digit number above the target's highest is free",
    ]);
  });

  it('still refuses clashes after a session points core.worktree elsewhere', () => {
    seedSession(db, 'other', 'running');
    commitOn(repo, 'pup/other', 'docs/adr/0003-theirs.md');
    commitOn(repo, 'pup/me', 'docs/adr/0002-mine.md', 'docs/adr/0003-mine.md');
    // A cwd prefix of the repo's own name: a bare `docs/adr/` pathspec or
    // ls-tree path would then match nothing, and the check would pass.
    git(repo, 'config', 'core.worktree', dirname(repo));
    expect(refusals()).toEqual([
      'ADR numbers already taken:',
      '  docs/adr/0002-mine.md: decision 0002 is already on the target; renumber it 0004, the lowest free number',
      '  docs/adr/0003-mine.md: decision 0003 is also added by pup/other, a session branch that ' +
        'is live or whose PR has not landed; renumber it 0005, the lowest free number',
    ]);
  });

  it('refuses a decision under docs/ADR/ even with a free number, naming the lowercase path', () => {
    git(repo, 'checkout', '-q', '-b', 'pup/me', 'main');
    // Through the index: a case-insensitive checkout folds docs/ADR/ into docs/adr/.
    const blobFile = join(repo, '.git', 'blob.md');
    writeFileSync(blobFile, '# 0003 in upper case\n');
    const blob = git(repo, 'hash-object', '-w', blobFile);
    git(repo, 'update-index', '--add', '--cacheinfo', `100644,${blob},docs/ADR/0003-x.MD`);
    git(repo, 'commit', '-q', '-m', 'upper case');
    git(repo, 'checkout', '-q', '-f', 'main');
    expect(refusals()).toEqual([
      'ADR files neither docs/adr/NNNN-<slug>.md nor docs/adr/README.md, in lowercase ' +
        'docs/adr/ with four ASCII digits, a dash and .md:',
      '  docs/ADR/0003-x.MD: write it as docs/adr/0003-x.md',
    ]);
  });

  it('folds only ASCII when it names the path a misspelt decision was meant as', () => {
    // U+212A KELVIN SIGN lowercases to an ASCII 'k' under a Unicode fold, and
    // U+217F SMALL ROMAN NUMERAL ONE THOUSAND looks like an 'm'.
    commitOn(repo, 'pup/me', 'docs/adr/0003-\u212A.MD', 'docs/adr/0004-x.\u217Fd');
    expect(refusals()).toEqual([
      'ADR files neither docs/adr/NNNN-<slug>.md nor docs/adr/README.md, in lowercase ' +
        'docs/adr/ with four ASCII digits, a dash and .md:',
      // The slug keeps its Kelvin sign; only the ASCII suffix is lowercased.
      '  docs/adr/0003-\u212A.MD: write it as docs/adr/0003-\u212A.md',
      // No fold turns the lookalike into '.md', so no path is suggested.
      '  docs/adr/0004-x.\u217Fd',
    ]);
  });

  it('refuses every added path under docs/adr/ but a decision or the README, naming the form', () => {
    commitOn(
      repo,
      'pup/me',
      'docs/adr/00146-x.md',
      'docs/adr/0146_x.md',
      'docs/adr/sub/0146-x.md',
      'docs/adr/0146/x.md',
      'docs/adr/0147-y.md/README.md',
      'docs/adr/\u0660\u0661\u0664\u0666-x.md',
      'docs/adr/ 0146-x.md',
      'docs/adr/adr-0146-x.md',
      'docs/adr/0148-z.MD',
      'docs/adr/notes.txt',
      'docs/adr/README.md',
      'docs/adr/0003-fine.md',
    );
    // In git's byte order; the README and the well-formed decision pass.
    expect(refusals()).toEqual([
      'ADR files neither docs/adr/NNNN-<slug>.md nor docs/adr/README.md, in lowercase ' +
        'docs/adr/ with four ASCII digits, a dash and .md:',
      '  docs/adr/ 0146-x.md',
      '  docs/adr/00146-x.md',
      '  docs/adr/0146/x.md',
      '  docs/adr/0146_x.md',
      '  docs/adr/0147-y.md/README.md',
      '  docs/adr/0148-z.MD: write it as docs/adr/0148-z.md',
      '  docs/adr/adr-0146-x.md',
      '  docs/adr/notes.txt',
      '  docs/adr/sub/0146-x.md',
      '  docs/adr/\u0660\u0661\u0664\u0666-x.md',
    ]);
  });

  it('suggests a distinct free number per clash, past every number taken', () => {
    seedSession(db, 'other', 'running');
    commitOn(repo, 'pup/other', 'docs/adr/0003-theirs.md', 'docs/adr/0004-theirs.md');
    commitOn(
      repo,
      'pup/me',
      'docs/adr/0003-mine.md',
      'docs/adr/0001-mine.md',
      'docs/adr/0005-ok.md',
    );
    expect(refusals()).toEqual([
      'ADR numbers already taken:',
      expect.stringMatching(
        /0001-mine\.md: decision 0001 is already on the target; renumber it 0006,/,
      ),
      expect.stringMatching(
        /0003-mine\.md: decision 0003 is also added by pup\/other.*renumber it 0007,/,
      ),
    ]);
  });

  it('reads pinned shas, not what a worktree holds', () => {
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
    const target = git(repo, 'rev-parse', 'refs/heads/main');
    const pinned = git(repo, 'rev-parse', 'refs/heads/pup/me');
    // A branch moved after the pin and an untracked file change nothing.
    commitOn(repo, 'pup/me', 'docs/adr/0001-later.md');
    writeFileSync(join(repo, 'docs/adr/0001-untracked.md'), '# x\n');
    expect(adrNumberStage(db, repo, 'me', target, pinned)).toBeUndefined();
  });
});
