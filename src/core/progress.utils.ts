/**
 * The one status line a long-running command keeps on stderr (decision 184):
 * `stage N/M, <name>, <elapsed>`, the elapsed time counted from the command's
 * start. On a terminal it is rewritten in place and ticks; off one each stage
 * change is a plain line with no cursor control, so a conductor or a hook
 * reading the output reads text, and stdout is left as it was.
 */

/** The stage every command that takes the merge lock shows while it waits for it. */
export const MERGE_LOCK_STAGE = 'merge lock';

/**
 * Each command's stages in the order they run, as its status line numbers
 * them. `pup merge`'s suites, lint and debt measurements run at once, so they
 * are one stage.
 */
export const MERGE_STAGES = [
  'plan',
  MERGE_LOCK_STAGE,
  'worktree-clean',
  'fresh-base',
  'build',
  'tests and checks',
  'scope-audit',
  'debt',
  'merge',
] as const;
export const LAND_STAGES = [
  'read PR',
  MERGE_LOCK_STAGE,
  'fetch',
  'fast-forward',
  'tear down',
  'steer',
  'audit',
] as const;
export const AUDIT_STAGES = ['measure baseline', 'compare'] as const;
export const FIX_STAGES = [
  'read review',
  'compile profile',
  MERGE_LOCK_STAGE,
  'restore worktree',
  'open window',
] as const;
export const RESPAWN_STAGES = ['request handoff', 'wait for handoff', 'relaunch'] as const;
export const CI_WAIT_STAGES = ['find PR', 'wait for review'] as const;

/** Where the line goes: stderr, or a test's stand-in. */
interface ProgressStream {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface StageProgress {
  /**
   * Enter `name`. Entering the stage already shown changes nothing, so a
   * synchronous wait can call it on every poll to redraw the ticking time.
   */
  stage(name: string): void;
  /** Print a whole line of its own without tearing the status line. */
  note(line: string): void;
  /**
   * Hand `listener` the current stage's label, empty before the first stage,
   * and every later one, until the function returned is called.
   */
  watch(listener: (label: string) => void): () => void;
  /** Clear the status line and stop its ticking; the command's own output follows. */
  end(): void;
}

/**
 * What a caller with no status line gets: a note goes to stderr as it always
 * did, and nothing else is printed.
 */
export const NO_PROGRESS: StageProgress = {
  stage: () => undefined,
  note: (line) => console.error(line),
  watch: (listener) => {
    listener('');
    return () => undefined;
  },
  end: () => undefined,
};

/** How often the terminal line redraws its time. */
const TICK_MS = 1000;

/** Back to the line's start, then erase it: the only cursor control written. */
const CLEAR_LINE = '\r\u001b[2K';

/** A span as an operator reads it: `42s`, `3m 04s`, `1h 07m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * The status line over `names`, the command's stages in the order they run;
 * a stage that does not run is skipped over, never shown. Its clock starts
 * now.
 */
export function stageProgress(
  names: readonly string[],
  stream: ProgressStream = process.stderr,
  now: () => number = Date.now,
): StageProgress {
  const started = now();
  const tty = stream.isTTY === true;
  const listeners = new Set<(label: string) => void>();
  let label = '';
  let shown = false;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const line = (): string => `${label}, ${formatElapsed(now() - started)}`;
  const draw = (): void => {
    shown = true;
    stream.write(`${CLEAR_LINE}${line()}`);
  };

  return {
    stage(name) {
      const at = names.indexOf(name);
      const next = at < 0 ? name : `stage ${at + 1}/${names.length}, ${name}`;
      if (next === label) {
        if (tty) draw();
        return;
      }
      label = next;
      for (const listener of listeners) listener(label);
      if (!tty) {
        stream.write(`${line()}\n`);
        return;
      }
      draw();
      if (!ticker) {
        ticker = setInterval(draw, TICK_MS);
        // A status line never keeps the command alive.
        ticker.unref();
      }
    },
    note(text) {
      if (!tty || !shown) {
        stream.write(`${text}\n`);
        return;
      }
      stream.write(`${CLEAR_LINE}${text}\n`);
      draw();
    },
    watch(listener) {
      listeners.add(listener);
      listener(label);
      return () => {
        listeners.delete(listener);
      };
    },
    end() {
      if (ticker) clearInterval(ticker);
      ticker = undefined;
      if (tty && shown) stream.write(CLEAR_LINE);
      shown = false;
    },
  };
}
