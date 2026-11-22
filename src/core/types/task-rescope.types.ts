import type { Tier } from '../../claude/enums/tier.enums.js';
import type { ScopeConflict } from './overlap.types.js';

/**
 * What a rescope did: the globs it appended, none when all were there, the
 * tier it leaves, and the live sessions of other tasks the added globs share
 * files with.
 */
export interface Rescoped {
  sessionId: string;
  added: string[];
  tier: Tier;
  raised: boolean;
  overlaps: ScopeConflict[];
}

/** The paths a glob matches, case-insensitively, as the scope-audit reads protected ones. */
export interface Reach {
  /** The glob before its first wildcard, lower-cased: every path it matches starts with it. */
  prefix: string;
  /** The one path it matches, when it has no wildcard. */
  path?: string;
  matches: (path: string) => boolean;
}

/** Why a rescope cannot rule out an open window: what the refusal names. */
export type OpenWindow =
  | { kind: 'listed'; sessionId: string; socket: string; pane: string }
  | { kind: 'unanswered'; socket: string; detail: string }
  | { kind: 'no-tmux' };

/** A rescope as the gate's PR body and the needs-you inbox show it. */
export interface TaskRescope {
  /** When it was recorded, as the store holds it. */
  at: string;
  sessionId: string;
  added: string[];
  tier: string;
  raised: boolean;
  /** What was seen of the caller (decision 115): evidence, not proof. */
  by: string;
  tty: string | null;
  tmuxPane: string | null;
}
