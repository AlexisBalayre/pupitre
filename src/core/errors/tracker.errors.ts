/** The tracker could not be read or written: its CLI failed, was rate limited, or answered garbage. */
export class TrackerUnavailableError extends Error {
  constructor(
    message: string,
    readonly rateLimited = false,
  ) {
    super(message);
    this.name = 'TrackerUnavailableError';
  }
}
