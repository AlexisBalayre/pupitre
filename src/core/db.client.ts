import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type SessionState =
  | 'queued'
  | 'running'
  | 'awaiting-review'
  | 'merged'
  | 'killed'
  | 'rejected'
  | 'blocked';

export type EventType =
  | 'tool_call'
  | 'scope_violation'
  | 'gate_result'
  | 'merge'
  | 'steer'
  | 'interrupt'
  | 'config_drift'
  | 'session_done'
  | 'handoff_ready'
  | 'respawn'
  | 'scope_overlap'
  | 'utility_call';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  adapters TEXT NOT NULL DEFAULT '[]',
  baseline TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  spec TEXT NOT NULL,
  role TEXT,
  origin TEXT NOT NULL DEFAULT 'human' CHECK (origin IN ('human', 'audit', 'rejection', 'conductor')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  worktree_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  tmux_target TEXT,
  pid INTEGER,
  state TEXT NOT NULL DEFAULT 'queued',
  profile_hash TEXT NOT NULL,
  transcript_path TEXT,
  reject_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  description TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  accepted_by TEXT NOT NULL,
  review_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  summary TEXT NOT NULL,
  alternatives TEXT,
  conventions TEXT,
  files TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS overlaps (
  session_a TEXT NOT NULL,
  session_b TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_a, session_b)
);

CREATE TABLE IF NOT EXISTS watcher_beats (
  project_id TEXT PRIMARY KEY,
  beat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS baseline_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  captured_at TEXT NOT NULL,
  stages TEXT NOT NULL,
  debt TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
CREATE INDEX IF NOT EXISTS idx_ledger_status ON ledger_entries(project_id, status);
CREATE INDEX IF NOT EXISTS idx_baseline_history_captured ON baseline_history(project_id, captured_at);
`;

/** Additive columns missing from stores created before the column existed. */
/** `add` runs when the column is absent, `drop` when it is still present. */
const MIGRATIONS: { table: string; column: string; kind: 'add' | 'drop'; ddl: string }[] = [
  {
    table: 'decision_records',
    column: 'files',
    kind: 'add',
    ddl: "ALTER TABLE decision_records ADD COLUMN files TEXT NOT NULL DEFAULT '[]'",
  },
  {
    // Written on every insert and on merge, read by nothing. The backlog asks
    // the sessions table instead, so a second copy of session state could only
    // drift (decision 40).
    table: 'tasks',
    column: 'status',
    kind: 'drop',
    ddl: 'ALTER TABLE tasks DROP COLUMN status',
  },
];

/**
 * The origin a conductor-authored task is recorded under (decision 47). A
 * store created before it existed carries a CHECK that refuses it, and SQLite
 * cannot alter a CHECK in place, so the table is rebuilt once: copied under a
 * new name with the current constraint, swapped in, rows and ids intact. The
 * marker is what the rebuild looks for in the stored table SQL.
 */
const TASKS_ORIGIN_MARKER = "'conductor'";
const TASKS_REBUILD = `
BEGIN;
CREATE TABLE tasks_rebuilt (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  spec TEXT NOT NULL,
  role TEXT,
  origin TEXT NOT NULL DEFAULT 'human' CHECK (origin IN ('human', 'audit', 'rejection', 'conductor')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO tasks_rebuilt (id, project_id, spec, role, origin, created_at)
  SELECT id, project_id, spec, role, origin, created_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_rebuilt RENAME TO tasks;
COMMIT;
`;

/**
 * Rebuild `tasks` when its stored CHECK predates the conductor origin. Foreign
 * keys are off for the swap — `sessions.task_id` points at the table by name,
 * and the name is gone between the drop and the rename — and back on after,
 * where `foreign_key_check` is empty because every row was copied. Tolerated
 * like the drop migration: a lock held by a concurrent pup fails the rebuild,
 * and the next open retries it, while a throw here would take every command.
 */
function rebuildTasksForConductorOrigin(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes(TASKS_ORIGIN_MARKER)) return;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(TASKS_REBUILD);
  } catch {
    // The rollback can fail on the same lock the commit did; the transaction
    // dies with the connection either way, and the tolerance must hold.
    try {
      if (db.inTransaction) db.exec('ROLLBACK');
    } catch {
      // Retried on the next open.
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function applyMigrations(db: Database.Database): void {
  rebuildTasksForConductorOrigin(db);
  for (const migration of MIGRATIONS) {
    const columns = db.pragma(`table_info(${migration.table})`) as { name: string }[];
    const present = columns.some((c) => c.name === migration.column);
    if (present !== (migration.kind === 'drop')) continue;
    if (migration.kind === 'add') {
      db.exec(migration.ddl);
      continue;
    }
    // A drop is a table rewrite, so it can fail on a lock held by a concurrent
    // pup, or on a user-added index over the column. Nothing reads a dropped
    // column, so leaving it costs nothing — whereas throwing here would make
    // `openStore` fail and take every pup command with it.
    try {
      db.exec(migration.ddl);
    } catch {
      // Retried on the next open.
    }
  }
}

export function openStore(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  applyMigrations(db);
  return db;
}
