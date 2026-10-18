import type { Tier } from '../../claude/model-ladder.constants.js';
import type { ProfileLayer, TaskSpec } from './profile.types.js';

export interface PlanTaskRequest {
  repoPath: string;
  task: TaskSpec;
  role?: ProfileLayer;
  /** Who created the task (tasks.origin); defaults to 'human'. */
  origin?: string;
  /** `--tier`, over the one the scope-in implies; stored, and unset leaves the scope to decide (decision 92). */
  tier?: Tier;
}

/**
 * The operator's explicit `--model`/`--effort`, honoured over the rung's and
 * recorded on the session as an override (decision 92).
 */
export interface RouteOverride {
  model?: string;
  effort?: string;
}

export interface LaunchTaskRequest {
  repoPath: string;
  base: ProfileLayer;
  role?: ProfileLayer;
  taskId: string;
  claudeUserDir: string;
  model?: string;
  effort?: string;
  /** Who launched it, named in the `scope_overlap` record; the operator when unset. */
  overlapVia?: 'operator' | 'conductor';
  /** Who named `model`/`effort`; only the operator's lifts the top-rung refusal. */
  overrideVia?: 'operator' | 'conductor';
}

export interface NewSessionRequest extends PlanTaskRequest {
  base: ProfileLayer;
  claudeUserDir: string;
  model?: string;
  effort?: string;
  /** Who launched it, named in the `scope_overlap` record; the operator when unset. */
  overlapVia?: 'operator' | 'conductor';
}

/**
 * A live session sharing files with a worker being launched (decision 99): the
 * name it is reached by over SendMessage, and the files the two share.
 */
export interface SessionPeer {
  name: string;
  files: string[];
}
