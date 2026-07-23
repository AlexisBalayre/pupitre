import type { Database } from 'better-sqlite3';

export interface DecisionRecordRow {
  id: number;
  session_id: string;
  summary: string;
  alternatives: string | null;
  conventions: string | null;
  /** JSON array of repo-relative paths the merge touched. */
  files: string;
  created_at: string;
}

export interface NewDecisionRecordInput {
  sessionId: string;
  summary: string;
  alternatives?: string;
  conventions?: string;
  files: string[];
}

export function insertDecisionRecord(db: Database, input: NewDecisionRecordInput): number {
  const row = db
    .prepare(
      `INSERT INTO decision_records (session_id, summary, alternatives, conventions, files)
       VALUES (@sessionId, @summary, @alternatives, @conventions, @files) RETURNING id`,
    )
    .get({
      sessionId: input.sessionId,
      summary: input.summary,
      alternatives: input.alternatives ?? null,
      conventions: input.conventions ?? null,
      files: JSON.stringify(input.files),
    }) as { id: number };
  return row.id;
}

/**
 * Records newest first, optionally filtered to those touching a module — a
 * path prefix (`src/core`) or a single file (docs/02: `pup log core/net`).
 */
export function listDecisionRecords(db: Database, module?: string): DecisionRecordRow[] {
  const rows = db
    .prepare('SELECT * FROM decision_records ORDER BY id DESC')
    .all() as DecisionRecordRow[];
  if (!module) return rows;
  const prefix = module.replace(/\/$/, '');
  return rows.filter((row) =>
    (JSON.parse(row.files) as string[]).some(
      (file) => file === prefix || file.startsWith(`${prefix}/`),
    ),
  );
}
