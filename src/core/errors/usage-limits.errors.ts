import { resetTime } from '../usage-limits.service.js';

/** A launch refused because a fresh reading puts one of the plan's windows at its hold line. */
export class UsageLimitReachedError extends Error {
  constructor(label: string, used: number, holdAt: number, resetsAt: number) {
    super(
      `The plan's ${label} usage is at ${Math.floor(used)}%, at or over the ${holdAt}% that ` +
        `holds launches; nothing was launched. It resets at ${resetTime(resetsAt)}. Wait for ` +
        'it, or, as the operator, pass --over-limit to `pup launch` or `pup new`.',
    );
    this.name = 'UsageLimitReachedError';
  }
}
