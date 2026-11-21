export type GlobToken =
  | { kind: 'char'; char: string }
  | { kind: 'one' }
  | { kind: 'star' }
  | { kind: 'globstar' }
  | { kind: 'dirs' };

export interface GlobAutomaton {
  /** Per state, the moves that read one character. */
  moves: { to: number; reads: (char: string) => boolean }[][];
  /** Per state, the moves that read nothing. */
  skips: number[][];
  accept: number;
  /** Every literal character, which with `/` and one other is all an intersection has to try. */
  chars: string[];
}

/**
 * What a window ran into that climbs its task one rung at the next relaunch or
 * respawn, or at the next CI fix round for `repeat-fix-round` (decision 92).
 */
export type ClimbReason = 'gate-rejection' | 'repeat-fix-round' | 'turn-death' | 'stall';

/** Where a task's next window stands on its ladder, as `climbFrom` reads it. */
export interface Climb {
  rung: number;
  /** Why the rung last climbed, kept from the window before when this one does not climb. */
  reason?: string;
  /** Set when the window before failed on the top rung: `rung` is the top, and nothing is left to climb. */
  topReached?: ClimbReason;
}
