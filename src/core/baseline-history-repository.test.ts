import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendBaselineHistory,
  hasBaselineHistoryEntry,
  listBaselineHistory,
  type NewBaselineHistoryInput,
} from './baseline-history.repository.js';
import { openStore } from './db.client.js';
import { ensureProject } from './session.repository.js';

function historyInput(overrides: Partial<NewBaselineHistoryInput> = {}): NewBaselineHistoryInput {
  return {
    projectId: 'proj-1',
    capturedAt: '2026-08-03T10:00:00.000Z',
    stages: [{ stage: 'build', status: 'pass', durationMs: 5 }],
    ...overrides,
  };
}

describe('baseline history repository', () => {
  let db: Database;
  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, 'proj-1', '/repo');
  });

  it('appends a capture and round-trips stages and debt', () => {
    const id = appendBaselineHistory(
      db,
      historyInput({ debt: { duplicatedLines: 184, coverageRatio: 0.835 } }),
    );

    const [row] = listBaselineHistory(db, 'proj-1');
    expect(row?.id).toBe(id);
    expect(row?.captured_at).toBe('2026-08-03T10:00:00.000Z');
    expect(JSON.parse(row?.stages ?? '[]')).toEqual([
      { stage: 'build', status: 'pass', durationMs: 5 },
    ]);
    expect(JSON.parse(row?.debt ?? '{}')).toEqual({ duplicatedLines: 184, coverageRatio: 0.835 });
  });

  it('stores a null debt column when the capture measured no debt', () => {
    appendBaselineHistory(db, historyInput());

    expect(listBaselineHistory(db, 'proj-1')[0]?.debt).toBeNull();
  });

  it('lists captures oldest first regardless of insertion order', () => {
    appendBaselineHistory(db, historyInput({ capturedAt: '2026-08-02T10:00:00.000Z' }));
    appendBaselineHistory(db, historyInput({ capturedAt: '2026-08-01T10:00:00.000Z' }));
    appendBaselineHistory(db, historyInput({ capturedAt: '2026-08-03T10:00:00.000Z' }));

    expect(listBaselineHistory(db, 'proj-1').map((r) => r.captured_at)).toEqual([
      '2026-08-01T10:00:00.000Z',
      '2026-08-02T10:00:00.000Z',
      '2026-08-03T10:00:00.000Z',
    ]);
  });

  it('keeps insertion order for two captures in the same millisecond', () => {
    const first = appendBaselineHistory(db, historyInput());
    const second = appendBaselineHistory(db, historyInput());

    expect(listBaselineHistory(db, 'proj-1').map((r) => r.id)).toEqual([first, second]);
  });

  it('lists only the requested project', () => {
    ensureProject(db, 'proj-2', '/other');
    appendBaselineHistory(db, historyInput());
    appendBaselineHistory(db, historyInput({ projectId: 'proj-2' }));

    expect(listBaselineHistory(db, 'proj-1')).toHaveLength(1);
    expect(listBaselineHistory(db, 'proj-2')).toHaveLength(1);
  });

  it('reports whether a capture timestamp is already recorded', () => {
    appendBaselineHistory(db, historyInput());

    expect(hasBaselineHistoryEntry(db, 'proj-1', '2026-08-03T10:00:00.000Z')).toBe(true);
    expect(hasBaselineHistoryEntry(db, 'proj-1', '2026-08-03T11:00:00.000Z')).toBe(false);
    expect(hasBaselineHistoryEntry(db, 'proj-2', '2026-08-03T10:00:00.000Z')).toBe(false);
  });
});
