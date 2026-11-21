import type { Tier } from '../../claude/enums/tier.enums.js';
import type { EventType } from '../enums/event-type.enums.js';
import type { TaskSpec } from './profile.types.js';
import type { SessionEvent } from './session-event.types.js';

export type SessionState =
  | 'queued'
  | 'running'
  | 'awaiting-review'
  | 'merged'
  | 'killed'
  | 'rejected'
  | 'blocked';

export interface SessionRow {
  id: string;
  task_id: string;
  worktree_path: string;
  branch: string;
  tmux_target: string | null;
  pid: number | null;
  state: SessionState;
  profile_hash: string;
  transcript_path: string | null;
  reject_count: number;
  /** The task's tier when the session launched; null on a session launched before routing (decision 92). */
  tier: string | null;
  /** Where on its tier's ladder the session's window runs, counted from 0. */
  rung: number | null;
  /** The model and effort its window's argv carries. */
  model: string | null;
  effort: string | null;
  /** Why the rung last climbed: a `ClimbReason`, or null on the first rung. */
  rung_reason: string | null;
  /** 1 when an explicit --model/--effort overrode the rung's; the rung still tracks the climb. */
  route_override: number;
  created_at: string;
}

/**
 * What a session's window runs on, as the store records it (decision 92). The
 * rung is kept under an override too, so a later relaunch without one climbs
 * from where the task actually stands.
 */
export interface SessionRoute {
  tier: Tier;
  rung: number;
  model: string;
  effort: string;
  reason?: string;
  override: boolean;
}

export interface NewSessionInput {
  id: string;
  taskId: string;
  worktreePath: string;
  branch: string;
  profileHash: string;
  tmuxTarget?: string;
  pid?: number;
  transcriptPath?: string;
  route?: SessionRoute;
}

export interface TaskRow {
  id: string;
  project_id: string;
  /** JSON TaskSpec. */
  spec: string;
  role: string | null;
  origin: string;
  /** The tier the operator set with `--tier`; null when the scope-in decides it (decision 92). */
  tier: string | null;
  /** When `pup plan drop` retired a task with session history; null while it is live (decision 147). */
  dropped_at: string | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  session_id: string | null;
  type: EventType;
  /** JSON object; shape depends on `type`. */
  payload: string;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  repo_path: string;
  /** JSON array of adapter ids. */
  adapters: string;
  /** JSON ProjectBaseline; null until `pup init` runs. */
  baseline: string | null;
  /**
   * Origin's URL as the trusted checkout had it when `pup init` recorded it —
   * the push target `pup merge --pr` is held to. Null until a `pup init` run
   * the operator made records one (decision 56).
   */
  origin_url: string | null;
  /**
   * When `pup project dormant` put the project to sleep, or null while it is
   * active; the fleet views and the radar pass over it (decision 62).
   */
  dormant_at: string | null;
  created_at: string;
}

export type DropTaskOutcome =
  | { kind: 'dropped' }
  | { kind: 'unknown' }
  | { kind: 'claimed'; sessionId: string };

export type TaskSpecPatch = Partial<
  Pick<TaskSpec, 'goal' | 'scopeIn' | 'scopeOut' | 'acceptance'>
> & {
  tier?: Tier;
};

/** A stored `question` event, with the row id that names it to the operator. */
export type StoredQuestion = Extract<SessionEvent, { type: 'question' }> & { id: number };

/** A `question` event still open, as `openQuestion` reads it: its options always a list. */
export type QuestionEvent = StoredQuestion & { options: string[] };
