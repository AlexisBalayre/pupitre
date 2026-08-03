import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from './db.client.js';

describe('openStore', () => {
  it('creates the schema with WAL mode and foreign keys', () => {
    const db = openStore(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(tables).toEqual([
      'baseline_history',
      'decision_records',
      'events',
      'ledger_entries',
      'overlaps',
      'projects',
      'sessions',
      'tasks',
      'watcher_beats',
    ]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('adds a table missing from a pre-existing store on reopen', () => {
    // SCHEMA runs on every open, so a store created before a table existed
    // gains it without a MIGRATIONS entry (those are for added columns only).
    const dbPath = join(mkdtempSync(join(tmpdir(), 'pup-store-')), 'pup.db');
    const old = openStore(dbPath);
    old.exec('DROP TABLE baseline_history');
    old.close();

    const reopened = openStore(dbPath);
    expect(
      reopened
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'baseline_history'",
        )
        .get(),
    ).toBeDefined();
    reopened.close();
  });

  it('rejects sessions referencing a missing task', () => {
    const db = openStore(':memory:');
    expect(() =>
      db
        .prepare(
          "INSERT INTO sessions (id, task_id, worktree_path, branch, profile_hash) VALUES ('s1', 'nope', '/tmp/w', 'b', 'h')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });
});
