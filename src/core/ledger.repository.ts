import type { Database } from 'better-sqlite3';

export interface LedgerEntryRow {
  id: number;
  project_id: string;
  description: string;
  /** JSON array of repo-relative paths. */
  files: string;
  reason: string;
  accepted_by: string;
  review_by: string;
  status: 'open' | 'closed';
  created_at: string;
}

export interface NewLedgerEntryInput {
  projectId: string;
  description: string;
  files: string[];
  reason: string;
  acceptedBy: string;
  reviewBy: string;
}

export function insertLedgerEntry(db: Database, input: NewLedgerEntryInput): number {
  const row = db
    .prepare(
      `INSERT INTO ledger_entries (project_id, description, files, reason, accepted_by, review_by)
       VALUES (@projectId, @description, @files, @reason, @acceptedBy, @reviewBy) RETURNING id`,
    )
    .get({ ...input, files: JSON.stringify(input.files) }) as { id: number };
  return row.id;
}

/** Open entries oldest first (docs/04: `pup debt` surfaces the longest-held debt on top). */
export function listLedgerEntries(
  db: Database,
  projectId: string,
  status: 'open' | 'closed' = 'open',
): LedgerEntryRow[] {
  return db
    .prepare(
      'SELECT * FROM ledger_entries WHERE project_id = ? AND status = ? ORDER BY created_at, id',
    )
    .all(projectId, status) as LedgerEntryRow[];
}
