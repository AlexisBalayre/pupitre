import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listPanes,
  listProcesses,
  PROBE_PATH,
  windowSockets,
} from '../claude/session-runtime.service.js';
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
import { launchedAncestor, rescopeTask } from './task-rescope.service.js';
import { assertPlannableSpec } from './task-spec.utils.js';
import type { RescopeCaller } from './types/session-event.types.js';

// The tmux and ps boundary, tested against both in the runtime's own suite.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  windowSockets: vi.fn(),
  listPanes: vi.fn(),
  listProcesses: vi.fn(),
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
});

describe('launchedAncestor (decision 115)', () => {
  // The process table from the caller's parent up, as `listProcesses` reads it.
  const tree = (...rows: (readonly [number, number, string])[]) =>
    vi
      .mocked(listProcesses)
      .mockReturnValue(new Map(rows.map(([pid, parent, args]) => [pid, { parent, args }])));
  const CLAUDE = '/Users/me/.local/bin/claude --model m --effort e';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['the conductor', 'pup-conductor-p1'],
    ['a session', 'pup-t-abc'],
  ])("finds %s's Claude Code up the tree, whatever the caller's environment", (_who, name) => {
    vi.stubEnv('PUP_CONDUCTOR', '');
    vi.stubEnv('PUP_SESSION_ID', '');
    tree(
      [process.ppid, 700, '/bin/zsh -c env -u PUP_CONDUCTOR pup plan edit t-1 --rescope'],
      [700, 600, `${CLAUDE} --name ${name} --dangerously-skip-permissions`],
      [600, 1, `tmux -S /tmp/tmux-1/x new-session -d -s ${name} -- ${CLAUDE} --name ${name}`],
    );

    expect(launchedAncestor()).toEqual({ kind: 'launched', name });
  });

  // As `ps -ww -o args=` printed them up a session's Bash and up the
  // conductor's on macOS (Claude Code 2.1.322's native build, 2026-11-10),
  // with the home directory, the repo and the project id renamed and the
  // command the Bash ran swapped for the rescope.
  const BASH =
    "/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1794221044218-bnrr9i.sh 2>/dev/null || true && eval 'env -u PUP_CONDUCTOR pup plan edit t-1 --rescope --scope docs/**' < /dev/null && pwd -P >| /tmp/claude-846a-cwd";
  it.each([
    [
      'a session',
      'pup-t-mvdw5id6',
      [5050, 89656] as const,
      '/Users/me/.local/bin/claude --model claude-opus-5-5 --effort xhigh --name pup-t-mvdw5id6 --dangerously-skip-permissions --settings /Users/me/.pupitre/p1/sessions/t-mvdw5id6/compiled/settings.json --mcp-config /Users/me/.pupitre/p1/sessions/t-mvdw5id6/compiled/mcp.json --setting-sources user',
      'tmux new-session -d -P -F #{pane_id} -s pup-watch-p1 -c /repo /Users/me/.nvm/versions/node/v24.13.1/bin/node /Users/me/.nvm/versions/node/v24.13.1/bin/pup watch',
    ],
    [
      'the conductor',
      'pup-conductor-p1',
      [44927, 44919] as const,
      '/Users/me/.local/bin/claude --model claude-opus-5-5 --effort high --name pup-conductor-p1 --dangerously-skip-permissions --settings /Users/me/.pupitre/p1/conductor/compiled/settings.json --mcp-config /Users/me/.pupitre/p1/conductor/compiled/mcp.json --setting-sources user',
      'tmux -L pup-conductor-p1 new-session -d -P -F #{pane_id} -s pup-conductor-p1 -x 220 -y 50 -c /repo -e PUP_CONDUCTOR=p1 -e PUP_BIN=/Users/me/.nvm/versions/node/v24.13.1/bin/pup /Users/me/.local/bin/claude --model claude-opus-5-5 --effort high --name pup-conductor-p1 --dangerously-skip-permissions --settings /Users/me/.pupitre/p1/conductor/compiled/settings.json --mcp-config /Users/me/.pupitre/p1/conductor/compiled/mcp.json --setting-sources user',
    ],
  ])("finds %s's Claude Code in what ps really printed", (_who, name, pids, claude, server) => {
    const [claudePid, serverPid] = pids;
    tree([process.ppid, claudePid, BASH], [claudePid, serverPid, claude], [serverPid, 1, server]);

    expect(launchedAncestor()).toEqual({ kind: 'launched', name });
  });

  // A server lists the command that started it, which is a launch's when a
  // launch started it; the operator's own panes run under that server.
  it.each([
    `tmux new-session -d -P -F #{pane_id} -s pup-t-abc -- ${CLAUDE} --name pup-t-abc`,
    '/opt/homebrew/bin/tmux -S /tmp/tmux-1/default new-session --name pup-t-abc',
    'tmux: server (/tmp/tmux-1/default)',
  ])('passes over a tmux process up the tree: %s', (server) => {
    tree([process.ppid, 600, '-zsh'], [600, 1, server]);

    expect(launchedAncestor()).toBeUndefined();
  });

  it.each([
    ["the operator's own Claude Code", `${CLAUDE} --name notes`],
    ['a process with no --name', CLAUDE],
    ['a trailing --name', `${CLAUDE} --name`],
  ])('passes a caller under %s', (_what, args) => {
    tree([process.ppid, 600, '/bin/zsh'], [600, 1, args]);

    expect(launchedAncestor()).toBeUndefined();
  });

  it('stops at a loop in the table rather than hanging', () => {
    tree([process.ppid, 700, '/bin/zsh'], [700, process.ppid, '/bin/sh']);

    expect(launchedAncestor()).toBeUndefined();
  });

  it('is unreadable when ps failed, which a rescope refuses', () => {
    vi.mocked(listProcesses).mockReturnValue(undefined);

    expect(launchedAncestor()).toEqual({ kind: 'unreadable' });
  });
});
