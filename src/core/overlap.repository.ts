import type { Database } from 'better-sqlite3';

import type { OverlapPair } from './types/overlap.types.js';

export type { OverlapPair } from './types/overlap.types.js';

/**
 * Overlaps are current state, not history: each watcher scan replaces the
 * whole set in one transaction so status never sees a half-updated radar.
 */
export function replaceOverlaps(db: Database, pairs: OverlapPair[]): void {
  const tx = db.transaction((rows: OverlapPair[]) => {
    db.prepare('DELETE FROM overlaps').run();
    const insert = db.prepare(
      'INSERT INTO overlaps (session_a, session_b, files) VALUES (?, ?, ?)',
    );
    for (const pair of rows) {
      insert.run(pair.sessionA, pair.sessionB, JSON.stringify(pair.files));
    }
  });
  tx(pairs);
}

export function listOverlaps(db: Database): OverlapPair[] {
  const rows = db
    .prepare('SELECT session_a, session_b, files FROM overlaps ORDER BY session_a, session_b')
    .all() as { session_a: string; session_b: string; files: string }[];
  return rows.map((row) => ({
    sessionA: row.session_a,
    sessionB: row.session_b,
    files: JSON.parse(row.files) as string[],
  }));
}

export function recordWatcherBeat(db: Database, projectId: string, at: Date): void {
  db.prepare(
    `INSERT INTO watcher_beats (project_id, beat_at) VALUES (?, ?)
     ON CONFLICT(project_id) DO UPDATE SET beat_at = excluded.beat_at`,
  ).run(projectId, at.toISOString());
}

export function getWatcherBeat(db: Database, projectId: string): Date | undefined {
  const row = db.prepare('SELECT beat_at FROM watcher_beats WHERE project_id = ?').get(projectId) as
    | { beat_at: string }
    | undefined;
  return row ? new Date(row.beat_at) : undefined;
}
