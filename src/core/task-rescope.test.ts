import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStore } from './db.client.js';
import { listDecisionRecords } from './decision-record.repository.js';
import { InvalidProfileError } from './profile.errors.js';
import { auditScope } from './scope-audit.utils.js';
import {
  ensureProject,
  insertSession,
  insertTask,
  listEvents,
  readTaskSpec,
} from './session.repository.js';
import { rescopeTask } from './task-rescope.service.js';

const SPEC = {
  id: 't-1',
  goal: 'g',
  scopeIn: ['src/core/**'],
  scopeOut: ['src/core/secret.ts'],
  acceptance: ['a'],
};

describe('rescopeTask (decision 115)', () => {
  let db: Database;
  const launched = (id: string, state: string) => {
    insertSession(db, {
      id,
      taskId: 't-1',
      worktreePath: `/repo/.worktrees/${id}`,
      branch: `pup/${id}`,
      profileHash: 'hash',
    });
    db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(state, id);
  };

  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, 'proj-1', '/repo');
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: JSON.stringify(SPEC) });
  });

  it.each(['merged', 'awaiting-review', 'blocked'])(
    'appends globs to a task whose session is %s, and records who approved them',
    (state) => {
      launched('s1', state);

      expect(rescopeTask(db, 't-1', ['src/cli/index.ts', 'src/core/**'])).toEqual({
        status: 'rescoped',
        sessionId: 's1',
        added: ['src/cli/index.ts'],
      });

      expect(readTaskSpec(db, 't-1')).toEqual({
        ...SPEC,
        scopeIn: ['src/core/**', 'src/cli/index.ts'],
      });
      const rescope = listEvents(db, 's1').find((event) => event.type === 'rescope');
      expect(JSON.parse(rescope?.payload ?? '{}')).toEqual({
        task: 't-1',
        added: ['src/cli/index.ts'],
        by: 'operator',
      });
      const [record] = listDecisionRecords(db);
      expect(record?.session_id).toBe('s1');
      expect(record?.summary).toContain('src/cli/index.ts');
      expect(JSON.parse(record?.files ?? '[]')).toEqual(['src/cli/index.ts']);
    },
  );

  // A killed session hands its task back; the merged one still claims it.
  it('records the rescope on the claiming session past a killed retry', () => {
    launched('s1', 'merged');
    launched('s2', 'killed');

    expect(rescopeTask(db, 't-1', ['docs/**'])).toMatchObject({ sessionId: 's1' });
  });

  it.each(['queued', 'running', 'rejected'])(
    'refuses while a session is %s, writing nothing',
    (state) => {
      launched('s1', 'merged');
      launched('s2', state);

      expect(rescopeTask(db, 't-1', ['docs/**'])).toEqual({ status: 'working', sessionId: 's2' });
      expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**']);
      expect(listEvents(db, 's1')).toEqual([]);
      expect(listDecisionRecords(db)).toEqual([]);
    },
  );

  it('refuses a task nobody claimed, and one that does not exist', () => {
    expect(rescopeTask(db, 't-1', ['docs/**'])).toEqual({ status: 'unclaimed' });
    launched('s1', 'killed');
    expect(rescopeTask(db, 't-1', ['docs/**'])).toEqual({ status: 'unclaimed' });
    expect(rescopeTask(db, 't-gone', ['docs/**'])).toEqual({ status: 'unknown' });
  });

  it('writes nothing when every glob is already in scope', () => {
    launched('s1', 'merged');

    expect(rescopeTask(db, 't-1', ['src/core/**'])).toEqual({
      status: 'unchanged',
      sessionId: 's1',
    });
    expect(listEvents(db, 's1')).toEqual([]);
    expect(listDecisionRecords(db)).toEqual([]);
  });

  it('refuses a glob the hooks could not hold', () => {
    launched('s1', 'merged');

    expect(() => rescopeTask(db, 't-1', ['src/\n**'])).toThrow(InvalidProfileError);
    expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**']);
  });

  // What the gate's scope-audit stage runs, on the spec it reads back.
  it('lets a re-gate pass scope-audit for the added paths, scope-out still winning', () => {
    launched('s1', 'merged');
    const changed = ['src/core/a.ts', 'src/cli/index.ts', 'src/core/secret.ts'];
    const audit = () => {
      const spec = readTaskSpec(db, 't-1');
      return auditScope(changed, spec.scopeIn, spec.scopeOut).map((v) => v.path);
    };
    expect(audit()).toEqual(['src/cli/index.ts', 'src/core/secret.ts']);

    rescopeTask(db, 't-1', ['src/cli/index.ts']);

    expect(audit()).toEqual(['src/core/secret.ts']);
  });
});
