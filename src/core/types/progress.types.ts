/** Where the line goes: stderr, or a test's stand-in. */
export interface ProgressStream {
  isTTY?: boolean;
  write(chunk: string | Uint8Array, ...rest: never[]): unknown;
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
