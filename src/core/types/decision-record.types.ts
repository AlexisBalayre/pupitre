import type { TaskSpec } from './profile.types.js';

export interface DecisionRecordRow {
  id: number;
  session_id: string;
  summary: string;
  alternatives: string | null;
  conventions: string | null;
  /** JSON array of repo-relative paths the merge touched. */
  files: string;
  created_at: string;
}

export interface NewDecisionRecordInput {
  sessionId: string;
  summary: string;
  alternatives?: string;
  conventions?: string;
  files: string[];
}

export interface DraftDecisionRecordInput {
  sessionId: string;
  spec: TaskSpec;
  files: string[];
  /** Commit subjects on the merged branch, oldest first. */
  commitSubjects: string[];
}

export interface DraftedRecord {
  summary: string;
  alternatives?: string;
  conventions?: string;
}
