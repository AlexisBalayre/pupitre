import type { AskOptions } from '../../core/types/session-event.types.js';

/** An error class a launch answers for rather than crashes on. */
export type ExpectedLaunchError = new (...args: never[]) => Error;

export interface ConductorOptions extends AskOptions {
  model?: string;
  effort?: string;
  workerModel?: string;
}

export interface LandOptions {
  gateEnv?: string;
  audit: boolean;
  acceptHead?: string;
  abandonClosed?: boolean;
  remeasure?: boolean;
  approvedBy?: string;
}

export interface PlanOptions {
  scope?: string[];
  scopeOut?: string[];
  accept?: string[];
  goal?: string;
  tier?: string;
  rescope?: boolean;
}
