import { join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStore } from './db.client.js';
import { insertDecisionRecord } from './decision-record.repository.js';
import { projectId } from './paths.utils.js';
import { ensureProject, insertSession, insertTask } from './session.repository.js';
import { readDecisionsSheet, renderDecisionsSheet } from './web-dashboard-decisions.service.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: their absence is what is asserted
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

describe('the Decisions sheet', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = tempDir('pup-decisions-');
    ensureProject(db, projectId(repo), repo);
  });

  function seedSession(id: string): void {
    insertTask(db, {
      id: `t-${id}`,
      projectId: projectId(repo),
      spec: JSON.stringify({ id: `t-${id}`, goal: 'g', scopeIn: ['src/**'], acceptance: ['done'] }),
    });
    insertSession(db, {
      id,
      taskId: `t-${id}`,
      worktreePath: join(repo, '.worktrees', id),
      branch: `pup/${id}`,
      profileHash: 'hash',
    });
  }

  function decide(
    sessionId: string,
    summary: string,
    files: string[],
    alternatives?: string,
  ): void {
    seedSession(sessionId);
    insertDecisionRecord(db, { sessionId, summary, files, alternatives });
  }

  function dated(sessionId: string, at: string): void {
    db.prepare('UPDATE decision_records SET created_at = ? WHERE session_id = ?').run(
      at,
      sessionId,
    );
  }

  const sheet = (): string => renderDecisionsSheet(readDecisionsSheet(db));
  const rows = (page: string): string[] => page.match(/<li class="decision"[^>]*>/g) ?? [];

  it('renders on an empty store with a one-line hint, and no chart, map or search', () => {
    const page = sheet();

    expect(page).toContain('No decision recorded yet — each merge records one.');
    expect(page).not.toMatch(/<svg|treemap|data-list|Module map/);
  });

  it('groups the records newest first under the day each was made, with its summary and alternatives', () => {
    decide('s-1', 'oldest call', ['src/core/a.ts'], 'keep it\nor drop it');
    dated('s-1', '2026-11-02 09:15:00');
    decide('s-2', 'middle call', ['src/cli/a.ts']);
    dated('s-2', '2026-11-03 10:00:00');
    decide('s-3', 'newest call', []);
    dated('s-3', '2026-11-03 11:30:00');

    const page = sheet();

    expect(page).toContain('3 decisions, newest first.');
    expect(page.match(/<h3 class="state-group">[^<]*<\/h3>/g)).toEqual([
      '<h3 class="state-group">2026-11-03</h3>',
      '<h3 class="state-group">2026-11-02</h3>',
    ]);
    expect(page.indexOf('newest call')).toBeLessThan(page.indexOf('middle call'));
    expect(page.indexOf('middle call')).toBeLessThan(page.indexOf('oldest call'));
    expect(page).toContain('#1</span> s-1, 09:15 UTC</div>');
    expect(page).toContain(
      '<div class="fact">alternatives: keep it</div><div class="fact">or drop it</div>',
    );
    expect(page).toContain('<div class="fact"><code>src/core/a.ts</code></div>');
    expect(page).not.toMatch(/<svg|treemap|by module/i);

    dated('s-1', 'torn');
    const torn = sheet();
    expect(torn).toContain('<h3 class="state-group">(no date recorded)</h3>');
    expect(torn).toContain('#1</span> s-1</div>');
  });

  it('shows only the newest 20 records', () => {
    for (let i = 1; i <= 25; i++) decide(`s-${i}`, `decision ${i}`, []);
    dated('s-1', '2026-01-01 00:00:00');

    const page = sheet();

    expect(page).toContain('25 decisions; the newest 20 shown.');
    expect(rows(page)).toHaveLength(20);
    expect(rows(page).every((row) => row === '<li class="decision">')).toBe(true);
    expect(page).not.toMatch(/data-|hidden|2026-01-01/);
    expect(page).not.toContain('decision 1<');
  });

  it('escapes every store string and file name, markup and control characters alike', () => {
    const evil = '<img src=x onerror=alert(1)>\u001b[31m\u009b2J‮';
    decide('s-evil', `${evil}\nsecond ${evil}`, [`src/${evil}.ts`], evil);
    seedSession('<b>s</b>');
    insertDecisionRecord(db, { sessionId: '<b>s</b>', summary: 's', files: [] });

    const page = sheet();

    expect(page).not.toMatch(/<img|<b>/);
    expect(page).not.toMatch(CONTROL);
    expect(page).not.toContain('‮');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).toContain('(unminted session id)');
  });
});
