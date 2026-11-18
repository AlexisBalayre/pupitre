import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../core/db.client.js';
import { openStore } from '../core/db.client.js';
import { MERGE_LOCK_DIRNAME } from '../core/merge-gate.constants.js';
import { projectId } from '../core/paths.utils.js';
import {
  appendEvent,
  ensureProject,
  insertSession,
  insertTask,
  transitionSession,
} from '../core/session.repository.js';
import { conductorRecap, sessionRecap } from './compact-recap.service.js';

// No conductor runs in a test: its question is read against no run, as when none is up.
vi.mock('./session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-runtime.service.js')>()),
  conductorRun: () => undefined,
}));

vi.setConfig({ testTimeout: 30_000 });

const PR = 'https://github.com/o/r/pull/7';

// Decision 199: what the compact hook prints, read from the store and git.
describe('compact recap', () => {
  const GIT_ENV: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  let db: Database;
  let repo: string;
  let seeded: number;

  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).stdout.trim();

  beforeEach(() => {
    db = openStore(':memory:');
    repo = realpathSync(tempDir('pup-compact-recap-'));
    ensureProject(db, projectId(repo), repo);
    seeded = 0;
  });

  /** A session walked through `path`, its states in order from `queued`; its id. */
  function session(...path: SessionState[]): string {
    const id = `s${seeded++}`;
    insertTask(db, { id: `t-${id}`, projectId: projectId(repo), spec: '{}' });
    insertSession(db, {
      id,
      taskId: `t-${id}`,
      worktreePath: join(repo, '.worktrees', id),
      branch: `pup/${id}`,
      profileHash: 'hash',
    });
    for (const state of path) transitionSession(db, id, state);
    return id;
  }

  function gateReport(id: string, passed: boolean, stages: Record<string, string>): void {
    db.prepare("INSERT INTO events (session_id, type, payload) VALUES (?, 'gate_result', ?)").run(
      id,
      JSON.stringify({
        from: 'awaiting-review',
        to: passed ? 'merged' : 'rejected',
        report: {
          passed,
          stages: Object.entries(stages).map(([stage, status]) => ({ stage, status })),
        },
      }),
    );
  }

  describe('sessionRecap', () => {
    it('names the state, the rejections, no gate yet and no question', () => {
      const id = session('running');

      expect(sessionRecap(db, id)).toEqual([
        `Session state: running (${id}), 0 rejections.`,
        'Last gate: none run yet.',
        'Unanswered question to the operator: none.',
      ]);
    });

    it('reads the newest gate verdict past a bare transition, and the failing stages', () => {
      const id = session('running', 'awaiting-review');
      gateReport(id, false, { lint: 'pass', test: 'fail', scope: 'fail' });
      transitionSession(db, id, 'running');

      expect(sessionRecap(db, id)[1]).toMatch(
        /^Last gate: failed at test, scope \(awaiting-review → rejected\), \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\.$/,
      );
    });

    it('says a passing gate passed', () => {
      const id = session('running', 'awaiting-review');
      gateReport(id, true, { lint: 'pass' });

      expect(sessionRecap(db, id)[1]).toMatch(/^Last gate: passed \(awaiting-review → merged\), /);
    });

    it('names a fix round the session is in', () => {
      const id = session('running');
      appendEvent(db, id, 'fix_round', { prUrl: PR, head: 'abc', threads: [], rejectBase: 0 });

      expect(sessionRecap(db, id)[0]).toMatch(
        new RegExp(
          `^Session state: running \\(${id}\\), in a CI fix round since .* UTC, 0 rejections\\.$`,
        ),
      );
    });

    it('quotes the open question, its options and the recommendation, scrubbed', () => {
      const id = session('running');
      appendEvent(db, id, 'question', {
        text: 'Which store?\u001b[2J',
        options: ['sqlite', 'files'],
        recommended: 1,
      });

      const line = sessionRecap(db, id)[2] as string;
      expect(line).toMatch(
        /^Unanswered question to the operator \(#\d+\): Which store\?.* Options: 1\) sqlite; 2\) files\. Recommended: 1\.$/,
      );
      expect(line).not.toContain('\u001b');
    });

    it('says the state is unknown for an id the store does not hold', () => {
      expect(sessionRecap(db, 'ghost')).toEqual([
        'Session state: unknown — no session ghost in the store.',
      ]);
    });
  });

  describe('conductorRecap', () => {
    it('lists active sessions by state, counts the finished ones, and finds no PR, lock or question', () => {
      const running = session('running');
      const fixing = session('running');
      appendEvent(db, fixing, 'fix_round', { prUrl: PR, head: 'abc', threads: [], rejectBase: 0 });
      const queued = session();
      session('running', 'awaiting-review', 'merged');
      session('killed');

      expect(conductorRecap(db, repo)).toEqual([
        'Sessions by state:',
        `  running (2): ${running}, ${fixing} (fix round)`,
        `  queued (1): ${queued}`,
        '  counted only: merged 1, killed 1',
        'Open PRs: none.',
        'Merge lock: free.',
        'Your unanswered question to the operator: none.',
      ]);
    });

    it('caps a long list and counts the rest', () => {
      for (let i = 0; i < 15; i++) session('running');

      expect(conductorRecap(db, repo)[1]).toMatch(/^ {2}running \(15\): s0, .*, s11, … 3 more$/);
    });

    it("gives each open PR's pin, pushed head and worktree head, flagging a worktree past its pin", () => {
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.name', 't');
      git(repo, 'config', 'user.email', 't@t');
      writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'base');
      const id = session('running', 'awaiting-review', 'merged');
      const worktree = join(repo, '.worktrees', id);
      git(repo, 'worktree', 'add', '-q', '-b', `pup/${id}`, worktree, 'main');
      writeFileSync(join(worktree, 'a.ts'), 'a\n');
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '-q', '-m', 'gated');
      const pin = git(worktree, 'rev-parse', 'HEAD');
      git(repo, 'update-ref', `refs/remotes/origin/pup/${id}`, pin);
      appendEvent(db, id, 'merge', {
        branch: `pup/${id}`,
        sha: pin,
        target: 'main',
        files: [],
        prUrl: PR,
      });
      writeFileSync(join(worktree, 'b.ts'), 'b\n');
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '-q', '-m', 'fix round');
      const now = git(worktree, 'rev-parse', 'HEAD');
      // A PR that landed is no longer open.
      const landed = session('running', 'awaiting-review', 'merged');
      appendEvent(db, landed, 'merge', {
        branch: `pup/${landed}`,
        sha: pin,
        target: 'main',
        files: [],
        prUrl: PR,
      });
      appendEvent(db, landed, 'landed', { sha: pin, target: 'main', prUrl: PR });

      const lines = conductorRecap(db, repo);

      const open = lines.indexOf(
        'Open PRs (pin = the head the gate measured; pushed = origin/<branch>; worktree = its head now):',
      );
      expect(lines[open + 1]).toBe(
        `  ${id} merged ${PR} pin ${pin.slice(0, 12)} pushed ${pin.slice(0, 12)} ` +
          `worktree ${now.slice(0, 12)} (worktree past the pin: not gated yet)`,
      );
      expect(lines[open + 2]).toBe('Merge lock: free.');
    });

    it('reads unreadable heads as such, never throwing', () => {
      const id = session('running', 'awaiting-review', 'merged');
      appendEvent(db, id, 'merge', {
        branch: `pup/${id}`,
        sha: 'f'.repeat(40),
        target: 'main',
        files: [],
        prUrl: PR,
      });

      expect(conductorRecap(db, repo)).toContain(
        `  ${id} merged ${PR} pin ${'f'.repeat(12)} pushed unreadable worktree unreadable`,
      );
    });

    it('names the merge lock holder, what it runs and its stage, and a holder gone', () => {
      mkdirSync(join(repo, '.git', MERGE_LOCK_DIRNAME), { recursive: true });
      const lock = join(repo, '.git', MERGE_LOCK_DIRNAME);
      writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
      writeFileSync(
        join(lock, 'status'),
        JSON.stringify({ command: 'pup merge s3 --pr', since: Date.now(), stage: 'test' }),
      );

      expect(conductorRecap(db, repo)).toContain(
        `Merge lock: held by pid ${process.pid} running \`pup merge s3 --pr\` at test.`,
      );

      writeFileSync(join(lock, 'pid'), '99999999\n');
      writeFileSync(join(lock, 'status'), '{torn');
      expect(conductorRecap(db, repo)).toContain(
        'Merge lock: held by pid 99999999 (gone: the next run reclaims it).',
      );
    });
  });
});
