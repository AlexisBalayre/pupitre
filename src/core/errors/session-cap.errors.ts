import { allowance, backlogTerms, minutes } from '../session-cap.service.js';
import type { LockBacklog, MachineLoad } from '../types/session-cap.types.js';

/** A launch refused because the merge lock already has more work queued than the project's budget. */
export class LockBacklogOverBudgetError extends Error {
  constructor(backlog: LockBacklog) {
    super(
      `The merge lock's backlog is ${minutes(backlog.minutes)} minutes, over the project's ` +
        `budget of ${minutes(backlog.budgetMinutes)} (${backlogTerms(backlog)}); nothing was ` +
        'launched. lockBacklogBudgetMinutes in .pupitre/project.yml sets the budget; only the ' +
        "operator's --over-cap goes beyond.",
    );
    this.name = 'LockBacklogOverBudgetError';
  }
}

/**
 * A launch or a fix round refused because the machine's load average is above
 * its cores. A fix round has no `--over-cap`, so its refusal offers none.
 */
export class MachineLoadedError extends Error {
  constructor(load: MachineLoad, refused: 'launch' | 'fix round' = 'launch') {
    super(
      `The machine's 1-minute load average is ${load.average.toFixed(1)}, above its ` +
        `${allowance(load)}; ` +
        (refused === 'launch'
          ? "nothing was launched. Wait for the load to fall; only the operator's --over-cap goes beyond."
          : 'the fix round was not started. Wait for the load to fall, then run it again.'),
    );
    this.name = 'MachineLoadedError';
  }
}
