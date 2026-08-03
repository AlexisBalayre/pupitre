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
  status TEXT NOT NULL DEFAULT 'open',
  origin TEXT NOT NULL DEFAULT 'human' CHECK (origin IN ('human', 'audit', 'rejection')),
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
const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  {
    table: 'decision_records',
    column: 'files',
    ddl: "ALTER TABLE decision_records ADD COLUMN files TEXT NOT NULL DEFAULT '[]'",
  },
];

function applyMigrations(db: Database.Database): void {
  for (const migration of MIGRATIONS) {
    const columns = db.pragma(`table_info(${migration.table})`) as { name: string }[];
    if (!columns.some((c) => c.name === migration.column)) db.exec(migration.ddl);
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
