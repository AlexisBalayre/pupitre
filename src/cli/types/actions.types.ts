import type { WindowTarget } from '../../claude/types/session-runtime.types.js';
import type { FleetStore } from '../../core/types/fleet.types.js';

export type ActionDeps = FleetStore;

export interface ActionResult {
  message: string;
  /** The action did not happen; the status bar says so in red. */
  failed?: boolean;
}

/** A tmux window this screen can hand the terminal over to. */
export interface AttachTarget {
  /** What the status bar calls it while the operator is away. */
  label: string;
  /** The window, for the runtime to attach to: its socket and pin are the runtime's to spell. */
  window: WindowTarget;
}

/** Where a merge child's output goes, line by line, as the gate produces it. */
export interface MergeHandlers {
  onLine: (line: string) => void;
  onExit: (code: number | null) => void;
}
