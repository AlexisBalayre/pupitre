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
      'decision_records',
      'events',
      'ledger_entries',
      'projects',
      'sessions',
      'tasks',
    ]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
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
