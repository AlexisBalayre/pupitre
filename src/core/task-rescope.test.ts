import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from './db.client.js';
import { listDecisionRecords } from './decision-record.repository.js';
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

// The tmux boundary: by default the default server answers and lists no
// window of the task's, as the gate leaves a merged session's.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

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
    vi.mocked(execFileSync).mockReset().mockReturnValue('%1 pup-other\n');
    db = openStore(':memory:');
    ensureProject(db, 'proj-1', '/repo');
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: JSON.stringify(SPEC) });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['merged', 'awaiting-review', 'blocked'])(
    'appends globs to a task whose session is %s, and records who approved them',
    (state) => {
      launched('s1', state);

      expect(rescopeTask(db, 't-1', ['src/cli/index.ts', 'src/core/**'])).toEqual({
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
        by: 'operator',
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

    expect(rescopeTask(db, 't-1', ['docs/**'])).toMatchObject({ sessionId: 's1' });
  });

  it.each(['queued', 'running', 'rejected'])(
    'refuses while a session is %s, writing nothing',
    (state) => {
      launched('s1', 'merged');
      launched('s2', state);

      expect(() => rescopeTask(db, 't-1', ['docs/**'])).toThrow(
        'Session s2 is at work on t-1; rescope once it stops.',
      );
      expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**']);
      expect(listEvents(db, 's1')).toEqual([]);
      expect(listDecisionRecords(db)).toEqual([]);
    },
  );

  it('refuses a task nobody claimed, and one that does not exist', () => {
    expect(() => rescopeTask(db, 't-1', ['docs/**'])).toThrow('No session has claimed t-1');
    launched('s1', 'killed');
    expect(() => rescopeTask(db, 't-1', ['docs/**'])).toThrow('No session has claimed t-1');
    expect(() => rescopeTask(db, 't-gone', ['docs/**'])).toThrow('No task t-gone.');
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

        expect(rescopeTask(db, 't-1', ['src/core/merge-gate.service.ts'])).toMatchObject({
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

      expect(rescopeTask(db, 't-1', ['src/cli/index.ts'])).toMatchObject({
        tier: 'standard',
        raised: false,
      });
      expect(getTask(db, 't-1')?.tier).toBe('standard');
      expect(getSession(db, 's1')).toMatchObject({ tier: 'standard', rung: 2 });
    });

    // A relaunch after a kill routes from the task's row, so it is settled
    // from its own stored tier, not from the session's.
    it('raises a task stored standard under a session already critical', () => {
      standard('standard');
      db.prepare("UPDATE sessions SET tier = 'critical', rung = 1 WHERE id = ?").run('s1');

      expect(rescopeTask(db, 't-1', ['src/core/merge-gate.service.ts'])).toMatchObject({
        tier: 'critical',
        raised: true,
      });
      expect(getTask(db, 't-1')?.tier).toBe('critical');
      expect(getSession(db, 's1')).toMatchObject({ tier: 'critical', rung: 1 });
    });

    it('never lowers a critical tier', () => {
      db.prepare("UPDATE tasks SET spec = ?, tier = 'critical' WHERE id = ?").run(
        JSON.stringify({ ...SPEC, scopeIn: ['docs/**'], scopeOut: [] }),
        't-1',
      );
      launched('s1', 'merged');
      db.prepare("UPDATE sessions SET tier = 'critical', rung = 1 WHERE id = ?").run('s1');

      expect(rescopeTask(db, 't-1', ['src/cli/index.ts'])).toMatchObject({
        tier: 'critical',
        raised: false,
      });
      expect(getTask(db, 't-1')?.tier).toBe('critical');
      expect(getSession(db, 's1')).toMatchObject({ tier: 'critical', rung: 1 });
    });
  });

  it('writes nothing when every glob is already in scope', () => {
    launched('s1', 'merged');

    expect(rescopeTask(db, 't-1', ['src/core/**'])).toEqual({
      sessionId: 's1',
      added: [],
      tier: 'critical',
      raised: false,
    });
    expect(listEvents(db, 's1')).toEqual([]);
    expect(listDecisionRecords(db)).toEqual([]);
  });

  it('refuses a glob the hooks could not hold', () => {
    launched('s1', 'merged');

    expect(() => rescopeTask(db, 't-1', ['src/\n**'])).toThrow(InvalidProfileError);
  });

  // A worker that ran `pup session done` is awaiting review with its window
  // still up: rescoping then would let it keep editing into the wider scope.
  it.each([
    ['awaiting-review', 'its pane', '%3 renamed\n'],
    ['blocked', 'its pane', '%3 renamed\n'],
    ['awaiting-review', 'its name', '%9 pup-s1\n'],
  ])('refuses while a %s session has %s on the server, writing nothing', (state, _what, panes) => {
    launched('s1', state);
    vi.mocked(execFileSync).mockReturnValue(panes);

    expect(() => rescopeTask(db, 't-1', ['docs/**'])).toThrow(
      "Session s1's window may still be open",
    );
    expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**']);
    expect(listEvents(db, 's1')).toEqual([]);
  });

  // A server that cannot be reached, a tmux that is not there: either way no
  // window is shown closed.
  it.each(['no server running on /tmp/tmux-501/default', 'spawnSync tmux ENOENT'])(
    'counts a probe that fails (%s) as an open window',
    (message) => {
      launched('s1', 'merged');
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error(message);
      });

      expect(() => rescopeTask(db, 't-1', ['docs/**'])).toThrow(
        "Session s1's window may still be open",
      );
    },
  );

  // A worker could point TMUX_TMPDIR at an empty server, or PATH at a fake tmux.
  it("asks the default socket with a pinned PATH, whatever the caller's env says", () => {
    launched('s1', 'merged');
    vi.stubEnv('TMUX_TMPDIR', '/tmp/elsewhere');
    vi.stubEnv('PATH', '/tmp/fake-bin');

    rescopeTask(db, 't-1', ['docs/**']);

    const [file, args, options] = vi.mocked(execFileSync).mock.calls[0] ?? [];
    expect(file).toBe('tmux');
    expect(args).toEqual([
      '-S',
      `/tmp/tmux-${process.getuid?.()}/default`,
      'list-panes',
      '-a',
      '-F',
      '#{pane_id} #{session_name}',
    ]);
    expect((options as { env?: unknown }).env).toEqual({
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    });
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

    expect(() => rescopeTask(db, 't-1', ['docs/**', glob])).toThrow(why);
    expect(readTaskSpec(db, 't-1').scopeIn).toEqual(['src/core/**']);
  });

  it('takes a glob the matcher reads as a plain path', () => {
    launched('s1', 'merged');

    expect(rescopeTask(db, 't-1', ['./docs/**', 'src/cli/'])).toMatchObject({
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

    rescopeTask(db, 't-1', ['src/cli/index.ts']);

    expect(audit()).toEqual(['src/core/secret.ts']);
  });
});
