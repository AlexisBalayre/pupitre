/** Thrown when `handoff-done` is run before the handoff document exists. */
export class HandoffMissingError extends Error {
  constructor(sessionId: string, handoffPath: string) {
    super(
      `No handoff at ${handoffPath}. Write the document for ${sessionId} before running ` +
        '`pup session handoff-done`.',
    );
    this.name = 'HandoffMissingError';
  }
}
