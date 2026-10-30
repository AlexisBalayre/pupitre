// The models and efforts pup launches `claude` on (decision 92). Every window
// pup opens and every utility call passes both `--model` and `--effort`, so the
// operator's own settings (`model`, `effortLevel`), which every session
// inherits (decision 9), never decide what a worker runs on. Nothing here is a
// Fable model or the `max` effort: pup never chooses either. An operator's
// explicit `--model`/`--effort` is honoured and recorded as an override, which
// is the only way any other value reaches a window.

const OPUS_MODEL = 'claude-opus-5-5';
const SONNET_MODEL = 'claude-sonnet-5-5';
const HAIKU_MODEL = 'claude-haiku-5-5';

/** What one `claude` runs on. */
export interface ModelRoute {
  model: string;
  effort: string;
  /** `--fallback-model`, set on the Sonnet rungs: an overloaded Sonnet hands the turn to Opus. */
  fallbackModel?: string;
}

/**
 * A task's risk class, derived from its scope-in by `tierForScope` unless the
 * operator set one with `pup plan add|edit --tier`.
 */
export type Tier = 'standard' | 'critical';

export const TIERS: readonly Tier[] = ['standard', 'critical'];

const sonnet = (effort: string): ModelRoute => ({
  model: SONNET_MODEL,
  effort,
  fallbackModel: OPUS_MODEL,
});
const opus = (effort: string): ModelRoute => ({ model: OPUS_MODEL, effort });

/**
 * Each tier's escalation ladder, cheapest first. A task starts on the first
 * rung and climbs one per relaunch or respawn that follows a failure, and per
 * CI fix round that follows one a merge ended; past the last one it goes to
 * the operator instead (decision 92).
 */
export const LADDERS: Readonly<Record<Tier, readonly ModelRoute[]>> = {
  standard: [sonnet('medium'), sonnet('high'), opus('high'), opus('xhigh')],
  critical: [opus('high'), opus('xhigh')],
};

/** `pup conductor start` without `--model`/`--effort`. */
export const CONDUCTOR_ROUTE: ModelRoute = opus('high');

/** Gate-time drafting (`runUtility`): a fixed prompt in, text out. */
export const UTILITY_ROUTE: ModelRoute = { model: HAIKU_MODEL, effort: 'low' };

/** The effort the conductor runs its security-review subagent at, over gate, git, tmux and store diffs. */
export const SECURITY_REVIEW_EFFORT = 'high';
