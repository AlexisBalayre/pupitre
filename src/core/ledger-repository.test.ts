import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStore } from './db.client.js';
import {
  closeLedgerEntry,
  hasOpenLedgerEntry,
  insertLedgerEntry,
  listLedgerEntries,
  listOverdueLedgerEntries,
  type NewLedgerEntryInput,
} from './ledger.repository.js';
import { ensureProject } from './session.repository.js';

function entryInput(overrides: Partial<NewLedgerEntryInput> = {}): NewLedgerEntryInput {
  return {
    projectId: 'proj-1',
    description: 'shortcut',
    files: [],
    reason: 'r',
    acceptedBy: 'human',
    reviewBy: 'c',
    ...overrides,
  };
}

describe('ledger repository', () => {
  let db: Database;
  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, 'proj-1', '/repo');
  });

  it('creates an open entry and round-trips the files list', () => {
    const id = insertLedgerEntry(db, {
      projectId: 'proj-1',
      description: 'Oversize diff on session s1',
      files: ['src/a.ts', 'src/b.ts'],
      reason: 'release deadline',
      acceptedBy: 'human',
      reviewBy: 'before adding a second provider',
    });
    const [entry] = listLedgerEntries(db, 'proj-1');
    expect(entry?.id).toBe(id);
    expect(entry?.status).toBe('open');
    expect(JSON.parse(entry?.files ?? '[]')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('lists open entries oldest first and filters by status', () => {
    insertLedgerEntry(db, {
      projectId: 'proj-1',
      description: 'first',
      files: [],
      reason: 'r',
      acceptedBy: 'human',
      reviewBy: 'c',
    });
    insertLedgerEntry(db, {
      projectId: 'proj-1',
      description: 'second',
      files: [],
      reason: 'r',
      acceptedBy: 'human',
      reviewBy: 'c',
    });
    expect(listLedgerEntries(db, 'proj-1').map((e) => e.description)).toEqual(['first', 'second']);
    expect(listLedgerEntries(db, 'proj-1', 'closed')).toEqual([]);
  });

  it('closes an open entry once, then reports it as gone', () => {
    const id = insertLedgerEntry(db, entryInput());

    expect(closeLedgerEntry(db, id)).toBe(true);
    expect(closeLedgerEntry(db, id)).toBe(false);
    expect(listLedgerEntries(db, 'proj-1')).toEqual([]);
    expect(listLedgerEntries(db, 'proj-1', 'closed')).toHaveLength(1);
  });

  it('reports an identical open entry as already present', () => {
    insertLedgerEntry(db, entryInput());

    expect(hasOpenLedgerEntry(db, entryInput())).toBe(true);
    expect(hasOpenLedgerEntry(db, entryInput({ reason: 'other reason' }))).toBe(false);
  });

  it('no longer reports an entry as present once it is closed', () => {
    const id = insertLedgerEntry(db, entryInput());
    closeLedgerEntry(db, id);

    expect(hasOpenLedgerEntry(db, entryInput())).toBe(false);
  });

  it('reports only date-parseable review-by conditions in the past as overdue', () => {
    insertLedgerEntry(db, entryInput({ description: 'past', reviewBy: '2026-01-01' }));
    insertLedgerEntry(db, entryInput({ description: 'future', reviewBy: '2099-12-31' }));
    insertLedgerEntry(
      db,
      entryInput({ description: 'event', reviewBy: 'before adding a second provider' }),
    );

    const overdue = listOverdueLedgerEntries(db, 'proj-1', new Date('2026-07-22'));

    expect(overdue.map((e) => e.description)).toEqual(['past']);
  });
});
