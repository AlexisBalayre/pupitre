import type { ProfileLayer, TaskSpec } from './profile.types.js';

export interface PlanTaskRequest {
  repoPath: string;
  task: TaskSpec;
  role?: ProfileLayer;
  /** Who created the task (tasks.origin); defaults to 'human'. */
  origin?: string;
}

export interface LaunchTaskRequest {
  repoPath: string;
  base: ProfileLayer;
  role?: ProfileLayer;
  taskId: string;
  claudeUserDir: string;
  model?: string;
  /** Launch despite a live session already holding files in this scope. */
  allowOverlap?: boolean;
}

export interface NewSessionRequest extends PlanTaskRequest {
  base: ProfileLayer;
  claudeUserDir: string;
  model?: string;
  allowOverlap?: boolean;
}
