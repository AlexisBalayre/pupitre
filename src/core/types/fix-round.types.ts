import type { SessionEvent } from './session-event.types.js';
import type { FindingClass, ProfileSource, RouteOverride } from './session-lifecycle.types.js';

export type SessionDone = Extract<SessionEvent, { type: 'session_done' }>;

export interface FixRoundRequest extends ProfileSource {
  sessionId: string;
  /** `--model`/`--effort` over the climbed rung's (decision 92). */
  override?: RouteOverride;
  /** Who ran `pup fix`, recorded on the round; only the operator's override lifts a top-rung refusal. */
  overrideVia: 'operator' | 'conductor';
  /**
   * `--finding`: the conductor's word that an open thread is a security hole
   * or a wrong result, which runs a round refused at the top rung there again
   * (decision 202). Refused on any other round, from any other caller and
   * beside an override.
   */
  finding?: FindingClass;
  /** Where the store's per-session files live; `~/.pupitre` unless a test moves them. */
  pathsBase?: string;
  /** Wait for a merge lock a live run holds, as `pup fix` does, rather than refuse (decision 88). */
  wait?: boolean;
}

export interface FixRoundOutcome {
  prUrl: string;
  head: string;
  threads: number;
}

/** How the replies a gated fix round posted left its threads (decision 90). */
export interface ThreadAnswers {
  prUrl: string;
  sha: string;
  /** Replied `Addressed in <sha>` and resolved. */
  addressed: number;
  /** Answered fixed, but pup cannot show the round changed its file's content: left open. */
  unverified: number;
  /** Replied with the worker's reason and left open for the operator. */
  declined: number;
  /** Named in the round but answered nowhere in the worker's summary: left open. */
  unanswered: number;
  /**
   * Replied on, by a comment a round relays, after the kickoff read it, on a
   * file the round's push left as it was: the worker never saw that reply, so
   * nothing is posted or resolved, and the next round takes the thread with it.
   */
  repliedSince: number;
  /**
   * Replied on so too, but on a file the push changed, or one git could not
   * tell: GitHub may outdate the thread, and no round takes an outdated one,
   * so the worker's answer is posted, saying the reply never reached it, and
   * nothing is resolved, for the operator to read the reply.
   */
  unrelayed: number;
}

export type ThreadVerdict = Exclude<
  keyof ThreadAnswers,
  'prUrl' | 'sha' | 'repliedSince' | 'unrelayed'
>;

/** One thread's answer in the worker's `pup session done` summary. */
export interface WorkerAnswer {
  verdict: 'fixed' | 'declined';
  reason: string;
}

/** The PR a merged session's newest merge opened, as the store and origin vouch for it. */
export interface StoredPullRequest {
  prUrl: string;
  /** The sha the gate pinned, the one the PR vouches for (decision 82). */
  pinned: string;
  /** Origin's `host/owner/name`, which every gh call is pinned to. */
  repo: string;
}
