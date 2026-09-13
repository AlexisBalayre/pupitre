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
  startConductor: vi.fn(() => ({ name: 'pup-conductor-x', delivered: true })),
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
  listEvents,
  transitionSession,
} from '../../core/session.repository.js';
import {
  isHandoffReady,
  requestHandoff,
  respawnSession,
} from '../../core/session-handoff.service.js';
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
    // the kickoff can be refused, so a refusal that is not rolled back leaves a
    // claimed task no relaunch can take and an empty window (decision 40).
    it('kills the session and says so when the kickoff never landed', () => {
      vi.mocked(launchTask).mockImplementation(() => {
        throw new SteerNotDeliveredError('s-half-1', 12);
      });

      const result = launchSelected(deps, 't-planned', '');

      expect(killSession).toHaveBeenCalledWith(db, 's-half-1');
      expect(result.failed).toBe(true);
      expect(result.message).toContain('rolled back');
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

  it('steers through `steerSession` and records the steer, as `pup steer` does', () => {
    const result = steerSelected(deps, SESSION, 'read docs/05 first');

    expect(steerSession).toHaveBeenCalledWith(db, SESSION, 'read docs/05 first');
    expect(listEvents(db, SESSION).map((event) => event.type)).toContain('steer');
    expect(result.message).toContain(SESSION);
  });

  it('interrupts through `interruptSession` and records the interrupt', () => {
    interruptSelected(deps, SESSION);

    expect(interruptSession).toHaveBeenCalledWith(db, SESSION);
    const interrupt = listEvents(db, SESSION).find((event) => event.type === 'interrupt');
    expect(interrupt && JSON.parse(interrupt.payload)).toEqual({ steered: false });
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
        repoPath: REPO,
        model: 'opus',
        workerModel: 'sonnet',
      });
      expect(result.message).toContain('pup-conductor-x');
    });

    it('stops the running one through `stopConductor`', () => {
      expect(toggleConductor(deps, true, { model: '', workerModel: '' }).message).toBe(
        'Conductor stopped.',
      );

      expect(stopConductor).toHaveBeenCalledWith(REPO);
      expect(startConductor).not.toHaveBeenCalled();
    });

    // A window with no context is a bypass-permissions agent in the main
    // checkout that has read none of its tier; killed, not left to inspect.
    it('kills a window that never became ready', () => {
      vi.mocked(startConductor).mockReturnValue({
        name: 'pup-conductor-x',
        delivered: false,
      } as ReturnType<typeof startConductor>);

      const result = toggleConductor(deps, false, { model: '', workerModel: '' });

      expect(stopConductor).toHaveBeenCalledWith(REPO);
      expect(result.failed).toBe(true);
    });
  });

  describe('attach', () => {
    it('targets the session window on the default server', () => {
      expect(sessionAttachTarget(SESSION).args).toEqual(['attach', '-t', `pup-${SESSION}`]);
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
        'pup-conductor-ab12cd34ef56',
      ]);
    });

    it('hands tmux the terminal it is holding', () => {
      const result = attachTo(sessionAttachTarget(SESSION));

      expect(spawnSync).toHaveBeenCalledWith('tmux', ['attach', '-t', `pup-${SESSION}`], {
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
