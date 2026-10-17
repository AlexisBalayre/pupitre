import { LADDERS, type ModelRoute, TIERS, type Tier } from '../claude/model-ladder.constants.js';
import type { SessionEvent } from './types/session-event.types.js';

/**
 * Where a change can break the gate, git, tmux, the store, the sandbox, the
 * hooks or profile compilation (decision 92). A task whose scope-in can name
 * any path one of these names is critical; every other task is standard.
 */
export const CRITICAL_AREAS: readonly string[] = [
  'src/core/merge-gate*',
  'src/core/land*',
  'src/core/regate*',
  'src/core/sandbox*',
  'src/core/profile-compiler*',
  'src/core/*.repository.ts',
  'src/core/db.client.ts',
  'src/core/migrations/**',
  'src/core/git*',
  'src/claude/**',
  '.claude/hooks/**',
  '.github/**',
];

/** The tier a scope-in implies: critical as soon as one glob touches a critical area. */
export function tierForScope(scopeIn: readonly string[]): Tier {
  const touchesCritical = (glob: string): boolean =>
    CRITICAL_AREAS.some((area) => globsIntersect(glob, area));
  return scopeIn.some(touchesCritical) ? 'critical' : 'standard';
}

/** A tier read back out of the store, or undefined for anything else. */
export function asTier(value: unknown): Tier | undefined {
  return TIERS.find((tier) => tier === value);
}

/**
 * The tier a task launches on: the one `--tier` stored, else the one its
 * scope-in implies. The spec may be read for display, so only the globs that
 * are strings count.
 */
export function taskTier(stored: string | null, scopeIn: readonly unknown[]): Tier {
  return (
    asTier(stored) ??
    tierForScope(scopeIn.filter((glob): glob is string => typeof glob === 'string'))
  );
}

type GlobToken =
  | { kind: 'char'; char: string }
  | { kind: 'one' }
  | { kind: 'star' }
  | { kind: 'globstar' }
  | { kind: 'dirs' };

/**
 * A scope glob split the way `globToRegExpSource` reads it: normalized the
 * same, and `**` + `/` taken before `**`, before `*`.
 */
function globTokens(glob: string): GlobToken[] {
  let normalized = glob.trim().replace(/^\.\//, '');
  if (normalized.endsWith('/')) normalized = `${normalized}**`;
  const marked = normalized.replaceAll('**/', '\0D').replaceAll('**', '\0G');
  const tokens: GlobToken[] = [];
  for (let at = 0; at < marked.length; at += 1) {
    const char = marked[at] as string;
    if (char === '\0') {
      at += 1;
      tokens.push({ kind: marked[at] === 'D' ? 'dirs' : 'globstar' });
    } else if (char === '*') tokens.push({ kind: 'star' });
    else if (char === '?') tokens.push({ kind: 'one' });
    else tokens.push({ kind: 'char', char });
  }
  return tokens;
}

interface GlobAutomaton {
  /** Per state, the moves that read one character. */
  moves: { to: number; reads: (char: string) => boolean }[][];
  /** Per state, the moves that read nothing. */
  skips: number[][];
  accept: number;
  /** Every literal character, which with `/` and one other is all an intersection has to try. */
  chars: string[];
}

const notSlash = (char: string): boolean => char !== '/';

/** A glob as a nondeterministic automaton: one state before each token, `accept` after the last. */
function globAutomaton(glob: string): GlobAutomaton {
  const tokens = globTokens(glob);
  const moves: GlobAutomaton['moves'] = tokens.map(() => []);
  const skips: number[][] = tokens.map(() => []);
  moves.push([]);
  skips.push([]);
  const chars: string[] = [];
  tokens.forEach((token, at) => {
    const next = at + 1;
    if (token.kind === 'char') {
      chars.push(token.char);
      moves[at]?.push({ to: next, reads: (char) => char === token.char });
    } else if (token.kind === 'one') {
      moves[at]?.push({ to: next, reads: notSlash });
    } else if (token.kind === 'star' || token.kind === 'globstar') {
      skips[at]?.push(next);
      moves[at]?.push({ to: at, reads: token.kind === 'star' ? notSlash : () => true });
    } else {
      // `**/` is any run of whole segments, each one or more non-`/` and a `/`.
      const inSegment = moves.push([]) - 1;
      skips.push([]);
      skips[at]?.push(next);
      moves[at]?.push({ to: inSegment, reads: notSlash });
      moves[inSegment]?.push({ to: inSegment, reads: notSlash });
      moves[inSegment]?.push({ to: at, reads: (char) => char === '/' });
    }
  });
  return { moves, skips, accept: tokens.length, chars };
}

/**
 * Whether some path matches both globs: the two automata run in step, and one
 * pair of states reaching both accepts is a path they share. Trying `/`, every
 * literal and one other character is trying every class of character either
 * glob tells apart.
 */
export function globsIntersect(left: string, right: string): boolean {
  const a = globAutomaton(left);
  const b = globAutomaton(right);
  const alphabet = new Set(['/', 'a', ...a.chars, ...b.chars]);
  const seen = new Set<string>();
  const pending: [number, number][] = [[0, 0]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [x, y] = pair;
    const key = `${x}:${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (x === a.accept && y === b.accept) return true;
    for (const to of a.skips[x] ?? []) pending.push([to, y]);
    for (const to of b.skips[y] ?? []) pending.push([x, to]);
    for (const char of alphabet) {
      for (const moveA of a.moves[x] ?? []) {
        if (!moveA.reads(char)) continue;
        for (const moveB of b.moves[y] ?? []) {
          if (moveB.reads(char)) pending.push([moveA.to, moveB.to]);
        }
      }
    }
  }
  return false;
}

/** What a window ran into that climbs its task one rung at the next relaunch or respawn (decision 92). */
export type ClimbReason = 'gate-rejection' | 'ci-fix-round' | 'turn-death' | 'stall';

function failureOf(event: SessionEvent): ClimbReason | undefined {
  if (event.type === 'turn_died') return 'turn-death';
  if (event.type !== 'gate_result') return undefined;
  if (event.to === 'rejected') return 'gate-rejection';
  // A re-gate is logged as a transition from `merged` onto `merged`: the CI
  // fix round it measured (decision 86).
  return event.from === 'merged' && event.to === 'merged' ? 'ci-fix-round' : undefined;
}

/**
 * What the session's current window ran into, from its events oldest first:
 * only those since the window opened count, which is the launch or the newest
 * `respawn`, since a failure before it was already answered by that respawn.
 * The first failure wins, and a window that was stalled when it ended, which
 * no event records, ran into a stall after everything its events name. A
 * block wins over all of them: a task the gate parked is the operator's, and
 * never climbs.
 */
export function windowFailure(
  events: readonly SessionEvent[],
  stalledAtEnd = false,
): ClimbReason | 'blocked' | undefined {
  let failure: ClimbReason | 'blocked' | undefined;
  for (const event of events) {
    if (event.type === 'other' && event.eventType === 'respawn') failure = undefined;
    else if (event.type === 'gate_result' && event.to === 'blocked') failure = 'blocked';
    else if (failure !== 'blocked') failure ??= failureOf(event);
  }
  return failure ?? (stalledAtEnd ? 'stall' : undefined);
}

/**
 * The rung a relaunched or respawned window runs on: one above `rung` after a
 * failure, the same rung otherwise. A failure on the top rung climbs nowhere
 * and is handed back as `topReached`, for the operator. `rung` is read from
 * the store, so one outside the ladder is clamped into it.
 */
export function nextRung(
  tier: Tier,
  rung: number,
  failure: ClimbReason | 'blocked' | undefined,
): { rung: number; reason?: ClimbReason } | { topReached: ClimbReason } {
  const top = LADDERS[tier].length - 1;
  const at = Number.isSafeInteger(rung) ? Math.min(Math.max(rung, 0), top) : 0;
  if (failure === undefined || failure === 'blocked') return { rung: at };
  return at < top ? { rung: at + 1, reason: failure } : { topReached: failure };
}

/** Where a task's next window stands on its ladder, as `climbFrom` reads it. */
interface Climb {
  rung: number;
  /** Why the rung last climbed, kept from the window before when this one does not climb. */
  reason?: string;
  /** Set when the window before failed on the top rung: `rung` is the top, and nothing is left to climb. */
  topReached?: ClimbReason;
}

/**
 * The rung a task's next window runs on, a relaunch's or a respawn's, from the
 * window before it and what that window ran into. The bottom of the ladder
 * when there was none, it was launched before routing, or it ran on another
 * tier, since a re-tiered task starts its new ladder from the bottom.
 */
export function climbFrom(
  tier: Tier,
  previous: { tier: string | null; rung: number | null; rung_reason: string | null } | undefined,
  failure: ClimbReason | 'blocked' | undefined,
): Climb {
  if (!previous || asTier(previous.tier) !== tier || previous.rung === null) return { rung: 0 };
  const kept = previous.rung_reason ?? undefined;
  const step = nextRung(tier, previous.rung, failure);
  if ('topReached' in step) {
    return { rung: LADDERS[tier].length - 1, reason: kept, topReached: step.topReached };
  }
  return { rung: step.rung, reason: step.reason ?? kept };
}

/**
 * What a window on `rung` of `tier`'s ladder runs on, with the operator's
 * explicit `--model` and `--effort` over the rung's. The rung's fallback rides
 * only on the rung's own model: it is Opus behind an overloaded Sonnet, not
 * behind whatever model the operator named instead.
 */
export function routeFor(
  tier: Tier,
  rung: number,
  override: { model?: string; effort?: string } = {},
): ModelRoute {
  const ladder = LADDERS[tier];
  const routed = ladder[Math.min(Math.max(rung, 0), ladder.length - 1)] as ModelRoute;
  const model = override.model ?? routed.model;
  return {
    model,
    effort: override.effort ?? routed.effort,
    ...(model === routed.model && routed.fallbackModel
      ? { fallbackModel: routed.fallbackModel }
      : {}),
  };
}
