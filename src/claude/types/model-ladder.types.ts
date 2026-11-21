/** What one `claude` runs on. */
export interface ModelRoute {
  model: string;
  effort: string;
  /** `--fallback-model`, set on the Sonnet rungs: an overloaded Sonnet hands the turn to Opus. */
  fallbackModel?: string;
}
