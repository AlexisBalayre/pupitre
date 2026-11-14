import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listPanes, PROBE_PATH, windowSockets } from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { listDecisionRecords } from './decision-record.repository.js';
import { globToRegExp } from './glob.utils.js';
import { scopeConflicts } from './overlap.service.js';
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
import { rescopeTask, taskRescopes } from './task-rescope.service.js';
import { assertPlannableSpec } from './task-spec.utils.js';
import type { RescopeCaller } from './types/session-event.types.js';

// The tmux boundary, tested against tmux in the runtime's own suite.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  windowSockets: vi.fn(),
  listPanes: vi.fn(),
}));

// The launch's overlap check, tested against a real repo in its own suite.
vi.mock('./overlap.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./overlap.service.js')>()),
  scopeConflicts: vi.fn(),
}));

// The plan's own check, real unless a test stubs it.
vi.mock('./task-spec.utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-spec.utils.js')>();
  return { ...actual, assertPlannableSpec: vi.fn(actual.assertPlannableSpec) };
});

// What the CLI hands over of a caller it took for the operator.
const CALLER: RescopeCaller = { by: 'inferred-operator', tty: '/dev/ttys003', tmuxPane: '%4' };

const SOCKET = '/tmp/tmux-1/default';

// A launch's pane, as `listPanes` lines it: id, start command, session name.
const pane = (id: string, name: string, session = name) =>
  `${id}\t/bin/claude --name ${name} --settings /s.json\t${session}`;

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

  // By default the one server asked lists no window of the task's, as the
  // gate leaves a merged session's.
  beforeEach(() => {
    vi.mocked(windowSockets).mockReset().mockReturnValue([SOCKET]);
    vi.mocked(listPanes).mockReset().mockReturnValue([]);
    vi.mocked(scopeConflicts).mockReset().mockReturnValue([]);
    vi.mocked(assertPlannableSpec).mockReset();
    db = openStore(':memory:');
    ensureProject(db, 'proj-1', '/repo');
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: JSON.stringify(SPEC) });
  });

  it.each(['merged', 'awaiting-review'])(
    'appends globs to a task whose session is %s, and records who approved them',
    (state) => {
      launched('s1', state);

      expect(rescopeTask(db, 't-1', ['src/cli/index.ts', 'src/core/**'], CALLER)).toEqual({
        sessionId: 's1',
        added: ['src/cli/index.ts'],
        tier: 'critical',
        raised: false,
        overlaps: [],
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

  // A blocked session resumes on the profile it was compiled with, and only
  // `pup fix` recompiles one.
  it.each(['queued', 'running', 'rejected', 'blocked'])(
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
      overlaps: [],
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
  it.each(['awaiting-review', 'merged'])(
    'refuses while a %s session has its window open, writing nothing',
    (state) => {
      launched('s1', state);
      vi.mocked(listPanes).mockReturnValue([pane('%3', 'pup-s1'), '']);

      expect(() => rescopeTask(db, 't-1', ['docs/**'], CALLER)).toThrow(
        `Session s1's window is open: the tmux server at ${SOCKET} lists it as pane %3`,
      );
      expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**']);
      expect(listEvents(db, 's1')).toEqual([]);
      expect(listDecisionRecords(db)).toEqual([]);
    },
  );

  it.each([
    ['its launch name', '%9\t\tpup-s1'],
    // A rename leaves the start command tmux fixed when the pane started.
    ['the start command of its launch, renamed', pane('%9', 'pup-s1', 'renamed')],
    // A tab or a newline in a session name (raw before tmux 3.3) adds a field
    // or a line; the start command stays in its own.
    [
      'the start command, its session name holding a tab and a newline',
      pane('%9', 'pup-s1', 'x\tpup-other\n%8\t\tpup-other'),
    ],
  ])('finds the window a server lists by %s', (_what, listed) => {
    launched('s1', 'awaiting-review');
    // Split as `listPanes` splits tmux's output.
    vi.mocked(listPanes).mockReturnValue(`%1\t\tmine\n${listed}\n`.split('\n'));

    expect(() => rescopeTask(db, 't-1', ['docs/**'], CALLER)).toThrow('lists it as pane %9');
  });

  // A `%N` names a pane only on the server that minted it: a restarted or
  // another server reuses the session's recorded id for a pane of its own.
  it("passes a window listed nowhere, whatever pane ids and other sessions' names it lists", () => {
    launched('s1', 'awaiting-review');
    vi.mocked(listPanes).mockReturnValue([
      '%3\t\tpup-other',
      '%4\t-zsh\tmine',
      pane('%5', 'pup-s1-1'),
    ]);

    expect(rescopeTask(db, 't-1', ['docs/**'], CALLER)).toMatchObject({ added: ['docs/**'] });
  });

  // Neither is fixed by closing a window, so each refusal names its own cause.
  it.each([
    [
      { noTmux: false, detail: 'no server running' } as const,
      `The tmux server at ${SOCKET} did not answer (no server running)`,
    ],
    [{ noTmux: true } as const, `No tmux on the window probe's fixed PATH (${PROBE_PATH})`],
  ])('refuses when the probe cannot see the windows (%o), writing nothing', (failure, says) => {
    launched('s1', 'awaiting-review');
    vi.mocked(listPanes).mockReturnValue(failure);

    expect(() => rescopeTask(db, 't-1', ['docs/**'], CALLER)).toThrow(says);
    expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**']);
    expect(listEvents(db, 's1')).toEqual([]);
  });

  // The window may be on any of the sockets, so each one decides alone, and a
  // server that did not answer is named before a window another lists.
  const OTHER = '/tmp/e/tmux-1/default';
  it.each([
    ['%1\t\tpup-other', ['%9\t\tpup-s1'], `${OTHER} lists it as pane %9`],
    ['%1\t\tpup-other', { noTmux: false as const, detail: 'x' }, `${OTHER} did not answer`],
    ['%1\t\tpup-s1', { noTmux: false as const, detail: 'x' }, `${OTHER} did not answer`],
  ])('asks every socket: the first listing %j, the second answering %o', (first, second, says) => {
    launched('s1', 'awaiting-review');
    vi.mocked(windowSockets).mockReturnValue([SOCKET, OTHER]);
    vi.mocked(listPanes).mockImplementation((socket) => (socket === SOCKET ? [first] : second));

    expect(() => rescopeTask(db, 't-1', ['docs/**'], CALLER)).toThrow(says);
  });

  it("looks for every session's window, a merged or killed one's too", () => {
    launched('s1', 'awaiting-review');
    launched('s2', 'killed');
    launched('s3', 'merged');

    rescopeTask(db, 't-1', ['docs/**'], CALLER);

    expect(vi.mocked(windowSockets).mock.calls).toEqual([
      ['/repo', expect.arrayContaining(['s1', 's2', 's3'])],
    ]);
    expect(vi.mocked(listPanes).mock.calls).toEqual([[SOCKET]]);
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
    // The gate's protected paths, which its scope-audit matches in any case.
    ['.claude/**', 'reaches a path the gate protects whatever the scope'],
    ['.claude/hooks/scope-guard.sh', 'reaches a path the gate protects whatever the scope'],
    ['./.CLAUDE', 'reaches a path the gate protects whatever the scope'],
    ['.pupitre/adapter.yml', 'reaches a path the gate protects whatever the scope'],
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

    expect(
      rescopeTask(db, 't-1', ['./docs/**', 'src/cli/', '.claudeignore', 'docs/.claude/x'], CALLER),
    ).toMatchObject({
      added: ['./docs/**', 'src/cli/', '.claudeignore', 'docs/.claude/x'],
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

  // A launch's check (decision 99): recorded and returned, never refused.
  describe('the overlap check', () => {
    const otherTask = (id: string) => {
      insertTask(db, { id: 't-2', projectId: 'proj-1', spec: JSON.stringify(SPEC) });
      insertSession(db, {
        id,
        taskId: 't-2',
        worktreePath: `/repo/.worktrees/${id}`,
        branch: `pup/${id}`,
        profileHash: 'hash',
        tmuxTarget: '%5',
      });
    };

    it("runs the added globs, under the task's scope-out, against the live sessions", () => {
      launched('s1', 'merged');

      rescopeTask(db, 't-1', ['src/cli/index.ts', 'src/core/**'], CALLER);

      expect(vi.mocked(scopeConflicts)).toHaveBeenCalledWith(
        db,
        '/repo',
        ['src/cli/index.ts'],
        ['src/core/secret.ts'],
      );
    });

    it("records and returns what another task's session shares, writing the rescope too", () => {
      launched('s1', 'awaiting-review');
      otherTask('s9');
      vi.mocked(scopeConflicts).mockReturnValue([
        { sessionId: 's1', files: ['src/cli/index.ts'] },
        { sessionId: 's9', files: ['src/cli/index.ts', 'docs/adr/README.md'] },
      ]);

      expect(rescopeTask(db, 't-1', ['src/cli/index.ts'], CALLER)).toMatchObject({
        added: ['src/cli/index.ts'],
        overlaps: [{ sessionId: 's9', files: ['src/cli/index.ts', 'docs/adr/README.md'] }],
      });

      expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**', 'src/cli/index.ts']);
      const overlap = listEvents(db, 's1').find((event) => event.type === 'scope_overlap');
      expect(JSON.parse(overlap?.payload ?? '{}')).toEqual({
        via: 'rescope',
        accepted: [{ session: 's9', files: ['src/cli/index.ts', 'docs/adr/README.md'] }],
      });
      expect(listEvents(db, 's9')).toEqual([]);
    });

    it('records no overlap when the added globs share nothing', () => {
      launched('s1', 'merged');

      expect(rescopeTask(db, 't-1', ['docs/**'], CALLER)).toMatchObject({ overlaps: [] });
      expect(listEvents(db, 's1').map((event) => event.type)).toEqual(['rescope']);
    });

    // A refusal after the write rolls back the rescope; there is nothing to compare.
    it('is not asked when the rescope adds nothing or is refused', () => {
      launched('s1', 'merged');
      rescopeTask(db, 't-1', ['src/core/**'], CALLER);
      vi.mocked(listPanes).mockReturnValue([pane('%3', 'pup-s1')]);
      expect(() => rescopeTask(db, 't-1', ['docs/**'], CALLER)).toThrow('window is open');

      expect(vi.mocked(scopeConflicts)).not.toHaveBeenCalled();
    });
  });
});

describe('taskRescopes (decision 188)', () => {
  let db: Database;
  const session = (id: string, taskId: string) =>
    insertSession(db, {
      id,
      taskId,
      worktreePath: `/repo/.worktrees/${id}`,
      branch: `pup/${id}`,
      profileHash: 'hash',
      tmuxTarget: '%3',
    });
  const rescope = (sessionId: string, payload: unknown) =>
    db
      .prepare("INSERT INTO events (session_id, type, payload) VALUES (?, 'rescope', ?)")
      .run(sessionId, JSON.stringify(payload));

  beforeEach(() => {
    db = openStore(':memory:');
    ensureProject(db, 'proj-1', '/repo');
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: JSON.stringify(SPEC) });
    insertTask(db, { id: 't-2', projectId: 'proj-1', spec: JSON.stringify(SPEC) });
  });

  it("lists every rescope across the task's sessions, oldest first, and no other task's", () => {
    session('s1', 't-1');
    session('s2', 't-1');
    session('s9', 't-2');
    rescope('s1', { task: 't-1', added: ['docs/**'], tier: 'standard', raised: false, ...CALLER });
    rescope('s9', { task: 't-2', added: ['x/**'], tier: 'standard', raised: false, ...CALLER });
    rescope('s2', {
      task: 't-1',
      added: ['src/core/merge-gate.service.ts'],
      tier: 'critical',
      raised: true,
      by: 'inferred-operator',
      tty: null,
      tmuxPane: null,
    });

    const listed = taskRescopes(db, 't-1');

    expect(listed.map(({ at: _at, ...rest }) => rest)).toEqual([
      {
        sessionId: 's1',
        added: ['docs/**'],
        tier: 'standard',
        raised: false,
        by: 'inferred-operator',
        tty: '/dev/ttys003',
        tmuxPane: '%4',
      },
      {
        sessionId: 's2',
        added: ['src/core/merge-gate.service.ts'],
        tier: 'critical',
        raised: true,
        by: 'inferred-operator',
        tty: null,
        tmuxPane: null,
      },
    ]);
    expect(listed[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  // The store is session-writable: a field in the wrong type reads as absent.
  it('takes each field only in the type a rescope writes', () => {
    session('s1', 't-1');
    rescope('s1', { added: ['docs/**', 7], tier: 3, raised: 'yes', by: {}, tty: 1 });
    rescope('s1', ['not', 'an', 'object']);

    expect(taskRescopes(db, 't-1').map(({ at: _at, ...rest }) => rest)).toEqual([
      {
        sessionId: 's1',
        added: ['docs/**'],
        tier: 'unknown',
        raised: false,
        by: 'unknown',
        tty: null,
        tmuxPane: null,
      },
      {
        sessionId: 's1',
        added: [],
        tier: 'unknown',
        raised: false,
        by: 'unknown',
        tty: null,
        tmuxPane: null,
      },
    ]);
  });

  it('is empty for a task never rescoped', () => {
    session('s1', 't-1');

    expect(taskRescopes(db, 't-1')).toEqual([]);
  });
});
