import type { Database } from 'better-sqlite3';
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
