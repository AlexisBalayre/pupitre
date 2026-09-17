import type { ChildProcess } from 'node:child_process';
import { type Key, useApp, useInput } from 'ink';
import { useRef, useState } from 'react';
import { HANDOFF_WAIT_DEFAULT_MS } from '../../core/session-handoff.service.js';
import type { DashboardSession, DashboardSnapshot } from '../../core/types/dashboard.types.js';
import {
  type ActionDeps,
  type ActionResult,
  type AttachTarget,
  attachTo,
  conductorAttachTarget,
  failure,
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
import { HANDOFF_POLL_MS, MERGE_LOG_LINES } from './dashboard.constants.js';

/**
 * The dashboard's hands, as `useSnapshot` is its clock: every keypress, what
 * one is waiting on, and the line it left behind. It holds state and calls
 * `actions.service`; it renders nothing, and the components it feeds decide
 * nothing (decision 52). One hook rather than a handler per component because
 * the keys are modal — a prompt open over the table has to swallow `k` before
 * the table reads it as a kill, and that is one decision, made once, here.
 */

/** What the screen is waiting for the operator to answer. */
export type ControlPrompt =
  | { kind: 'confirm'; question: string }
  | { kind: 'input'; label: string; value: string };

/** A merge child's output, as the log pane shows it. */
export interface MergeLog {
  sessionId: string;
  /** The tail the pane keeps, oldest first. */
  lines: string[];
  /** Where `lines[0]` sits in everything the child has written, counting from 0. */
  firstLine: number;
  running: boolean;
}

/**
 * The row the detail pane shows: the session or the planned task under the
 * cursor, as the snapshot carries it. The row itself rather than an index, so
 * the pane is drawn from the reading and has nothing to look up.
 */
export type DetailRow =
  | { kind: 'session'; session: DashboardSession }
  | { kind: 'task'; task: DashboardSnapshot['backlog'][number] };

export interface ControlStatus {
  message: string;
  failed: boolean;
}

/**
 * What the hook hands the layout. Private to this file, like the reading hook's
 * own return type: it is the shape of one function's answer, and a second
 * reader that named it would be building a dashboard's state by hand.
 */
interface Controls {
  /** The row the keys act on, clamped to the list as it currently stands. */
  cursor: number;
  prompt?: ControlPrompt;
  mergeLog?: MergeLog;
  /** Set while the detail pane is open and the cursor is on a row. */
  detail?: DetailRow;
  status?: ControlStatus;
  /** An action is in flight and the keys are deaf until it lands. */
  busy: boolean;
}

/** A prompt and what to do with the answer; `run` is the action itself. */
type PendingPrompt =
  | { kind: 'confirm'; question: string; run: () => void }
  | { kind: 'input'; label: string; value: string; run: (value: string) => void };

export function useControls({
  deps,
  snapshot,
  live,
  refresh,
  readOnly,
}: {
  deps: ActionDeps;
  snapshot: DashboardSnapshot;
  /** The session rows on screen, in the order they are drawn. */
  live: DashboardSession[];
  refresh: () => void;
  /** A session or the conductor is watching: every mutating key is unbound. */
  readOnly: boolean;
}): Controls {
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp();
  const [selected, setSelected] = useState(0);
  /**
   * The model the last launch was given, offered as the next one's default: a
   * fleet run on one model is then one keystroke per launch rather than the
   * same string retyped. A convenience for one sitting at one screen — a
   * fleet's actual default model is the profile's business, not this screen's.
   */
  const lastModel = useRef('');
  const [prompt, setPrompt] = useState<PendingPrompt | undefined>();
  const [mergeLog, setMergeLog] = useState<MergeLog | undefined>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [status, setStatus] = useState<ControlStatus | undefined>();
  const [busy, setBusy] = useState(false);
  /**
   * The merge child, while one is running. Held so `q` can end it: the gate
   * takes minutes, and a screen whose only way out was Ctrl-C would SIGINT the
   * child along with this process, leaving the lock directory `withMergeLock`
   * releases in a `finally` that a signal-killed process never reaches.
   */
  const mergeChild = useRef<ChildProcess | undefined>(undefined);

  const rowCount = live.length + snapshot.backlog.length;
  // Clamped at render rather than on every keypress: a merge or a launch can
  // shorten the list under a cursor that was in range when it was last moved.
  const cursor = Math.min(selected, Math.max(rowCount - 1, 0));
  const session = live[cursor];
  const task = snapshot.backlog[cursor - live.length];
  const detail: DetailRow | undefined = !detailOpen
    ? undefined
    : session
      ? { kind: 'session', session }
      : task && { kind: 'task', task };

  /** Report an action and re-read the store, so the row reflects what just happened. */
  function settle(result: ActionResult): void {
    setStatus({ message: result.message, failed: Boolean(result.failed) });
    refresh();
  }

  function say(message: string, failed = false): void {
    setStatus({ message, failed });
  }

  /** Run an action against the selected session, or say why there is none. */
  function onSession(verb: string, act: (id: string) => void): void {
    if (!session) {
      say(`Nothing to ${verb}: the cursor is not on a session.`, true);
      return;
    }
    act(session.id);
  }

  function answerPrompt(input: string, key: Key): void {
    if (!prompt) return;
    if (key.escape) {
      setPrompt(undefined);
      say('Cancelled.');
      return;
    }
    if (prompt.kind === 'confirm') {
      if (input !== 'y' && input !== 'n') return;
      setPrompt(undefined);
      if (input === 'n') say('Cancelled.');
      else prompt.run();
      return;
    }
    if (key.return) {
      setPrompt(undefined);
      prompt.run(prompt.value);
      return;
    }
    if (key.backspace || key.delete) {
      setPrompt({ ...prompt, value: prompt.value.slice(0, -1) });
      return;
    }
    // Control and meta chords are for the terminal, not the field; a stray
    // Ctrl-L would otherwise land in the middle of a steer.
    if (input && !key.ctrl && !key.meta) setPrompt({ ...prompt, value: prompt.value + input });
  }

  /**
   * Run an action that blocks this thread, after the frame that says so is on
   * screen. `kickoff` polls a new window for readiness for up to ~51 s, a steer
   * for 3.5 s, and a conductor start does both — called straight out of the key
   * handler they would freeze the dashboard with the pre-keypress frame still
   * drawn, which is exactly the freeze decision 52's addendum forbids. Ink's
   * `waitUntilRenderFlush` yields to React's scheduler and settles once the new
   * frame has reached stdout, so the line naming the wait is always what the
   * operator is looking at while the thread is gone.
   */
  function runAfterFrame(waiting: string, act: () => ActionResult): void {
    setBusy(true);
    say(waiting);
    void waitUntilRenderFlush().then(() => {
      try {
        settle(act());
      } finally {
        setBusy(false);
      }
    });
  }

  /** The respawn's wait, and the merge's, both run past this handler's return. */
  function startRespawn(sessionId: string): void {
    setBusy(true);
    say(`Asked ${sessionId} for a handoff; waiting …`);
    void respawnSelected(deps, sessionId, HANDOFF_WAIT_DEFAULT_MS, HANDOFF_POLL_MS, (elapsed) => {
      say(`Waiting for ${sessionId}'s handoff … ${Math.round(elapsed / 1000)}s`);
    }).then((result) => {
      setBusy(false);
      settle(result);
    });
  }

  function startMerge(sessionId: string): void {
    setBusy(true);
    setMergeLog({ sessionId, lines: [], firstLine: 0, running: true });
    try {
      mergeChild.current = runMerge(deps, sessionId, {
        onLine: (line) =>
          setMergeLog((log) => {
            if (!log?.running) return log;
            // Only the tail is kept: the gate prints a stage per line and the
            // pane is a few rows of a screen that also has a fleet on it. What
            // scrolls off the top advances `firstLine`, because the ordinal is
            // the only identity these lines have — two stages can both print
            // `ok`, and a key that came round again would draw the thirteenth
            // line over the first.
            const kept = [...log.lines, line];
            const dropped = Math.max(kept.length - MERGE_LOG_LINES, 0);
            return { ...log, lines: kept.slice(dropped), firstLine: log.firstLine + dropped };
          }),
        onExit: (code) => {
          mergeChild.current = undefined;
          setBusy(false);
          setMergeLog((log) => (log ? { ...log, running: false } : log));
          settle(
            code === 0
              ? { message: `Merge of ${sessionId} passed — the PR line is in the log above.` }
              : {
                  message: `Merge of ${sessionId} did not land (exit ${code ?? 'no code'}); the log above says where it stopped.`,
                  failed: true,
                },
          );
        },
      });
    } catch (error) {
      // A child that could not even be spawned: without this the pane would sit
      // on `waiting for the first stage …` with every key dead behind `busy`.
      mergeChild.current = undefined;
      setBusy(false);
      setMergeLog(undefined);
      settle(failure(error));
    }
  }

  /**
   * Hand the terminal to tmux and take it back on detach. `suspendTerminal`
   * leaves the alternate screen, gives the input stream back and forces a full
   * redraw afterwards, which is the whole of what an attach needs and none of
   * what unmounting and remounting would cost — the reading, the cursor and the
   * status line all survive the round trip.
   */
  function startAttach(target: AttachTarget): void {
    setBusy(true);
    let result: ActionResult = { message: `Left ${target.label}.` };
    void suspendTerminal(() => {
      result = attachTo(target);
    })
      .then(() => settle(result))
      // A suspension that throws — a terminal that would not hand the input
      // stream back — must still give the keys back, or the dashboard is left
      // on screen and deaf with no way out but Ctrl-C.
      .catch((error: unknown) => settle(failure(error)))
      .finally(() => setBusy(false));
  }

  function startConductorToggle(): void {
    if (snapshot.conductor.running) {
      runAfterFrame('Stopping the conductor …', () =>
        toggleConductor(deps, true, { model: '', workerModel: '' }),
      );
      return;
    }
    setPrompt({
      kind: 'input',
      label: 'conductor model (blank for the default)',
      value: '',
      run: (model) =>
        setPrompt({
          kind: 'input',
          label: 'worker model the conductor launches sessions on (blank for the default)',
          value: '',
          run: (workerModel) =>
            runAfterFrame('Starting the conductor: waiting for its window …', () =>
              toggleConductor(deps, false, { model, workerModel }),
            ),
        }),
    });
  }

  useInput((input, key) => {
    // An action in flight owns the screen: a second merge, or a kill of the
    // session a respawn is waiting on, is not a keypress anyone means. `q` is
    // the exception, and only against the merge: the gate runs for minutes, and
    // the alternative way out was Ctrl-C, which signals the child along with
    // this process and strands the lock directory it would have released.
    if (busy) {
      if (input === 'q' && mergeChild.current) {
        mergeChild.current.kill('SIGTERM');
        mergeChild.current = undefined;
        exit();
      }
      return;
    }
    if (prompt) return answerPrompt(input, key);
    if (mergeLog && (key.escape || key.return)) return setMergeLog(undefined);
    // The detail pane is a view of the row under the cursor, not a mode: the
    // arrows still move it and the keys below still act on the row it shows,
    // so only Enter and Esc are its own. Above the read-only cut, because
    // reading a row is looking, and looking is refused to nobody.
    if (key.return) {
      if (!session && !task) return say('Nothing to open: there are no rows.', true);
      return setDetailOpen(true);
    }
    if (key.escape) return setDetailOpen(false);
    if (input === 'q') return exit();
    if (input === 'r') return refresh();
    if (key.downArrow) return setSelected(Math.min(cursor + 1, rowCount - 1));
    if (key.upArrow) return setSelected(Math.max(cursor - 1, 0));
    if (readOnly) return;
    switch (input) {
      case 'l':
        if (!task) return say('Nothing to launch: the cursor is not on a planned task.', true);
        return setPrompt({
          kind: 'input',
          label: `model for ${task.id} (blank for the default)`,
          // The last model typed, so a fleet run on one model is one keystroke
          // per launch rather than the same string retyped every time.
          value: lastModel.current,
          run: (model) => {
            lastModel.current = model;
            runAfterFrame(`Launching ${task.id}: waiting for the window …`, () =>
              launchSelected(deps, task.id, model),
            );
          },
        });
      case 's':
        return onSession('steer', (id) =>
          setPrompt({
            kind: 'input',
            label: `steer ${id}`,
            value: '',
            run: (message) => {
              if (!message) return say('Nothing typed; nothing sent.');
              runAfterFrame(`Steering ${id}: waiting for the paste to land …`, () =>
                steerSelected(deps, id, message),
              );
            },
          }),
        );
      case 'i':
        return onSession('interrupt', (id) => settle(interruptSelected(deps, id)));
      case 'k':
        return onSession('kill', (id) =>
          setPrompt({
            kind: 'confirm',
            question: `Kill ${id}? Its window goes and its task returns to the backlog.`,
            run: () => settle(killSelected(deps, id)),
          }),
        );
      case 'u':
        if (!session) return say('Nothing to unblock: the cursor is not on a session.', true);
        if (session.state !== 'blocked') {
          return say(`${session.id} is ${session.state}; only blocked sessions unblock.`, true);
        }
        // The reason first, and read from the store rather than typed by the
        // operator: unblocking is a claim that the block was addressed, and
        // nobody can make that claim about a reason they were never shown.
        return setPrompt({
          kind: 'confirm',
          question: `${session.id} was blocked: ${selectedBlockedReason(deps, session.id)} — unblock?`,
          run: () => settle(unblockSelected(deps, session.id)),
        });
      case 'R':
        return onSession('respawn', startRespawn);
      case 'a':
        return onSession('attach', (id) => startAttach(sessionAttachTarget(id)));
      case 'A':
        if (!snapshot.conductor.running) return say('No conductor to attach to.', true);
        return startAttach(conductorAttachTarget(snapshot));
      case 'c':
        return startConductorToggle();
      case 'm': {
        if (!session) return say('Nothing to merge: the cursor is not on a session.', true);
        if (session.state !== 'awaiting-review') {
          return say(`${session.id} is ${session.state}; only a finished branch merges.`, true);
        }
        const id = session.id;
        // Confirmed, unlike the steer or the interrupt: a passing gate pushes
        // the branch and opens a pull request, and `m` sits under the cursor
        // keys this screen is navigated with.
        return setPrompt({
          kind: 'confirm',
          question: `Run the gate on ${id} and open a PR on a pass?`,
          run: () => startMerge(id),
        });
      }
      default:
        return;
    }
  });

  return {
    cursor,
    ...(prompt
      ? {
          prompt:
            prompt.kind === 'confirm'
              ? ({ kind: 'confirm', question: prompt.question } as const)
              : ({ kind: 'input', label: prompt.label, value: prompt.value } as const),
        }
      : {}),
    ...(mergeLog ? { mergeLog } : {}),
    ...(detail ? { detail } : {}),
    ...(status ? { status } : {}),
    busy,
  };
}
