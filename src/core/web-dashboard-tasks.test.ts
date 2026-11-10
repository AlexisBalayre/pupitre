import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sh } from '@test/helpers/git.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionState } from './db.client.js';
import { openStore } from './db.client.js';
import { projectId } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  insertSession,
  insertTask,
  transitionSession,
} from './session.repository.js';
import type { GateReport } from './types/merge-gate.types.js';
import { firstSentence, readTasksSheet, renderTasksSheet } from './web-dashboard-tasks.service.js';

const PR = 'https://github.com/o/r/pull/7';
/** A Monday noon; its eight weeks end at the next midnight, UTC. */
const NOW = Date.parse('2026-11-09T12:00:00Z');
// biome-ignore lint/suspicious/noControlCharactersInRegex: their absence is what is asserted
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

describe('the Tasks sheet', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = tempDir('pup-web-tasks-');
    ensureProject(db, projectId(repo), repo);
  });

  const render = (): string => renderTasksSheet(readTasksSheet(db, repo, NOW));

  /** Stamps the newest event with `at`, SQLite's UTC text. */
  const stamp = (at: string): void => {
    db.prepare('UPDATE events SET created_at = ? WHERE id = (SELECT MAX(id) FROM events)').run(at);
  };

  function plan(taskId: string, goal: string, scopeIn: string[], scopeOut?: string[]): void {
    insertTask(db, {
      id: taskId,
      projectId: projectId(repo),
      spec: JSON.stringify({ id: taskId, goal, scopeIn, scopeOut, acceptance: ['done'] }),
      origin: 'human',
    });
  }

  function launch(
    sessionId: string,
    path: SessionState[] = [],
    scopeIn = ['src/**'],
    launchedAt = '2026-11-01 10:00:00',
  ): void {
    plan(`t-${sessionId}`, `goal for ${sessionId}`, scopeIn);
    insertSession(db, {
      id: sessionId,
      taskId: `t-${sessionId}`,
      worktreePath: join(repo, '.worktrees', sessionId),
      branch: `pup/${sessionId}`,
      profileHash: 'hash',
    });
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(launchedAt, sessionId);
    for (const state of path) transitionSession(db, sessionId, state);
  }

  const report = (sessionId: string, failed: string[] = []): GateReport => ({
    sessionId,
    passed: failed.length === 0,
    sandbox: 'test',
    stages: [
      { stage: 'tests', status: failed.includes('tests') ? 'fail' : 'pass' },
      { stage: 'lint', status: failed.includes('lint') ? 'fail' : 'pass' },
      { stage: 'diff-size', status: failed.includes('diff-size') ? 'flagged' : 'pass' },
    ],
  });

  /** A merge at `at`; a `null` url is a local merge, which opens no PR. */
  function merge(sessionId: string, at: string, prUrl: string | null = PR): void {
    appendEvent(db, sessionId, 'merge', {
      branch: `pup/${sessionId}`,
      sha: 'f'.repeat(40),
      target: 'main',
      files: [],
      ...(prUrl === null ? {} : { prUrl }),
    });
    stamp(at);
  }

  /**
   * A `--pr` session through the gate as `pup merge` and `pup fix` record it:
   * a failed gate and its re-steer, a message, a respawn, the passing gate and
   * the PR, a re-gate on the PR's new head and its merge, then the land.
   */
  function seedPrSession(sessionId: string): void {
    launch(sessionId);
    appendEvent(db, sessionId, 'steer', { kind: 'kickoff', delivered: true });
    transitionSession(db, sessionId, 'running');
    transitionSession(db, sessionId, 'awaiting-review');
    transitionSession(db, sessionId, 'rejected', { report: report(sessionId, ['tests', 'lint']) });
    stamp('2026-11-01 12:00:00');
    appendEvent(db, sessionId, 'steer', { kind: 'gate-rejection' });
    transitionSession(db, sessionId, 'running', { kind: 'gate-rejection-resteer' });
    appendEvent(db, sessionId, 'steer', { kind: 'message', by: 'operator' });
    appendEvent(db, sessionId, 'respawn', { delivered: true });
    transitionSession(db, sessionId, 'awaiting-review');
    transitionSession(db, sessionId, 'merged', { report: report(sessionId) });
    stamp('2026-11-02 13:00:00');
    merge(sessionId, '2026-11-02 13:30:00');
    appendEvent(db, sessionId, 'gate_result', {
      from: 'merged',
      to: 'merged',
      report: report(sessionId),
    });
    stamp('2026-11-03 09:00:00');
    merge(sessionId, '2026-11-03 09:00:01');
    appendEvent(db, sessionId, 'landed', { sha: 'a'.repeat(40), target: 'main', prUrl: PR });
    stamp('2026-11-04 10:00:00');
  }

  /** The sessions table's row for `sessionId`, its cells as text. */
  function rowOf(page: string, sessionId: string): string[] {
    const row = new RegExp(`<tr><td><span class="sid">${sessionId}</span></td>(.*?)</tr>`).exec(
      page,
    )?.[1];
    return [...(row ?? '').matchAll(/<td>(.*?)<\/td>/g)].map(([, cell]) =>
      (cell ?? '').replace(/<[^>]+>/g, ''),
    );
  }

  it('shows a one-line hint for every section on an empty store, and no chart', () => {
    const page = render();

    expect(page).not.toContain('<svg');
    expect(page).toContain('No gate run in the last 8 weeks.');
    expect(page).toContain('Nothing planned — `pup plan` adds a task.');
    expect(page).toContain('No session has reached a PR yet.');
  });

  it("counts each PR session's gate runs, steers, respawns and re-gates, and its times", () => {
    seedPrSession('s-pr');

    expect(rowOf(render(), 's-pr')).toEqual([PR, '3 (1 failed)', '2', '1', '1', '1d 3h', '3d 0h']);
  });

  it('lists only sessions that reached a PR, newest merge first, a PR not landed said so', () => {
    seedPrSession('s-old');
    launch('s-new', ['running', 'awaiting-review', 'merged']);
    merge('s-new', '2026-11-05 10:30:00', `${PR}8`);
    launch('s-local', ['running', 'awaiting-review', 'merged']);
    merge('s-local', '2026-11-06 10:00:00', null);
    launch('s-live', ['running']);

    const page = render();

    expect(page.indexOf('>s-new<')).toBeLessThan(page.indexOf('>s-old<'));
    expect(page).not.toContain('>s-local<');
    expect(page).not.toContain('>s-live<');
    expect(rowOf(page, 's-new')).toEqual([
      `${PR}8`,
      '0 (0 failed)',
      '0',
      '0',
      '0',
      '4d 0h',
      'not landed',
    ]);
  });

  it('charts the pass rate per week and the failures per stage, each with its figure line', () => {
    seedPrSession('s-pr');
    launch('s-b', ['running', 'awaiting-review']);
    appendEvent(db, 's-b', 'gate_result', {
      outcome: 'refused',
      report: report('s-b', ['diff-size']),
    });
    stamp('2026-10-20 08:00:00');
    appendEvent(db, 's-b', 'gate_result', { outcome: 'refused', report: report('s-b', ['tests']) });
    stamp('2025-01-01 00:00:00');

    const page = render();

    expect(page).toContain('Gate runs in the last 8 weeks: 4, 2 passed.');
    expect(page).toContain(
      '<figcaption>Gate pass rate per week, week starting: 09-15 no run · 09-22 no run · ' +
        '09-29 no run · 10-06 no run · 10-13 no run · 10-20 0% · 10-27 50% · 11-03 100%</figcaption>',
    );
    expect(page).toContain(
      '<figcaption>Gate failures per stage: diff-size 1 · lint 1 · tests 1</figcaption>',
    );
    expect(page).toContain('<title>Gate failures per stage:');
  });

  it('lists the backlog in store order, each goal cut to its first sentence, with its scope', () => {
    plan('t-b', 'Second task. With more said.', ['src/b/**'], ['src/b/gen/**']);
    plan('t-a', 'First task!\nAnd a second line.', ['docs/**']);
    db.prepare("UPDATE tasks SET created_at = '2026-01-02 00:00:00' WHERE id = 't-a'").run();
    db.prepare("UPDATE tasks SET created_at = '2026-01-01 00:00:00' WHERE id = 't-b'").run();

    const page = render();

    expect(page.indexOf('>t-b<')).toBeLessThan(page.indexOf('>t-a<'));
    expect(page).toContain('<div class="goal">Second task.</div>');
    expect(page).toContain('<div class="goal">First task!</div>');
    expect(page).toContain('scope: <code>src/b/**</code> · not <code>src/b/gen/**</code>');
    expect(page).not.toContain('With more said');
  });

  it('names each live session a backlog task would share tracked files with', () => {
    sh(repo, 'git', 'init', '-q', '-b', 'main');
    for (const file of ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'docs/x.md']) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), '');
    }
    sh(repo, 'git', 'add', '.');
    launch('s-live', ['running'], ['src/a.ts', 'src/b.ts']);
    launch('s-wide', ['running', 'awaiting-review'], ['src/**']);
    launch('s-done', ['running', 'awaiting-review', 'merged'], ['src/**']);
    plan('t-src', 'Touch a.', ['src/**'], ['src/e.ts']);
    plan('t-docs', 'Touch docs.', ['docs/**']);

    const page = render();

    expect(page).toContain(
      'overlaps s-live on src/a.ts, src/b.ts; s-wide on src/a.ts, src/b.ts, src/c.ts and 1 more',
    );
    expect(page).toContain('no overlap with a live session');
    expect(page).not.toContain('s-done on');
  });

  it('says once that overlaps could not be read when git cannot list the files', () => {
    launch('s-live', ['running']);
    plan('t-a', 'One.', ['src/**']);
    plan('t-b', 'Two.', ['src/**']);

    const page = render();

    expect(page.match(/Overlaps not read/g)).toHaveLength(1);
    expect(page).not.toContain('no overlap with a live session');
  });

  it('escapes every store string, markup and control characters alike', () => {
    const evil = '<img src=x onerror=alert(1)>\u001b[31m\u009b2J';
    sh(repo, 'git', 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', '<b>x.ts'), '');
    sh(repo, 'git', 'add', '.');
    plan(`t-${evil}`, `${evil}. More.`, [`src/**`, `lib/${evil}`]);
    launch('s-evil', ['running', 'awaiting-review', 'merged']);
    appendEvent(db, 's-evil', 'gate_result', {
      outcome: 'refused',
      report: {
        sessionId: 's-evil',
        passed: false,
        sandbox: 'test',
        stages: [{ stage: evil, status: 'fail' }],
      },
    });
    stamp('2026-11-02 00:00:00');
    merge('s-evil', '2026-11-03 00:00:00', `${PR}${evil}`);
    launch('s-live', ['running']);

    const page = render();

    expect(page).not.toContain('<img');
    expect(page).not.toContain('<b>');
    expect(page).not.toMatch(CONTROL);
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).toContain('src/&lt;b&gt;x.ts');
    expect(page).not.toMatch(/<a href="(?!https:\/\/github\.com\/o\/r\/pull\/7")/);
  });

  it('reads the first sentence of a goal', () => {
    expect(firstSentence('Add the sheet. Then more.')).toBe('Add the sheet.');
    expect(firstSentence('Use v1.2 here? Yes.')).toBe('Use v1.2 here?');
    expect(firstSentence('No full stop')).toBe('No full stop');
    expect(firstSentence('Ends here.')).toBe('Ends here.');
  });
});
