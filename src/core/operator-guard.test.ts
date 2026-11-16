import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listProcesses, recordedPanePids } from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { launchedAncestor, type MergeCall, mergeCallerAncestor } from './operator-guard.service.js';
import { projectId } from './paths.utils.js';
import { ensureProject, insertSession, insertTask } from './session.repository.js';

// The ps boundary and the launch's records, tested against both in the
// runtime's own suite.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  listProcesses: vi.fn(),
  recordedPanePids: vi.fn(),
}));

describe('launchedAncestor (decisions 115, 188)', () => {
  let db: Database;
  // The process table from the caller's parent up, as `listProcesses` reads it.
  const tree = (...rows: (readonly [number, number, string])[]) =>
    vi
      .mocked(listProcesses)
      .mockReturnValue(new Map(rows.map(([pid, parent, args]) => [pid, { parent, args }])));
  const CLAUDE = '/Users/me/.local/bin/claude --model m --effort e';
  const session = (id: string, state: string) => {
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
    vi.mocked(recordedPanePids).mockReset().mockReturnValue(new Map());
    db = openStore(':memory:');
    ensureProject(db, 'proj-1', '/repo');
    insertTask(db, { id: 't-1', projectId: 'proj-1', spec: '{}' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('a pane pid a launch recorded', () => {
    // A Claude Code whose title no longer carries its launch's `--name`, as
    // one that rewrote it (`setproctitle`) would show: only the pid finds it.
    const RETITLED = 'claude';

    it.each([
      ['a session', 'pup-t-abc'],
      ['the conductor', 'pup-conductor-p1'],
    ])(
      "finds %s's window up the tree, whatever the caller's environment and ps's arguments",
      (_who, window) => {
        vi.stubEnv('PUP_CONDUCTOR', '');
        vi.stubEnv('PUP_SESSION_ID', '');
        vi.mocked(recordedPanePids).mockReturnValue(new Map([[700, window]]));
        tree(
          [process.ppid, 700, '/bin/zsh -c env -u PUP_SESSION_ID pup unblock t-x'],
          [700, 600, RETITLED],
          [600, 1, 'tmux: server (/tmp/tmux-1/default)'],
        );

        expect(launchedAncestor(db, '/repo')).toEqual({ kind: 'pane', pid: 700, window });
      },
    );

    // The pid is the kernel's word; the arguments are what a process says.
    it('names the recorded window before a launch name further up', () => {
      vi.mocked(recordedPanePids).mockReturnValue(new Map([[700, 'pup-t-abc']]));
      tree(
        [process.ppid, 700, '/bin/zsh'],
        [700, 600, RETITLED],
        [600, 1, `${CLAUDE} --name pup-conductor-p1`],
      );

      expect(launchedAncestor(db, '/repo')).toEqual({
        kind: 'pane',
        pid: 700,
        window: 'pup-t-abc',
      });
    });

    // A record outlives its window, and its pid can be reused once that is gone.
    it('reads the records of the sessions that can hold a window, and no other', () => {
      for (const state of ['queued', 'running', 'awaiting-review', 'rejected', 'blocked']) {
        session(`s-${state}`, state);
      }
      session('s-merged', 'merged');
      session('s-killed', 'killed');
      tree([process.ppid, 1, '/bin/zsh']);

      launchedAncestor(db, '/repo');

      const [[repoPath, asked] = []] = vi.mocked(recordedPanePids).mock.calls;
      expect(repoPath).toBe('/repo');
      expect([...(asked ?? [])].sort()).toEqual([
        's-awaiting-review',
        's-blocked',
        's-queued',
        's-rejected',
        's-running',
      ]);
    });

    // A store written by hand: an id outside the minted shape names no path.
    it('skips a session id outside the minted shape', () => {
      session('s1', 'running');
      session('../x', 'running');
      tree([process.ppid, 1, '/bin/zsh']);

      launchedAncestor(db, '/repo');

      expect(vi.mocked(recordedPanePids)).toHaveBeenCalledWith('/repo', ['s1']);
    });

    it('passes a caller whose tree holds no recorded pid', () => {
      vi.mocked(recordedPanePids).mockReturnValue(new Map([[999, 'pup-t-abc']]));
      tree([process.ppid, 700, '/bin/zsh'], [700, 1, RETITLED]);

      expect(launchedAncestor(db, '/repo')).toBeUndefined();
    });
  });

  // The conductor's own `pup merge --pr`: its window is walked past, and a
  // session that names it, by a record or a title, is still found above.
  describe('a spared window', () => {
    const CONDUCTOR = 'pup-conductor-p1';

    it.each([
      ['its recorded pane', new Map([[700, CONDUCTOR]]), 'claude'],
      ['its launch name', new Map<number, string>(), `${CLAUDE} --name ${CONDUCTOR}`],
    ])('passes a caller under %s and no other', (_how, panes, args) => {
      vi.mocked(recordedPanePids).mockReturnValue(panes);
      tree([process.ppid, 700, '/bin/zsh'], [700, 1, args]);

      expect(launchedAncestor(db, '/repo', CONDUCTOR)).toBeUndefined();
    });

    it("finds a session's pane above a process its record or title made the conductor's", () => {
      vi.mocked(recordedPanePids).mockReturnValue(
        new Map([
          [process.ppid, CONDUCTOR],
          [700, 'pup-t-abc'],
        ]),
      );
      tree(
        [process.ppid, 600, '/bin/zsh'],
        [600, 700, `/bin/zsh --name ${CONDUCTOR}`],
        [700, 1, 'claude'],
      );

      expect(launchedAncestor(db, '/repo', CONDUCTOR)).toEqual({
        kind: 'pane',
        pid: 700,
        window: 'pup-t-abc',
      });
    });

    it('still reads the arguments of a pid the record names as the spared window', () => {
      vi.mocked(recordedPanePids).mockReturnValue(new Map([[700, CONDUCTOR]]));
      tree([process.ppid, 700, '/bin/zsh'], [700, 1, `${CLAUDE} --name pup-t-abc`]);

      expect(launchedAncestor(db, '/repo', CONDUCTOR)).toEqual({
        kind: 'launched',
        name: 'pup-t-abc',
      });
    });

    it('is still unreadable when ps failed', () => {
      vi.mocked(listProcesses).mockReturnValue(undefined);

      expect(launchedAncestor(db, '/repo', CONDUCTOR)).toEqual({ kind: 'unreadable' });
    });
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

    expect(launchedAncestor(db, '/repo')).toEqual({ kind: 'launched', name });
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
      '/Users/me/.local/bin/claude --model claude-opus-5-5 --effort xhigh --name pup-t-mvdw5id6 --dangerously-skip-permissions --settings /Users/me/.pupitre/p1/sessions/t-mvdw5id6/compiled/settings.json --setting-sources user',
      'tmux new-session -d -P -F #{pane_id} -s pup-watch-p1 -c /repo /Users/me/.nvm/versions/node/v24.13.1/bin/node /Users/me/.nvm/versions/node/v24.13.1/bin/pup watch',
    ],
    [
      'the conductor',
      'pup-conductor-p1',
      [44927, 44919] as const,
      '/Users/me/.local/bin/claude --model claude-opus-5-5 --effort high --name pup-conductor-p1 --dangerously-skip-permissions --settings /Users/me/.pupitre/p1/conductor/compiled/settings.json --setting-sources user',
      'tmux -L pup-conductor-p1 new-session -d -P -F #{pane_id} -s pup-conductor-p1 -x 220 -y 50 -c /repo -e PUP_CONDUCTOR=p1 -e PUP_BIN=/Users/me/.nvm/versions/node/v24.13.1/bin/pup /Users/me/.local/bin/claude --model claude-opus-5-5 --effort high --name pup-conductor-p1 --dangerously-skip-permissions --settings /Users/me/.pupitre/p1/conductor/compiled/settings.json --setting-sources user',
    ],
  ])("finds %s's Claude Code in what ps really printed", (_who, name, pids, claude, server) => {
    const [claudePid, serverPid] = pids;
    tree([process.ppid, claudePid, BASH], [claudePid, serverPid, claude], [serverPid, 1, server]);

    expect(launchedAncestor(db, '/repo')).toEqual({ kind: 'launched', name });
  });

  // A server lists the command that started it, which is a launch's when a
  // launch started it; the operator's own panes run under that server.
  it.each([
    `tmux new-session -d -P -F #{pane_id} -s pup-t-abc -- ${CLAUDE} --name pup-t-abc`,
    '/opt/homebrew/bin/tmux -S /tmp/tmux-1/default new-session --name pup-t-abc',
    'tmux: server (/tmp/tmux-1/default)',
  ])('passes over a tmux process up the tree: %s', (server) => {
    tree([process.ppid, 600, '-zsh'], [600, 1, server]);

    expect(launchedAncestor(db, '/repo')).toBeUndefined();
  });

  it.each([
    ["the operator's own Claude Code", `${CLAUDE} --name notes`],
    ['a process with no --name', CLAUDE],
    ['a trailing --name', `${CLAUDE} --name`],
  ])('passes a caller under %s', (_what, args) => {
    tree([process.ppid, 600, '/bin/zsh'], [600, 1, args]);

    expect(launchedAncestor(db, '/repo')).toBeUndefined();
  });

  it('stops at a loop in the table rather than hanging', () => {
    tree([process.ppid, 700, '/bin/zsh'], [700, process.ppid, '/bin/sh']);

    expect(launchedAncestor(db, '/repo')).toBeUndefined();
  });

  it('is unreadable when ps failed, which every guarded command refuses', () => {
    vi.mocked(listProcesses).mockReturnValue(undefined);

    expect(launchedAncestor(db, '/repo')).toEqual({ kind: 'unreadable' });
  });

  describe('mergeCallerAncestor', () => {
    const CONDUCTOR = `pup-conductor-${projectId('/repo')}`;
    const DEBT = { acceptDebt: 'r' };
    /** The caller under pid 700, which a launch recorded for `window`. */
    const underPane = (window: string) => {
      vi.mocked(recordedPanePids).mockReturnValue(new Map([[700, window]]));
      tree([process.ppid, 700, '/bin/zsh'], [700, 1, 'claude']);
    };

    // The local fast-forward, and a debt the ledger would record as the operator's own.
    it.each<[string, MergeCall]>([
      ['the local merge', {}],
      ['a debt with no approver', { pr: true, ...DEBT }],
      ['a debt approved by `human`', { pr: true, ...DEBT, approvedBy: 'Human' }],
    ])("finds %s under the conductor's own window", (_what, call) => {
      underPane(CONDUCTOR);

      expect(mergeCallerAncestor(db, '/repo', call)).toEqual({
        kind: 'pane',
        pid: 700,
        window: CONDUCTOR,
      });
    });

    it.each<[string, MergeCall]>([
      ['a PR', { pr: true }],
      ['a PR with a named approver', { pr: true, ...DEBT, approvedBy: 'tg:someone' }],
    ])("walks past the conductor's window for %s, and finds a session's", (_what, call) => {
      underPane(CONDUCTOR);
      expect(mergeCallerAncestor(db, '/repo', call)).toBeUndefined();

      underPane('pup-t-abc');
      expect(mergeCallerAncestor(db, '/repo', call)).toEqual({
        kind: 'pane',
        pid: 700,
        window: 'pup-t-abc',
      });
    });

    // Only this project's conductor is spared.
    it("finds another project's conductor for a PR", () => {
      underPane('pup-conductor-elsewhere');

      expect(mergeCallerAncestor(db, '/repo', { pr: true })).toEqual({
        kind: 'pane',
        pid: 700,
        window: 'pup-conductor-elsewhere',
      });
    });
  });
});
