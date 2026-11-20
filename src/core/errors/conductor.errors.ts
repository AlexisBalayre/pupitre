/** A tell refused before anything was typed: nothing reached the conductor. */
export class ConductorTellRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConductorTellRefusedError';
  }
}
