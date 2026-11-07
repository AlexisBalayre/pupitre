import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';
import { adrNumberRefusals } from './adr-number.service.js';
import type { SessionState } from './db.client.js';
import { openStore } from './db.client.js';
import {
  appendEvent,
  ensureProject,
  insertSession,
  insertTask,
  transitionSession,
} from './session.repository.js';

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

describe('adrNumberRefusals', () => {
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

  const refusals = (): string[] =>
    adrNumberRefusals(
      db,
      repo,
      'me',
      git(repo, 'rev-parse', 'refs/heads/main'),
      git(repo, 'rev-parse', 'refs/heads/pup/me'),
    );

  it('passes a branch adding no ADR', () => {
    commitOn(repo, 'pup/me', 'src/app.ts');
    expect(refusals()).toEqual([]);
  });

  it('passes a free number, and edits to a decision already on the target', () => {
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md', 'docs/adr/0002-second.md');
    seedSession(db, 'other', 'running');
    commitOn(repo, 'pup/other', 'docs/adr/0004-theirs.md');
    expect(refusals()).toEqual([]);
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
          'is live or has an open PR; renumber it 0004, the lowest free number',
      ]);
    },
  );

  it('refuses a number a merged session branch with an open PR adds', () => {
    seedSession(db, 'other', 'merged');
    appendEvent(db, 'other', 'merge', {
      branch: 'pup/other',
      target: 'main',
      files: [],
      prUrl: 'https://github.com/o/r/pull/1',
    });
    commitOn(repo, 'pup/other', 'docs/adr/0003-theirs.md');
    commitOn(repo, 'pup/me', 'docs/adr/0003-mine.md');
    expect(refusals()).toEqual([
      'ADR numbers already taken:',
      expect.stringContaining('decision 0003 is also added by pup/other'),
    ]);
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
    expect(refusals()).toEqual([]);
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
    expect(adrNumberRefusals(db, repo, 'me', target, pinned)).toEqual([]);
  });
});
