import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStore } from './db.client.js';
import { closeLedgerEntry, insertLedgerEntry } from './ledger.repository.js';
import { projectId } from './paths.utils.js';
import { ensureProject } from './session.repository.js';
import {
  type DebtSheetEntry,
  payDownRanking,
  readDebtSheet,
  renderDebtSheet,
} from './web-dashboard-debt.service.js';

const REPO = '/repo';
const NOW = Date.parse('2026-10-26T12:00:00.000Z');

function entry(id: string, ageDays: number, files: string[]): DebtSheetEntry {
  return {
    id,
    description: `entry ${id}`,
    reason: 'r',
    acceptedBy: 'alexis',
    reviewBy: '2099-01-01',
    files,
    ageDays,
    overdue: false,
  };
}

describe('payDownRanking', () => {
  it('ranks files by their open entries weighted by age, oldest entries first in each', () => {
    const ranked = payDownRanking([
      // Two fresh entries on a.ts weigh 2; one 90-day-old entry on b.ts weighs 4.
      entry('1', 0, ['src/a.ts']),
      entry('2', 0, ['src/a.ts']),
      entry('3', 90, ['src/b.ts']),
      // c.ts: 1 + 1.5 = 2.5, and the 15-day entry also lands on a.ts (2 + 1.5).
      entry('4', 15, ['src/c.ts', 'src/a.ts']),
      entry('5', 0, ['src/c.ts']),
    ]);

    expect(ranked.map((file) => [file.file, file.weight])).toEqual([
      ['src/b.ts', 4],
      ['src/a.ts', 3.5],
      ['src/c.ts', 2.5],
    ]);
    expect(ranked[1]?.entries.map((e) => e.id)).toEqual(['4', '1', '2']);
  });

  it('breaks a tie on weight by entry count, then by path', () => {
    const ranked = payDownRanking([
      entry('1', 30, ['src/old.ts']),
      entry('2', 0, ['src/z-two.ts']),
      entry('3', 0, ['src/z-two.ts']),
      entry('4', 30, ['src/b-old.ts']),
    ]);

    expect(ranked.map((file) => file.file)).toEqual(['src/z-two.ts', 'src/b-old.ts', 'src/old.ts']);
  });

  it('keeps an entry that names no file on the list', () => {
    expect(payDownRanking([entry('1', 0, [])]).map((file) => file.file)).toEqual([
      '(no file named)',
    ]);
  });
});

describe('the Debt sheet', () => {
  let db: Database;

  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, projectId(REPO), REPO);
  });

  function file(description: string, files: string[], createdAt: string, reviewBy = '2099-01-01') {
    const id = insertLedgerEntry(db, {
      projectId: projectId(REPO),
      description,
      files,
      reason: `reason for ${description}`,
      acceptedBy: 'alexis',
      reviewBy,
    });
    db.prepare('UPDATE ledger_entries SET created_at = ? WHERE id = ?').run(createdAt, id);
    return id;
  }

  it('reads ages in whole days, overdue by the ledger rule, and leaves closed entries out', () => {
    file('Oversize diff (900 lines) merged from session s-1', ['src/a.ts'], '2026-10-24 11:00:00');
    file(
      'Complexity rise (+9 decision points) merged from session s-2',
      ['src/a.ts', 'src/a.ts'],
      '2026-07-01 00:00:00',
      '2026-08-01',
    );
    closeLedgerEntry(db, file('closed', [], '2026-10-01 00:00:00'));
    db.prepare('UPDATE ledger_entries SET files = ? WHERE description = ?').run(
      'not json',
      'Oversize diff (900 lines) merged from session s-1',
    );

    const entries = readDebtSheet(db, REPO, NOW);

    expect(entries.map((e) => [e.ageDays, e.overdue, e.files])).toEqual([
      [117, true, ['src/a.ts']],
      [2, false, []],
    ]);
  });

  it('counts entries by kind and by age, and names the files carrying the most', () => {
    file('Oversize diff (900 lines) merged from session s-1', ['src/a.ts'], '2026-10-25 00:00:00');
    file('Oversize diff (800 lines) merged from session s-2', ['src/a.ts'], '2026-10-10 00:00:00');
    file('Duplicated lines rose from 10 to 20 in session s-3', ['src/b.ts'], '2026-06-01 00:00:00');
    file('hand-filed shortcut', [], '2026-10-25 00:00:00');

    const page = renderDebtSheet(readDebtSheet(db, REPO, NOW));

    expect(page).toContain('4 open entries, 0 overdue, the oldest held 147 days.');
    expect(page).toContain(
      '<figcaption>By kind: oversize diff 2 · complexity rise 0 · duplicated lines 1 · other 1</figcaption>',
    );
    expect(page).toContain(
      '<figcaption>By age: under 1 week 2 · 1–4 weeks 1 · 1–3 months 0 · older 1</figcaption>',
    );
    expect(page).toContain(
      '<figcaption>Top 10 files by open entries: src/a.ts 2 · src/b.ts 1</figcaption>',
    );
    // b.ts's one 147-day entry outweighs a.ts's two recent ones.
    expect(page.indexOf('<code>src/b.ts</code>')).toBeLessThan(
      page.indexOf('<code>src/a.ts</code>'),
    );
    expect(page).toContain('reason: reason for hand-filed shortcut');
    expect(page).toContain('review by 2099-01-01, accepted by alexis, held 1 day');
  });

  it('says there is nothing to pay down on an empty ledger, with no chart', () => {
    const page = renderDebtSheet(readDebtSheet(db, REPO, NOW));

    expect(page).toContain('<p class="hint">No open debt — nothing to pay down.</p>');
    expect(page).not.toContain('<svg');
  });
});
