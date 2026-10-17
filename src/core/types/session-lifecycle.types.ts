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
  /** Launch despite a live session already holding files in this scope. */
  allowOverlap?: boolean;
  /**
   * Who answers for an allowed overlap in the `scope_overlap` record: the
   * operator or the conductor who passed the flag, or nobody — `createSession`
   * admitted the task before the holder existed and a refusal now would
   * orphan the row.
   */
  overlapVia?: 'operator' | 'conductor' | 'raced';
  /** Who named `model`/`effort`; only the operator's lifts the top-rung refusal. */
  overrideVia?: 'operator' | 'conductor';
}

export interface NewSessionRequest extends PlanTaskRequest {
  base: ProfileLayer;
  claudeUserDir: string;
  model?: string;
  effort?: string;
  allowOverlap?: boolean;
  /** Who passed `--allow-overlap`; the operator when unset. */
  overlapVia?: 'operator' | 'conductor';
}
