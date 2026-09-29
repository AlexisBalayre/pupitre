import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The boundaries that spawn tmux or open a Claude window, and nothing else: the
// store, the events and the transitions all run for real, per
// docs/conventions/testing.md. These are the same functions the CLI commands
// call, which is the whole thing under test here — that a key reaches them.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));
vi.mock('../../core/session-lifecycle.service.js', () => ({
  interruptSession: vi.fn(),
  killSession: vi.fn(),
  launchTask: vi.fn(() => 's-launched-1'),
  steerSession: vi.fn(),
}));
vi.mock('../../core/session-handoff.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/session-handoff.service.js')>()),
  isHandoffReady: vi.fn(() => true),
  requestHandoff: vi.fn(() => '/store/handoff.md'),
  respawnSession: vi.fn(),
}));
vi.mock('../../core/conductor.service.js', () => ({
  startConductor: vi.fn(() => ({ name: 'pup-conductor-x', paneId: '%3' })),
  stopConductor: vi.fn(),
}));

import { spawnSync } from 'node:child_process';
import { SteerNotDeliveredError } from '../../claude/session-runtime.service.js';
import { startConductor, stopConductor } from '../../core/conductor.service.js';
import { openStore } from '../../core/db.client.js';
import {
  ensureProject,
  getSession,
  insertSession,
  insertTask,
  transitionSession,
} from '../../core/session.repository.js';
import {
  isHandoffReady,
  requestHandoff,
  respawnSession,
} from '../../core/session-handoff.service.js';
import { LaunchRolledBackError } from '../../core/session-lifecycle.errors.js';
import {
  interruptSession,
  killSession,
  launchTask,
  steerSession,
} from '../../core/session-lifecycle.service.js';
import type { DashboardSnapshot } from '../../core/types/dashboard.types.js';
import {
  type ActionDeps,
  attachTo,
  conductorAttachTarget,
  interruptSelected,
  killSelected,
  launchSelected,
  respawnSelected,
  runMerge,
  selectedBlockedReason,
  sessionAttachTarget,
  steerSelected,
  toggleConductor,
  unblockSelected,
} from './actions.service.js';

const REPO = '/repo/pupitre';
const SESSION = 's-live-1';

describe('dashboard actions', () => {
  let db: Database;
  let deps: ActionDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    ensureProject(db, 'pid', REPO);
    insertTask(db, { id: 't-live', projectId: 'pid', spec: '{}' });
    insertSession(db, {
      id: SESSION,
      taskId: 't-live',
      worktreePath: `${REPO}/.worktrees/${SESSION}`,
      branch: `pup/${SESSION}`,
      profileHash: 'hash',
    });
    transitionSession(db, SESSION, 'running');
    deps = { db, repoPath: REPO, pupBin: '/abs/path/to/pup.js' };
  });

  afterEach(() => db.close());

  describe('launch', () => {
    it('claims the selected task through `launchTask` and names the window', () => {
      const result = launchSelected(deps, 't-planned', 'opus');

      expect(vi.mocked(launchTask).mock.calls[0]?.[1]).toMatchObject({
        repoPath: REPO,
        taskId: 't-planned',
        model: 'opus',
      });
      expect(result.message).toContain('s-launched-1');
      expect(result.failed).toBeUndefined();
    });

    // Blank means the profile's default, exactly as omitting `--model` does;
    // the key must not turn an unanswered prompt into a model named ''.
    it('omits the model when the prompt was left blank', () => {
      launchSelected(deps, 't-planned', '');

      expect(vi.mocked(launchTask).mock.calls[0]?.[1]).not.toHaveProperty('model');
    });

    // `launchTask` claims the task, inserts the row and opens the window before
    // the kickoff can be refused, and undoes all three itself (decision 40).
    // What this screen adds is the retry: the same key on the same task, where
    // the CLI names the command to re-run.
    it('says what was undone and which key retries it', () => {
      vi.mocked(launchTask).mockImplementation(() => {
        throw new LaunchRolledBackError(
          'Launch rolled back (session s-half-1 killed)',
          new SteerNotDeliveredError('s-half-1', 12),
        );
      });

      const result = launchSelected(deps, 't-planned', '');

      expect(killSession).not.toHaveBeenCalled();
      expect(result.failed).toBe(true);
      expect(result.message).toBe(
        'Steer to session s-half-1 did not land: its input box never held the whole 12-char ' +
          'message. Cleared the box and submitted nothing; the session is still running with ' +
          'an empty prompt. Launch rolled back (session s-half-1 killed). Press l on t-planned ' +
          'again.',
      );
    });

    it('reports a refusal rather than throwing it at the render loop', () => {
      vi.mocked(launchTask).mockImplementation(() => {
        throw new Error('Task t-planned is already claimed by s-other-1.');
      });

      expect(launchSelected(deps, 't-planned', '')).toEqual({
        message: 'Task t-planned is already claimed by s-other-1.',
        failed: true,
      });
    });
  });

  // The record is `steerSession`'s own (src/core/session-lifecycle.test.ts),
  // so this key and `pup steer` cannot drift apart over what a steer leaves
  // behind, or over which sessions refuse one.
  it('steers through `steerSession`, as `pup steer` does', () => {
    const result = steerSelected(deps, SESSION, 'read docs/05 first');

    expect(steerSession).toHaveBeenCalledWith(db, SESSION, 'read docs/05 first', 'manual');
    expect(result.message).toContain(SESSION);
  });

  it('interrupts through `interruptSession`, with no message behind it', () => {
    interruptSelected(deps, SESSION);

    expect(interruptSession).toHaveBeenCalledWith(db, SESSION);
  });

  // A refusal core throws — a session that has stopped, a pane that is gone —
  // reaches the status bar as a line, because this screen is held open.
  it('reports a refused steer rather than throwing it at the render loop', () => {
    vi.mocked(steerSession).mockImplementation(() => {
      throw new Error('Session s-live-1 is killed; nothing to steer.');
    });

    expect(steerSelected(deps, SESSION, 'read docs/05 first')).toEqual({
      message: 'Session s-live-1 is killed; nothing to steer.',
      failed: true,
    });
  });

  // Every message here reaches Ink, which passes an escape straight through to
  // the one screen the operator decides from (decision 29). The refusals quote
  // what they refused, and what they refused is a session's own output.
  it('sanitizes what a refusal puts on screen', () => {
    // Once, so the kill's own case below still sees the default mock.
    vi.mocked(killSession).mockImplementationOnce(() => {
      throw new Error('\u001b[2Krefused:\n  the pane is gone');
    });

    expect(killSelected(deps, SESSION)).toEqual({
      message: '[2Krefused: the pane is gone',
      failed: true,
    });
  });

  it('kills through `killSession`', () => {
    expect(killSelected(deps, SESSION).message).toContain('backlog');

    expect(killSession).toHaveBeenCalledWith(db, SESSION);
  });

  describe('unblock', () => {
    beforeEach(() => {
      transitionSession(db, SESSION, 'blocked', {
        reason: '3 rejections: the gate stopped steering',
      });
    });

    // Read from the store, not typed by the operator: unblocking is a claim
    // that the block was addressed, and nobody can make it about a reason they
    // were never shown.
    it('reads the reason the gate recorded for the block', () => {
      expect(selectedBlockedReason(deps, SESSION)).toBe('3 rejections: the gate stopped steering');
    });

    it('says so plainly when the block carried no reason', () => {
      transitionSession(db, 's-live-1', 'running');
      expect(selectedBlockedReason(deps, 's-nothing')).toBe('(no reason recorded)');
    });

    it('returns the session to running, leaving the reject count alone', () => {
      const result = unblockSelected(deps, SESSION);

      expect(getSession(db, SESSION)?.state).toBe('running');
      expect(result.message).toContain('untouched');
    });

    // The row the key was pressed on comes from a reading up to two seconds
    // old, and its confirmation can sit unanswered for as long as the operator
    // looks away. `awaiting-review -> running` is a legal edge, so a stale `y`
    // would quietly reopen a branch that is waiting to be merged.
    it('refuses a session that stopped being blocked while the prompt was open', () => {
      transitionSession(db, SESSION, 'running', { kind: 'operator-unblock' });
      transitionSession(db, SESSION, 'awaiting-review');

      const result = unblockSelected(deps, SESSION);

      expect(result.failed).toBe(true);
      expect(result.message).toContain('is awaiting-review; only blocked sessions unblock');
      expect(getSession(db, SESSION)?.state).toBe('awaiting-review');
    });

    it('refuses a session that is no longer there at all', () => {
      expect(unblockSelected(deps, 's-gone').failed).toBe(true);
    });
  });

  describe('respawn', () => {
    it('relaunches straight away when the handoff is already there', async () => {
      const result = await respawnSelected(deps, SESSION, 1_000, 1, () => {});

      expect(requestHandoff).not.toHaveBeenCalled();
      expect(respawnSession).toHaveBeenCalledWith(db, REPO, SESSION);
      expect(result.message).toContain('fresh context window');
    });

    // The CLI's wait sleeps the thread; this one yields, so the dashboard keeps
    // redrawing while the session finishes its turn.
    it('asks for a handoff, shows the wait, and relaunches once it lands', async () => {
      vi.mocked(isHandoffReady).mockReturnValueOnce(false).mockReturnValueOnce(false);
      const waits: number[] = [];

      const result = await respawnSelected(deps, SESSION, 10_000, 1, (elapsed) =>
        waits.push(elapsed),
      );

      expect(requestHandoff).toHaveBeenCalledWith(db, REPO, SESSION);
      expect(waits.length).toBeGreaterThan(0);
      expect(respawnSession).toHaveBeenCalledWith(db, REPO, SESSION);
      expect(result.failed).toBeUndefined();
    });

    it('gives up with the retry when the session never signals', async () => {
      vi.mocked(isHandoffReady).mockReturnValue(false);

      const result = await respawnSelected(deps, SESSION, 0, 1, () => {});

      expect(respawnSession).not.toHaveBeenCalled();
      expect(result.failed).toBe(true);
      expect(result.message).toContain('Press R again');
    });
  });

  describe('conductor', () => {
    it('starts one through `startConductor` with the models it was given', () => {
      const result = toggleConductor(deps, false, { model: 'opus', workerModel: 'sonnet' });

      expect(vi.mocked(startConductor).mock.calls[0]?.[0]).toMatchObject({
        db,
        repoPath: REPO,
        model: 'opus',
        workerModel: 'sonnet',
      });
      expect(result.message).toBe('Conductor running (tmux: pup-conductor-x).');
    });

    // The radar is `startConductor`'s to bring up, by the store's beat
    // (src/core/conductor.test.ts); this screen only says that it did, as
    // `pup conductor start` does.
    it('names the conflict radar the start brought up with it', () => {
      vi.mocked(startConductor).mockReturnValue({
        name: 'pup-conductor-x',
        paneId: '%3',
        radarTarget: 'pup-watch-x',
      });

      expect(toggleConductor(deps, false, { model: '', workerModel: '' }).message).toBe(
        'Conductor running (tmux: pup-conductor-x). Conflict radar started with it ' +
          '(tmux: pup-watch-x).',
      );
    });

    it('stops the running one through `stopConductor`', () => {
      expect(toggleConductor(deps, true, { model: '', workerModel: '' }).message).toBe(
        'Conductor stopped.',
      );

      expect(stopConductor).toHaveBeenCalledWith(REPO);
      expect(startConductor).not.toHaveBeenCalled();
    });

    // `startConductor` kills the window itself — a window with no context is a
    // bypass-permissions agent in the main checkout that has read none of its
    // tier — and this screen adds the key to press to try again. The drift
    // this closes: the toggle used to let a refused kickoff leave the window
    // up, where `pup conductor start` killed it.
    it('reports a window that never became ready, and the key that retries it', () => {
      vi.mocked(startConductor).mockImplementation(() => {
        throw new LaunchRolledBackError(
          'Conductor window pup-conductor-x never became ready, so its context was not ' +
            'delivered and the window was killed',
        );
      });

      const result = toggleConductor(deps, false, { model: '', workerModel: '' });

      expect(stopConductor).not.toHaveBeenCalled();
      expect(result).toEqual({
        message:
          'Conductor window pup-conductor-x never became ready, so its context was not ' +
          'delivered and the window was killed. Press c again.',
        failed: true,
      });
    });

    it('reports a kickoff the window refused, refusal first', () => {
      vi.mocked(startConductor).mockImplementation(() => {
        throw new LaunchRolledBackError(
          'Conductor launch rolled back (window killed)',
          new Error('Steer to session conductor-x did not land.'),
        );
      });

      expect(toggleConductor(deps, false, { model: '', workerModel: '' })).toEqual({
        message:
          'Steer to session conductor-x did not land. Conductor launch rolled back ' +
          '(window killed). Press c again.',
        failed: true,
      });
    });
  });

  describe('attach', () => {
    // Pinned, so an attach to a session whose window is gone refuses rather
    // than landing in a live `pup-<id>-1` the bare name prefix-matches
    // (decision 46).
    it('targets the session window on the default server, by its pinned name', () => {
      expect(sessionAttachTarget(SESSION).args).toEqual(['attach', '-t', `=pup-${SESSION}:`]);
      expect(sessionAttachTarget(SESSION).label).toBe(`pup-${SESSION}`);
    });

    // The conductor's window is on a tmux server of its own, so a bare
    // `attach -t` would ask the wrong one (decision 47).
    it('carries the socket for the conductor window', () => {
      const snapshot = {
        projectId: 'ab12cd34ef56',
        conductor: { running: true, name: 'pup-conductor-ab12cd34ef56', attachCommand: '' },
      } as DashboardSnapshot;

      expect(conductorAttachTarget(snapshot).args).toEqual([
        '-L',
        'pup-conductor-ab12cd34ef56',
        'attach',
        '-t',
        '=pup-conductor-ab12cd34ef56:',
      ]);
    });

    it('hands tmux the terminal it is holding', () => {
      const result = attachTo(sessionAttachTarget(SESSION));

      expect(spawnSync).toHaveBeenCalledWith('tmux', ['attach', '-t', `=pup-${SESSION}:`], {
        stdio: 'inherit',
      });
      expect(result.message).toContain(`pup-${SESSION}`);
    });

    it('reports a tmux that refused rather than claiming a detach', () => {
      vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);

      expect(attachTo(sessionAttachTarget(SESSION)).failed).toBe(true);
    });
  });

  describe('merge', () => {
    /** A `pup merge` child that has not run: two streams and an exit to drive. */
    function fakeChild(): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
      const child = new EventEmitter() as ChildProcess & {
        stdout: PassThrough;
        stderr: PassThrough;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      return child;
    }

    it('re-enters `pup merge <session> --pr` as a child, in the repo', () => {
      const child = fakeChild();
      const spawnChild = vi.fn(() => child);

      runMerge(deps, SESSION, { onLine: () => {}, onExit: () => {} }, spawnChild);

      expect(spawnChild).toHaveBeenCalledWith(
        process.execPath,
        ['/abs/path/to/pup.js', 'merge', SESSION, '--pr'],
        { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    });

    // The point of the child: the stages reach the pane while the gate is still
    // running, not in one block when it is over.
    it('hands the pane each line as the child writes it, stderr included', () => {
      const child = fakeChild();
      const lines: string[] = [];

      runMerge(
        deps,
        SESSION,
        { onLine: (line) => lines.push(line), onExit: () => {} },
        () => child,
      );
      child.stdout.write('  tests           PASS\n  lint  ');
      expect(lines).toEqual(['  tests           PASS']);

      child.stdout.write('PASS\n');
      child.stderr.write('Gate failed; report re-injected.\n');

      expect(lines).toEqual([
        '  tests           PASS',
        '  lint  PASS',
        'Gate failed; report re-injected.',
      ]);
    });

    // The report quotes the session's own output, and this pane is drawn by Ink
    // (decision 29). The columns survive: they are what makes a stage list
    // readable, and the report is padded to them.
    it('strips the control characters and keeps the columns', () => {
      const child = fakeChild();
      const lines: string[] = [];

      runMerge(
        deps,
        SESSION,
        { onLine: (line) => lines.push(line), onExit: () => {} },
        () => child,
      );
      child.stdout.write('\u001b[2K  dead-code       PASS\n');

      expect(lines).toEqual([' [2K  dead-code       PASS']);
    });

    it('reports the exit code once, and a spawn that never started as no code', () => {
      const child = fakeChild();
      const codes: (number | null)[] = [];

      runMerge(
        deps,
        SESSION,
        { onLine: () => {}, onExit: (code) => codes.push(code) },
        () => child,
      );
      child.emit('error', new Error('spawn ENOENT'));
      child.emit('close', 1);

      expect(codes).toEqual([null]);
    });

    it('flushes a last line the child never terminated', async () => {
      const child = fakeChild();
      const lines: string[] = [];

      runMerge(
        deps,
        SESSION,
        { onLine: (line) => lines.push(line), onExit: () => {} },
        () => child,
      );
      child.stdout.end('no trailing newline');
      await new Promise((resolve) => setImmediate(resolve));

      expect(lines).toEqual(['no trailing newline']);
    });
  });
});
