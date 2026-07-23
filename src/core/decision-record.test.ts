import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../claude/utility.service.js', () => ({
  runUtility: vi.fn(),
}));

import { runUtility } from '../claude/utility.service.js';
import { openStore } from './db.client.js';
import {
  deleteDecisionRecord,
  getDecisionRecord,
  insertDecisionRecord,
  listDecisionRecords,
  updateDecisionRecordSummary,
} from './decision-record.repository.js';
import { draftDecisionRecord } from './decision-record.service.js';
import { ensureProject, insertSession, insertTask } from './session.repository.js';
import type { TaskId, TaskSpec } from './types/profile.types.js';

const spec: TaskSpec = {
  id: 'task-s1' as TaskId,
  goal: 'Add retry logic to the fetch client',
  scopeIn: ['src/net/**'],
  acceptance: ['retries three times'],
};

function seedSession(db: Database, id: string): void {
  ensureProject(db, 'proj-1', '/repo');
  insertTask(db, { id: `task-${id}`, projectId: 'proj-1', spec: JSON.stringify(spec) });
  insertSession(db, {
    id,
    taskId: `task-${id}`,
    worktreePath: `/repo/.worktrees/${id}`,
    branch: `pup/${id}`,
    profileHash: 'hash',
  });
}

describe('decision-record repository', () => {
  let db: Database;
  beforeEach(() => {
    db = openStore(':memory:');
    seedSession(db, 's1');
  });

  it('round-trips a record and lists newest first', () => {
    insertDecisionRecord(db, { sessionId: 's1', summary: 'first', files: ['src/a.ts'] });
    insertDecisionRecord(db, { sessionId: 's1', summary: 'second', files: ['src/b.ts'] });

    expect(listDecisionRecords(db).map((r) => r.summary)).toEqual(['second', 'first']);
  });

  it('gets, updates, and deletes a single record by id', () => {
    const id = insertDecisionRecord(db, { sessionId: 's1', summary: 'draft', files: ['src/a.ts'] });

    expect(getDecisionRecord(db, id)?.summary).toBe('draft');

    updateDecisionRecordSummary(db, id, 'human-edited');
    expect(getDecisionRecord(db, id)?.summary).toBe('human-edited');

    deleteDecisionRecord(db, id);
    expect(getDecisionRecord(db, id)).toBeUndefined();
  });

  it('filters by module prefix on whole path segments only', () => {
    insertDecisionRecord(db, { sessionId: 's1', summary: 'net', files: ['src/net/client.ts'] });
    insertDecisionRecord(db, { sessionId: 's1', summary: 'nettle', files: ['src/nettle/x.ts'] });
    insertDecisionRecord(db, { sessionId: 's1', summary: 'exact', files: ['docs/adr.md'] });

    expect(listDecisionRecords(db, 'src/net').map((r) => r.summary)).toEqual(['net']);
    expect(listDecisionRecords(db, 'docs/adr.md').map((r) => r.summary)).toEqual(['exact']);
  });
});

describe('draftDecisionRecord', () => {
  let db: Database;
  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    seedSession(db, 's1');
  });

  const input = {
    sessionId: 's1',
    spec,
    files: ['src/net/client.ts'],
    commitSubjects: ['add retry'],
  };

  it('stores the drafted record when the utility returns valid JSON', () => {
    vi.mocked(runUtility).mockReturnValue({
      ok: true,
      output:
        'Here it is:\n{"summary": "Chose exponential backoff.", "alternatives": "Fixed delay.", "conventions": null}',
    });

    draftDecisionRecord(db, input);

    const [record] = listDecisionRecords(db);
    expect(record).toMatchObject({
      summary: 'Chose exponential backoff.',
      alternatives: 'Fixed delay.',
      conventions: null,
    });
    expect(JSON.parse(record?.files ?? '[]')).toEqual(['src/net/client.ts']);
  });

  it('falls back to a mechanical record when the utility fails', () => {
    vi.mocked(runUtility).mockReturnValue({ ok: false, output: 'timeout' });

    draftDecisionRecord(db, input);

    const [record] = listDecisionRecords(db);
    expect(record?.summary).toContain('Add retry logic');
    expect(record?.summary).toContain('mechanical record');
  });

  it('falls back when the utility output has no parseable summary', () => {
    vi.mocked(runUtility).mockReturnValue({ ok: true, output: 'sorry, no JSON here' });

    draftDecisionRecord(db, input);

    expect(listDecisionRecords(db)[0]?.summary).toContain('mechanical record');
  });

  it('logs a utility_call event recording which path was taken', () => {
    vi.mocked(runUtility).mockReturnValue({ ok: false, output: 'boom' });

    draftDecisionRecord(db, input);

    const event = db.prepare("SELECT payload FROM events WHERE type = 'utility_call'").get() as {
      payload: string;
    };
    expect(JSON.parse(event.payload)).toMatchObject({ kind: 'decision-record-draft', ok: false });
  });
});

describe('store migration', () => {
  it('adds the files column to a store created before the column existed', () => {
    const dbPath = join(realpathSync(mkdtempSync(join(tmpdir(), 'pup-store-'))), 'state.db');
    const legacy = openStore(dbPath);
    legacy.exec('DROP TABLE decision_records');
    legacy.exec(`CREATE TABLE decision_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      summary TEXT NOT NULL,
      alternatives TEXT,
      conventions TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    legacy.close();

    const migrated = openStore(dbPath);

    seedSession(migrated, 's1');
    insertDecisionRecord(migrated, { sessionId: 's1', summary: 'ok', files: ['src/a.ts'] });
    expect(listDecisionRecords(migrated, 'src')[0]?.summary).toBe('ok');
    migrated.close();
  });
});
