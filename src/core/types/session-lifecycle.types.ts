import type { Tier } from '../../claude/enums/tier.enums.js';
import type {
  SessionPaneMissingError,
  SteerNotDeliveredError,
} from '../../claude/errors/session-runtime.errors.js';
import type { WindowEnv } from '../../claude/types/session-runtime.types.js';
import type { EventType } from '../enums/event-type.enums.js';
import type { CompiledProfile, ProfileLayer, TaskSpec } from './profile.types.js';
import type { EventPayloads } from './session-event.types.js';

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

/**
 * The class of finding the conductor names on `pup fix --finding`, the only
 * kind that takes a round past the top rung of a session's ladder (decision 202).
 */
export type FindingClass = 'security' | 'wrong-result';

export interface LaunchTaskRequest {
  repoPath: string;
  base: ProfileLayer;
  role?: ProfileLayer;
  taskId: string;
  /**
   * `--session-env` as the command resolved it, once, where it started: the
   * window's variables and the config dir it hashes and runs on (decision 106).
   */
  windowEnv: WindowEnv;
  model?: string;
  effort?: string;
  /** Who launched it, named in the `scope_overlap` record; the operator when unset. */
  overlapVia?: 'operator' | 'conductor';
  /** Who named `model`/`effort`; only the operator's lifts the top-rung refusal. */
  overrideVia?: 'operator' | 'conductor';
}

export interface NewSessionRequest extends PlanTaskRequest {
  base: ProfileLayer;
  /**
   * `--session-env` as the command resolved it, once, where it started: the
   * window's variables and the config dir it hashes and runs on (decision 106).
   */
  windowEnv: WindowEnv;
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

/**
 * `--over-cap`: the operator's word that one more session may go past the
 * computed cap (decisions 96, 197); `--over-limit`, that one may start while
 * the plan's usage holds launches (decision 156). Only the operator's: a launch
 * the conductor makes ignores both.
 */
export interface CapOverride {
  overCap?: boolean;
  overLimit?: boolean;
}

/**
 * What a session's profile is compiled from besides its task: the base layer
 * and the user config. A role is the launch caller's to pass, and only an API
 * caller does: the task row keeps its name alone, which nothing resolves back.
 */
export type ProfileSource = Pick<LaunchTaskRequest, 'repoPath' | 'base' | 'windowEnv'>;

/** A session's compiled profile, as the launch and the fix round hand it on. */
export interface SessionCompile {
  compiled: CompiledProfile;
}

/** What an answer says to the asker, without the id the store closes the question by. */
export type AnswerWords = Omit<EventPayloads[EventType.Answer], 'questionId'>;

/**
 * How a delivered steer is recorded: what kind of steer it was, and who sent
 * it where the caller can name a sender — a typed steer is not the operator's
 * just because it was typed, and a conductor or session pup can identify is
 * named as one before its word is taken (decisions 44, 47).
 */
export type SteerRecord = {
  kind: string;
  by?: string;
};

/**
 * The two ways a steer, a kickoff included, is refused with nothing typed: the
 * paste never landed whole (decision 45), or the pane recorded at launch is
 * not there to type into (decision 46) — for a launch, a window that died
 * before its context arrived.
 */
export type RefusedSteer = SteerNotDeliveredError | SessionPaneMissingError;
