import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizeReason } from '../../adapters/capability.utils.js';
import {
  conductorSocket,
  SessionPaneMissingError,
  SteerNotDeliveredError,
} from '../../claude/session-runtime.service.js';
import { startConductor, stopConductor } from '../../core/conductor.service.js';
import { blockedReason } from '../../core/dashboard.service.js';
import { DEFAULT_BASE_PROFILE } from '../../core/default-profile.constants.js';
import { appendEvent, getSession, transitionSession } from '../../core/session.repository.js';
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
import type { FleetStore } from '../../core/types/fleet.types.js';

/**
 * Every write `pup ui` can make, and the only place it makes one. Each function
 * here calls the same core function the matching `pup` command calls — decision
 * 52's corollary, that an action never gets a private path of its own — and
 * hands back a line for the status bar instead of printing one. The components
 * and the controls hook import this; nothing in `src/cli/ui` touches the store
 * or a process anywhere else.
 *
 * Why a message rather than a throw: this screen is held open. A CLI command
 * that hits an unexpected error should die with its stack, because the operator
 * gets the shell back and can read it; a dashboard that did the same would tear
 * down the render and leave the terminal on the alternate buffer. So every
 * action answers with a line, and a line that reports a failure says so.
 */

export type ActionDeps = FleetStore;

export interface ActionResult {
  message: string;
  /** The action did not happen; the status bar says so in red. */
  failed?: boolean;
}

/**
 * Run one action and turn whatever it throws into a status line. Core functions
 * throw refusals the operator is meant to read (a claimed task, a colliding
 * scope, a pane that is gone) and bugs that they are not, and on a screen both
 * have the same right answer: say what happened and leave the dashboard up.
 */
function attempt(act: () => string): ActionResult {
  try {
    return { message: act() };
  } catch (error) {
    return failure(error);
  }
}

/**
 * A thrown error as a status line. Sanitized, because a refusal quotes what it
 * refused — a gate report, a session's own words — and Ink passes an ANSI
 * escape straight through to the one screen the operator decides from
 * (decision 29).
 */
export function failure(error: unknown): ActionResult {
  return {
    message: sanitizeReason(error instanceof Error ? error.message : String(error)),
    failed: true,
  };
}

/**
 * `pup launch`: claim a backlog task and open a session on it. The rollback is
 * the CLI's own — `launchTask` claims the task, inserts the row and opens the
 * window before the kickoff can be refused, so a kickoff that never landed
 * leaves a claimed task and an empty window unless the session is killed
 * (decision 40). `model` empty means the profile's default, as omitting
 * `--model` does.
 */
export function launchSelected(deps: ActionDeps, taskId: string, model: string): ActionResult {
  return attempt(() => {
    try {
      const sessionId = launchTask(deps.db, {
        repoPath: deps.repoPath,
        base: DEFAULT_BASE_PROFILE,
        taskId,
        claudeUserDir: join(homedir(), '.claude'),
        ...(model ? { model } : {}),
      });
      return `Launched ${sessionId} (tmux: pup-${sessionId}).`;
    } catch (error) {
      if (!(error instanceof SteerNotDeliveredError || error instanceof SessionPaneMissingError)) {
        throw error;
      }
      killSession(deps.db, error.sessionId);
      throw new Error(
        `${error.message} Launch rolled back (session ${error.sessionId} killed); ` +
          `press l on ${taskId} again.`,
      );
    }
  });
}

/** `pup steer`: type a correction into the session's launch pane, and record it. */
export function steerSelected(deps: ActionDeps, sessionId: string, message: string): ActionResult {
  return attempt(() => {
    steerSession(deps.db, sessionId, message);
    appendEvent(deps.db, sessionId, 'steer', { kind: 'manual' });
    return `Steered ${sessionId}.`;
  });
}

/**
 * `pup interrupt` with no message: Escape to the pane. The message form is the
 * CLI's, and the screen already has a key for the steer that would follow it.
 */
export function interruptSelected(deps: ActionDeps, sessionId: string): ActionResult {
  return attempt(() => {
    interruptSession(deps.db, sessionId);
    appendEvent(deps.db, sessionId, 'interrupt', { steered: false });
    return `Interrupted ${sessionId}.`;
  });
}

/** `pup kill`: the window goes and the task returns to the backlog (decision 40). */
export function killSelected(deps: ActionDeps, sessionId: string): ActionResult {
  return attempt(() => {
    killSession(deps.db, sessionId);
    return `Killed ${sessionId}; its task is back in the backlog.`;
  });
}

/** What the gate recorded when it parked a session, for the `u` confirmation. */
export function selectedBlockedReason(deps: ActionDeps, sessionId: string): string {
  return blockedReason(deps.db, sessionId) ?? '(no reason recorded)';
}

/**
 * `pup unblock`: back to `running` once the human the gate asked for has dealt
 * with the block. Nothing else is reset, the reject count least of all — the
 * cap is what parked the session, and rolling it back would let the same
 * failure loop through the gate forever.
 */
export function unblockSelected(deps: ActionDeps, sessionId: string): ActionResult {
  return attempt(() => {
    // Re-read rather than trust the row the key was pressed on: that row comes
    // from a reading up to two seconds old, and the confirmation it opened can
    // sit unanswered for as long as the operator looks away. `running` is a
    // legal target from `awaiting-review`, so a stale `y` on a session that was
    // unblocked elsewhere and has since finished would quietly reopen a branch
    // that is waiting to be merged. `pup unblock` asks the store at the moment
    // it acts, and so does this.
    const row = getSession(deps.db, sessionId);
    if (!row) throw new Error(`No session ${sessionId}.`);
    if (row.state !== 'blocked') {
      throw new Error(`Session ${sessionId} is ${row.state}; only blocked sessions unblock.`);
    }
    transitionSession(deps.db, sessionId, 'running', { kind: 'operator-unblock' });
    return `Unblocked ${sessionId}; its window is untouched.`;
  });
}

/**
 * `pup respawn`'s flow, with the wait yielded back to the render loop. The CLI
 * waits in `awaitHandoffReady`, which sleeps the thread; here that would freeze
 * every frame, stop the two-second reading and swallow every keypress for up to
 * ten minutes — the one thing a held-open screen must not do. So the poll is
 * the same poll, awaited instead of slept, and `onWaiting` puts it on screen.
 */
export async function respawnSelected(
  deps: ActionDeps,
  sessionId: string,
  waitMs: number,
  pollMs: number,
  onWaiting: (elapsedMs: number) => void,
): Promise<ActionResult> {
  const { db, repoPath } = deps;
  try {
    if (!isHandoffReady(db, repoPath, sessionId)) {
      requestHandoff(db, repoPath, sessionId);
      const deadline = Date.now() + waitMs;
      const startedAt = Date.now();
      while (!isHandoffReady(db, repoPath, sessionId)) {
        if (Date.now() >= deadline) {
          return {
            message:
              `${sessionId} has not signalled handoff-done yet (steers queue until its turn ` +
              'ends). Press R again to ask and keep waiting.',
            failed: true,
          };
        }
        onWaiting(Date.now() - startedAt);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
    respawnSession(db, repoPath, sessionId);
    return { message: `Respawned ${sessionId} on a fresh context window with its handoff.` };
  } catch (error) {
    return failure(error);
  }
}

/**
 * `pup conductor start|stop`, chosen by what the snapshot says is running. The
 * start is the CLI's whole start: a window that never became ready has had no
 * context delivered, and is a bypass-permissions agent sitting in the main
 * checkout, so it is killed rather than left to inspect.
 */
export function toggleConductor(
  deps: ActionDeps,
  running: boolean,
  models: { model: string; workerModel: string },
): ActionResult {
  return attempt(() => {
    if (running) {
      stopConductor(deps.repoPath);
      return 'Conductor stopped.';
    }
    const handle = startConductor({
      repoPath: deps.repoPath,
      base: DEFAULT_BASE_PROFILE,
      claudeUserDir: join(homedir(), '.claude'),
      ...(models.model ? { model: models.model } : {}),
      ...(models.workerModel ? { workerModel: models.workerModel } : {}),
    });
    if (!handle.delivered) {
      stopConductor(deps.repoPath);
      throw new Error(
        `Conductor window ${handle.name} never became ready, so its context was not delivered ` +
          'and the window was killed. Press c again.',
      );
    }
    return `Conductor running (tmux: ${handle.name}).`;
  });
}

/** A tmux window this screen can hand the terminal over to. */
export interface AttachTarget {
  /** What the status bar calls it while the operator is away. */
  label: string;
  /** Arguments to `tmux`, socket included where the window is not on the default one. */
  args: string[];
}

export function sessionAttachTarget(sessionId: string): AttachTarget {
  return { label: `pup-${sessionId}`, args: ['attach', '-t', `pup-${sessionId}`] };
}

/**
 * The conductor's window is on a tmux server of its own, so its target carries
 * the `-L` socket: a bare `attach -t` asks the default server, which is
 * deliberately not where that window lives (decision 47).
 */
export function conductorAttachTarget(snapshot: DashboardSnapshot): AttachTarget {
  return {
    label: snapshot.conductor.name,
    args: ['-L', conductorSocket(snapshot.projectId), 'attach', '-t', snapshot.conductor.name],
  };
}

/**
 * Hand the terminal to tmux and take it back when the operator detaches. The
 * caller unmounts Ink first: tmux wants the primary screen and the raw input
 * this process is holding, and an attach under a live render loop fights it for
 * both.
 */
export function attachTo(target: AttachTarget): ActionResult {
  const result = spawnSync('tmux', target.args, { stdio: 'inherit' });
  if (result.error) return { message: result.error.message, failed: true };
  if (result.status !== 0) {
    return { message: `tmux attach -t ${target.label} exited ${result.status}.`, failed: true };
  }
  return { message: `Detached from ${target.label}.` };
}

/**
 * One line of a child's output, safe for Ink to draw. The gate report quotes
 * the session's own output, so the control characters go: an ANSI cursor move
 * could repaint a FLAGGED stage as PASS on the one screen the operator decides
 * from (decision 29). The spacing stays, which is why this is not
 * `sanitizeReason` — that collapses runs of whitespace to keep a stored event
 * on one line, and here the runs are the report's columns. The pane's own
 * truncation handles the width; the cap only keeps a child that never writes a
 * newline from putting a megabyte in a frame.
 */
function drawableLine(line: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return [...line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')].slice(0, 500).join('');
}

/** Where a merge child's output goes, line by line, as the gate produces it. */
export interface MergeHandlers {
  onLine: (line: string) => void;
  onExit: (code: number | null) => void;
}

/**
 * `pup merge <session> --pr`, run as a child of this process rather than called
 * in-process. `runMergeGate` is one synchronous pipeline that clones, installs,
 * builds, tests and audits — minutes of it — and returns a report at the end;
 * called here it would freeze every frame and show nothing until it was over,
 * which is exactly the stretch the operator wants to watch. The child prints
 * each stage as it finishes, so the pane fills as the gate runs.
 *
 * It is also the one action that keeps the CLI's guards on the far side of a
 * process boundary: the child re-resolves the project and re-asks whether its
 * caller is a session or the conductor, so the read-only rule this screen
 * enforces is enforced again by the thing doing the work.
 */
export function runMerge(
  deps: ActionDeps,
  sessionId: string,
  handlers: MergeHandlers,
  spawnChild: (...args: Parameters<typeof spawn>) => ChildProcess = spawn,
): ChildProcess {
  const child = spawnChild(process.execPath, [deps.pupBin, 'merge', sessionId, '--pr'], {
    cwd: deps.repoPath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const emit = (line: string) => handlers.onLine(drawableLine(line));
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) emit(line);
    });
    stream?.on('end', () => {
      if (pending) emit(pending);
      pending = '';
    });
  }
  // A child that could not be spawned emits `error`, and may emit `close`
  // behind it; the pane is told once either way.
  let ended = false;
  const end = (code: number | null) => {
    if (ended) return;
    ended = true;
    handlers.onExit(code);
  };
  child.on('error', (error) => {
    emit(error.message);
    end(null);
  });
  child.on('close', (code) => end(code));
  return child;
}
