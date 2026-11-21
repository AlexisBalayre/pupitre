import type { InterruptSignal } from '../enums/interrupt-signal.enums.js';
import { DECLARATION_VAR } from '../sandbox.utils.js';

/** A refusal with operator instructions in it, so the CLI prints it as one line. */
export class UndeclaredSandboxError extends Error {
  constructor() {
    super(
      `No sandbox on ${process.platform}, so gate children would run unconfined; refusing. ` +
        `Set ${DECLARATION_VAR}=vm if this machine is a disposable VM that is itself the sandbox.`,
    );
    this.name = 'UndeclaredSandboxError';
  }
}

/**
 * A gate child pup stopped because pup itself was interrupted: no stage
 * result, so no caller reports it as one. The gate, `pup init` and `pup audit`
 * unwind on it, record nothing, and the CLI exits as the signal would have
 * (decision 95).
 */
export class GateInterruptedError extends Error {
  constructor(readonly signal: InterruptSignal) {
    super(`Interrupted by ${signal}; every stage child was stopped.`);
    this.name = 'GateInterruptedError';
  }
}
