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
