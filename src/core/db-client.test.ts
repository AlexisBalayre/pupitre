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

  it('drops a column a pre-existing store still has, keeping its rows', () => {
    // Unlike the additive entries, this migration runs while the column is
    // still present. `tasks.status` duplicated session state and was never
    // read; the backlog derives it from the sessions table (decision 40).
    const dbPath = join(mkdtempSync(join(tmpdir(), 'pup-store-')), 'pup.db');
    const old = openStore(dbPath);
    old.exec("ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
    old.prepare("INSERT INTO projects (id, repo_path) VALUES ('p1', '/repo')").run();
    old.prepare("INSERT INTO tasks (id, project_id, spec) VALUES ('t-1', 'p1', '{}')").run();
    old.close();

    const reopened = openStore(dbPath);

    const columns = (reopened.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain('status');
    expect(reopened.prepare('SELECT id FROM tasks').all()).toEqual([{ id: 't-1' }]);
    // Idempotent: the guard sees the column already gone on the next open.
    reopened.close();
    const again = openStore(dbPath);
    expect(again.prepare('SELECT id FROM tasks').all()).toEqual([{ id: 't-1' }]);
    again.close();
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
