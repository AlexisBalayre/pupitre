/** Default hard cap for a compiled context when no layer sets contextBudget (docs/03-profiles.md). */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 6000;

/** Rough token estimation — chars per token; refined later if it proves too coarse. */
export const CHARS_PER_TOKEN = 4;

export const HOOK_TIMEOUT_SECONDS = 5;
export const EVENT_HOOK_TIMEOUT_SECONDS = 10;

/**
 * Past this many dirty paths the Bash re-check refuses rather than read them all:
 * it forks per path, twice per call, under a hook timeout that fails open (decision 63).
 */
export const RECHECK_MAX_DIRTY_PATHS = 200;
/** A file larger than this is fingerprinted by its size, not read whole (decision 63). */
export const RECHECK_HASH_MAX_BYTES = 64 * 1024 * 1024;
