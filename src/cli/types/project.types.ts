import type Database from 'better-sqlite3';

export interface ResolvedProject {
  repoPath: string;
  db: Database.Database;
}

export interface ProjectRow {
  id: string;
  repo_path: string;
  dormant_at: string | null;
}
