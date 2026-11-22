import type { InterruptSignal } from '../enums/interrupt-signal.enums.js';

/** Thrown out of `withTestSlot` when a session's wait runs out, so nothing runs. */
export class SlotWaitExpiredError extends Error {}

/** A wait for a slot that an interrupt of pup's own ended: nothing ran. */
export class SlotWaitInterruptedError extends Error {
  constructor(readonly signal: InterruptSignal) {
    super(`Interrupted by ${signal} while waiting for a test slot; nothing ran.`);
    this.name = 'SlotWaitInterruptedError';
  }
}
