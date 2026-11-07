/**
 * An intent command that could not be done: a malformed id, no such intent, a
 * file that is not a plain one, or an accept the file does not yet earn. The
 * message is the refusal the operator reads, and nothing was written.
 */
export class IntentRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentRefusedError';
  }
}
