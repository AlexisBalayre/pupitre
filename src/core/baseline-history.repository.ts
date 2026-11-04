import type { Database } from 'better-sqlite3';
import { parseJsonOr } from './report-data.utils.js';
import type { BaselineStageResult, DebtBaseline } from './types/init.types.js';

export interface BaselineHistoryRow {
  id: number;
  project_id: string;
  /** ISO timestamp copied from ProjectBaseline.capturedAt, not a DB default. */
  captured_at: string;
  /** JSON BaselineStageResult[]. */
  stages: string;
  /** JSON DebtBaseline; null when no adapter could measure debt. */
  debt: string | null;
}

export interface NewBaselineHistoryInput {
  projectId: string;
  capturedAt: string;
  stages: BaselineStageResult[];
  debt?: DebtBaseline;
}

export function appendBaselineHistory(db: Database, input: NewBaselineHistoryInput): number {
  const row = db
    .prepare(
      `INSERT INTO baseline_history (project_id, captured_at, stages, debt)
       VALUES (@projectId, @capturedAt, @stages, @debt) RETURNING id`,
    )
    .get({
      projectId: input.projectId,
      capturedAt: input.capturedAt,
      stages: JSON.stringify(input.stages),
      debt: input.debt !== undefined ? JSON.stringify(input.debt) : null,
    }) as { id: number };
  return row.id;
}

/**
 * True when this capture is already recorded. Guards the backfill in
 * `initProject` (decision 38): a baseline written before the history table
 * existed is seeded exactly once, however many captures run after the upgrade.
 */
export function hasBaselineHistoryEntry(
  db: Database,
  projectId: string,
  capturedAt: string,
): boolean {
  return (
    db
      .prepare('SELECT 1 FROM baseline_history WHERE project_id = ? AND captured_at = ? LIMIT 1')
      .get(projectId, capturedAt) !== undefined
  );
}

/**
 * All captures oldest first — trend order for `pup report`'s drift section.
 * `id` breaks ties so two rows in the same millisecond keep insertion order.
 */
export function listBaselineHistory(db: Database, projectId: string): BaselineHistoryRow[] {
  return db
    .prepare('SELECT * FROM baseline_history WHERE project_id = ? ORDER BY captured_at, id')
    .all(projectId) as BaselineHistoryRow[];
}

/**
 * The newest capture taken at or before `at`, the one a "change over N days"
 * figure compares the current baseline with (decision 98). `captured_at` is an
 * ISO string with a Z, so it orders as text.
 */
export function baselineHistoryAsOf(
  db: Database,
  projectId: string,
  at: Date,
): BaselineHistoryRow | undefined {
  return db
    .prepare(
      `SELECT * FROM baseline_history WHERE project_id = ? AND captured_at <= ?
       ORDER BY captured_at DESC, id DESC LIMIT 1`,
    )
    .get(projectId, at.toISOString()) as BaselineHistoryRow | undefined;
}

/**
 * The newest `limit` captures, oldest of them first: a trend that draws the
 * last few reads only those, however long the history grows (decision 98).
 */
export function listRecentBaselineHistory(
  db: Database,
  projectId: string,
  limit: number,
): BaselineHistoryRow[] {
  const newestFirst = db
    .prepare(
      `SELECT * FROM baseline_history WHERE project_id = ?
       ORDER BY captured_at DESC, id DESC LIMIT ?`,
    )
    .all(projectId, limit) as BaselineHistoryRow[];
  return newestFirst.reverse();
}

/** A capture's debt column, undefined when nothing measured debt then or it does not parse. */
export function captureDebt(row: BaselineHistoryRow): DebtBaseline | undefined {
  return row.debt === null ? undefined : parseJsonOr<DebtBaseline | undefined>(row.debt, undefined);
}
