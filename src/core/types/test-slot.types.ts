import type { SlotHolderKind } from '../enums/slot-holder-kind.enums.js';
export interface SlotHolder {
  kind: SlotHolderKind;
  /** The session the run is for, as `pup session test` and the gate name it. */
  label: string;
  pid: number;
}

export interface TestSlotOptions {
  /** `~/.pupitre/slots` unless a test names another. */
  dir?: string;
  slots?: number;
  pollMs?: number;
  /** How long to wait before running without a slot; forever when unset. */
  maxWaitMs?: number;
  /**
   * Called when `maxWaitMs` ran out, before the run goes ahead without a slot;
   * what it throws ends the call with nothing run, as `pup session test`'s does.
   */
  onWaitExpired?: () => void;
  /**
   * Set, the run goes ahead without a slot when the slots cannot be used at
   * all, such as a file or a loop planted where their directory goes, and this
   * is told why; unset, that error is thrown. An interrupt is always thrown.
   */
  onSlotsUnusable?: (error: unknown) => void;
  /**
   * Called the first time the run waits, and again whenever the gates a
   * worker waits for change to others: who holds the slots, and the gates
   * queued first.
   */
  onWait?: (holders: SlotHolder[], gatesAhead: SlotHolder[]) => void;
}

export interface SlotRecord extends SlotHolder {
  /** Minted per take, so a release removes only the file it wrote. */
  token: string;
}
