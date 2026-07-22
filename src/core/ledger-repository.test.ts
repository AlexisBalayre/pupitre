import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStore } from './db.client.js';
import { insertLedgerEntry, listLedgerEntries } from './ledger.repository.js';
import { ensureProject } from './session.repository.js';

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
});
