import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mayHaveOpenWindow } from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { listDecisionRecords } from './decision-record.repository.js';
import { globToRegExp } from './glob.utils.js';
import { InvalidProfileError } from './profile.errors.js';
import { auditScope } from './scope-audit.utils.js';
import {
  ensureProject,
  getSession,
  getTask,
  insertSession,
  insertTask,
  listEvents,
  readTaskSpec,
} from './session.repository.js';
import { rescopeTask } from './task-rescope.service.js';
import { assertPlannableSpec } from './task-spec.utils.js';
import type { RescopeCaller } from './types/session-event.types.js';

// The tmux boundary: by default no window of the task's is open, as the gate
// leaves a merged session's.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  mayHaveOpenWindow: vi.fn(),
}));

// The plan's own check, real unless a test stubs it.
vi.mock('./task-spec.utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-spec.utils.js')>();
  return { ...actual, assertPlannableSpec: vi.fn(actual.assertPlannableSpec) };
});

// What the CLI hands over of a caller it took for the operator.
const CALLER: RescopeCaller = { by: 'inferred-operator', tty: '/dev/ttys003', tmuxPane: '%4' };

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
      tmuxTarget: '%3',
    });
    db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(state, id);
  };

  beforeEach(() => {
    vi.mocked(mayHaveOpenWindow).mockReset().mockReturnValue(undefined);
    vi.mocked(assertPlannableSpec).mockReset();
    db = openStore(':memory:');
    ensureProject(db, 'proj-1', '/repo');
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: JSON.stringify(SPEC) });
  });

  it.each(['merged', 'awaiting-review', 'blocked'])(
    'appends globs to a task whose session is %s, and records who approved them',
    (state) => {
      launched('s1', state);

      expect(rescopeTask(db, 't-1', ['src/cli/index.ts', 'src/core/**'], CALLER)).toEqual({
        sessionId: 's1',
        added: ['src/cli/index.ts'],
        tier: 'critical',
        raised: false,
      });

      expect(readTaskSpec(db, 't-1')).toEqual({
        ...SPEC,
        scopeIn: ['src/core/**', 'src/cli/index.ts'],
      });
      const rescope = listEvents(db, 's1').find((event) => event.type === 'rescope');
      expect(JSON.parse(rescope?.payload ?? '{}')).toEqual({
        task: 't-1',
        added: ['src/cli/index.ts'],
        by: 'inferred-operator',
        tty: '/dev/ttys003',
        tmuxPane: '%4',
        tier: 'critical',
        raised: false,
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

    expect(rescopeTask(db, 't-1', ['docs/**'], CALLER)).toMatchObject({ sessionId: 's1' });
  });

  it.each(['queued', 'running', 'rejected'])(
    'refuses while a session is %s, writing nothing',
    (state) => {
      launched('s1', 'merged');
      launched('s2', state);

      expect(() => rescopeTask(db, 't-1', ['docs/**'], CALLER)).toThrow(
        'Session s2 is at work on t-1; rescope once it stops.',
      );
      expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**']);
      expect(listEvents(db, 's1')).toEqual([]);
      expect(listDecisionRecords(db)).toEqual([]);
    },
  );

  it('refuses a task nobody claimed, and one that does not exist', () => {
    expect(() => rescopeTask(db, 't-1', ['docs/**'], CALLER)).toThrow('No session has claimed t-1');
    launched('s1', 'killed');
    expect(() => rescopeTask(db, 't-1', ['docs/**'], CALLER)).toThrow('No session has claimed t-1');
    expect(() => rescopeTask(db, 't-gone', ['docs/**'], CALLER)).toThrow('No task t-gone.');
  });

  // The session's next window routes from its own stored tier, so a standard
  // task widened onto a critical area would climb the standard ladder.
  describe('the tier', () => {
    const standard = (taskTierStored: string | null) => {
      db.prepare('UPDATE tasks SET spec = ?, tier = ? WHERE id = ?').run(
        JSON.stringify({ ...SPEC, scopeIn: ['docs/**'], scopeOut: [] }),
        taskTierStored,
        't-1',
      );
      launched('s1', 'merged');
      db.prepare(
        "UPDATE sessions SET tier = 'standard', rung = 2, rung_reason = 'ci-fix-round' WHERE id = ?",
      ).run('s1');
    };

    it.each(['standard', null])(
      'raises a task stored %s and its session to critical, from the bottom rung',
      (stored) => {
        standard(stored);

        expect(rescopeTask(db, 't-1', ['src/core/merge-gate.service.ts'], CALLER)).toMatchObject({
          tier: 'critical',
          raised: true,
        });

        expect(getTask(db, 't-1')?.tier).toBe(stored === null ? null : 'critical');
        expect(getSession(db, 's1')).toMatchObject({
          tier: 'critical',
          rung: null,
          rung_reason: null,
        });
        const rescope = listEvents(db, 's1').find((event) => event.type === 'rescope');
        expect(JSON.parse(rescope?.payload ?? '{}')).toMatchObject({
          tier: 'critical',
          raised: true,
        });
      },
    );

    it('keeps a standard task standard when the added globs are', () => {
      standard('standard');

      expect(rescopeTask(db, 't-1', ['src/cli/index.ts'], CALLER)).toMatchObject({
        tier: 'standard',
        raised: false,
      });
      expect(getTask(db, 't-1')?.tier).toBe('standard');
      expect(getSession(db, 's1')).toMatchObject({ tier: 'standard', rung: 2 });
    });

    // `pup plan edit --tier standard` pinned it over a scope already critical:
    // only what the rescope adds can raise it.
    it('keeps a task pinned standard over a critical scope standard when the added globs are', () => {
      db.prepare("UPDATE tasks SET spec = ?, tier = 'standard' WHERE id = ?").run(
        JSON.stringify({ ...SPEC, scopeIn: ['src/core/merge-gate.service.ts'], scopeOut: [] }),
        't-1',
      );
      launched('s1', 'merged');
      db.prepare(
        "UPDATE sessions SET tier = 'standard', rung = 2, rung_reason = 'ci-fix-round' WHERE id = ?",
      ).run('s1');

      expect(rescopeTask(db, 't-1', ['docs/**'], CALLER)).toMatchObject({
        tier: 'standard',
        raised: false,
      });
      expect(getTask(db, 't-1')?.tier).toBe('standard');
      expect(getSession(db, 's1')).toMatchObject({
        tier: 'standard',
        rung: 2,
        rung_reason: 'ci-fix-round',
      });
    });

    // A relaunch after a kill routes from the task's row, so it is settled
    // from its own stored tier, not from the session's.
    it('raises a task stored standard under a session already critical', () => {
      standard('standard');
      db.prepare("UPDATE sessions SET tier = 'critical', rung = 1 WHERE id = ?").run('s1');

      expect(rescopeTask(db, 't-1', ['src/core/merge-gate.service.ts'], CALLER)).toMatchObject({
        tier: 'critical',
        raised: true,
      });
      expect(getTask(db, 't-1')?.tier).toBe('critical');
      expect(getSession(db, 's1')).toMatchObject({ tier: 'critical', rung: 1 });
    });

    // A session launched before routing stored no tier on either row: its next
    // window derives one from the scope-in, which is now the widened one.
    it('reports the tier the widened scope-in derives when neither row stored one', () => {
      db.prepare('UPDATE tasks SET spec = ? WHERE id = ?').run(
        JSON.stringify({ ...SPEC, scopeIn: ['docs/**'], scopeOut: [] }),
        't-1',
      );
      launched('s1', 'merged');

      expect(rescopeTask(db, 't-1', ['src/core/merge-gate.service.ts'], CALLER)).toMatchObject({
        tier: 'critical',
        raised: false,
      });
      expect(getTask(db, 't-1')?.tier).toBeNull();
      expect(getSession(db, 's1')?.tier).toBeNull();
    });

    it('never lowers a critical tier', () => {
      db.prepare("UPDATE tasks SET spec = ?, tier = 'critical' WHERE id = ?").run(
        JSON.stringify({ ...SPEC, scopeIn: ['docs/**'], scopeOut: [] }),
        't-1',
      );
      launched('s1', 'merged');
      db.prepare("UPDATE sessions SET tier = 'critical', rung = 1 WHERE id = ?").run('s1');

      expect(rescopeTask(db, 't-1', ['src/cli/index.ts'], CALLER)).toMatchObject({
        tier: 'critical',
        raised: false,
      });
      expect(getTask(db, 't-1')?.tier).toBe('critical');
      expect(getSession(db, 's1')).toMatchObject({ tier: 'critical', rung: 1 });
    });
  });

  it('writes nothing when every glob is already in scope', () => {
    launched('s1', 'merged');

    expect(rescopeTask(db, 't-1', ['src/core/**'], CALLER)).toEqual({
      sessionId: 's1',
      added: [],
      tier: 'critical',
      raised: false,
    });
    expect(listEvents(db, 's1')).toEqual([]);
    expect(listDecisionRecords(db)).toEqual([]);
  });

  // No glob the refusal table takes can fail the plan's own check today, and
  // the stored spec passed it on the way out of the store, so a stub stands
  // in for a gap opening between them: the widened spec still goes through
  // the check, and its refusal writes nothing.
  it('puts the widened spec through the plan check, writing nothing when it refuses', () => {
    launched('s1', 'merged');
    vi.mocked(assertPlannableSpec).mockImplementation((spec) => {
      if (spec.scopeIn.includes('docs/**')) throw new InvalidProfileError('plan check refused');
    });

    expect(() => rescopeTask(db, 't-1', ['docs/**'], CALLER)).toThrow('plan check refused');
    expect(vi.mocked(assertPlannableSpec)).toHaveBeenCalledWith({
      ...SPEC,
      scopeIn: ['src/core/**', 'docs/**'],
    });
    expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**']);
    expect(listEvents(db, 's1')).toEqual([]);
    expect(listDecisionRecords(db)).toEqual([]);
  });

  // A worker that ran `pup session done` is awaiting review with its window
  // still up: rescoping then would let it keep editing into the wider scope.
  it.each(['awaiting-review', 'blocked', 'merged'])(
    'refuses while a %s session has its window open, writing nothing',
    (state) => {
      launched('s1', state);
      vi.mocked(mayHaveOpenWindow).mockReturnValue({
        kind: 'listed',
        sessionId: 's1',
        socket: '/tmp/tmux-1/default',
        pane: '%3',
      });

      expect(() => rescopeTask(db, 't-1', ['docs/**'], CALLER)).toThrow(
        "Session s1's window is open: the tmux server at /tmp/tmux-1/default lists it as pane %3",
      );
      expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**']);
      expect(listEvents(db, 's1')).toEqual([]);
      expect(listDecisionRecords(db)).toEqual([]);
    },
  );

  // Neither is fixed by closing a window, so each refusal names its own cause.
  it.each([
    [
      { kind: 'unanswered', socket: '/tmp/tmux-1/default', detail: 'no server running' } as const,
      'The tmux server at /tmp/tmux-1/default did not answer (no server running)',
    ],
    [
      { kind: 'no-tmux', path: '/usr/bin:/bin' } as const,
      "No tmux on the window probe's fixed PATH (/usr/bin:/bin)",
    ],
  ])('refuses when the probe cannot see the windows (%o), writing nothing', (probe, says) => {
    launched('s1', 'blocked');
    vi.mocked(mayHaveOpenWindow).mockReturnValue(probe);

    expect(() => rescopeTask(db, 't-1', ['docs/**'], CALLER)).toThrow(says);
    expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**']);
    expect(listEvents(db, 's1')).toEqual([]);
  });

  it("looks for every session's window, a merged or killed one's too", () => {
    launched('s1', 'blocked');
    launched('s2', 'killed');
    launched('s3', 'merged');

    rescopeTask(db, 't-1', ['docs/**'], CALLER);

    expect(vi.mocked(mayHaveOpenWindow).mock.calls).toEqual([
      ['/repo', expect.arrayContaining(['s1', 's2', 's3'])],
    ]);
  });

  it.each([
    ['**', 'has a wildcard in its first segment'],
    ['*', 'has a wildcard in its first segment'],
    ['**/*', 'has a wildcard in its first segment'],
    ['*/**', 'has a wildcard in its first segment'],
    ['./**', 'has a wildcard in its first segment'],
    [' **', 'has a wildcard in its first segment'],
    ['?**', 'has a wildcard in its first segment'],
    ['**?', 'has a wildcard in its first segment'],
    ['**/?*', 'has a wildcard in its first segment'],
    ['*?/**', 'has a wildcard in its first segment'],
    ['*.ts', 'has a wildcard in its first segment'],
    ['/etc/passwd', 'is absolute'],
    [' /etc/passwd', 'is absolute'],
    ['src/../../etc/x', 'has a `..` segment'],
    ['..', 'has a `..` segment'],
    [' ../x', 'has a `..` segment'],
    ['.github/**', 'reaches `.github`'],
    ['.github/workflows/ci.yml', 'reaches `.github`'],
    ['./.GitHub', 'reaches `.github`'],
    ['  ', 'is empty'],
    ['./', 'is empty'],
    ['src/\u0007x', 'contains a control character'],
    ['src/\u007fx', 'contains a control character'],
    ['src/\u009bx', 'contains a control character'],
    ['src/x\n', 'contains a control character'],
  ])('refuses the glob %j: it %s', (glob, why) => {
    launched('s1', 'merged');

    expect(() => rescopeTask(db, 't-1', ['docs/**', glob], CALLER)).toThrow(why);
    expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**']);
  });

  // The matcher escapes `[]`, `{}` and `\`, so each of these names a literal
  // path: the table takes it, and it never matches anything under `.github`.
  it.each(['[.]github/**', '{docs,.github}/**', '\\.github/**'])(
    'takes %j as a literal path that never reaches .github',
    (glob) => {
      launched('s1', 'merged');

      expect(rescopeTask(db, 't-1', [glob], CALLER)).toMatchObject({ added: [glob] });

      const workflows = ['.github/x', '.github/workflows/ci.yml'];
      expect(workflows.filter((path) => globToRegExp(glob).test(path))).toEqual([]);
      const spec = readTaskSpec(db, 't-1');
      expect(auditScope(workflows, spec.scopeIn, spec.scopeOut).map((v) => v.path)).toEqual(
        workflows,
      );
    },
  );

  it('takes a glob the matcher reads as a plain path', () => {
    launched('s1', 'merged');

    expect(rescopeTask(db, 't-1', ['./docs/**', 'src/cli/'], CALLER)).toMatchObject({
      added: ['./docs/**', 'src/cli/'],
    });
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

    rescopeTask(db, 't-1', ['src/cli/index.ts'], CALLER);

    expect(audit()).toEqual(['src/core/secret.ts']);
  });
});
