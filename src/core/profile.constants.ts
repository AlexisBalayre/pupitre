import { WORKER_SUBAGENT_ROUTE } from '../claude/model-ladder.constants.js';

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

/**
 * Every compiled settings file's `env`, the conductor's too (decision 107). The
 * settings file is the one route: `tmuxEnv` strips `CLAUDE*` from what a window
 * inherits (decision 47). Each names a part of the startup context no window
 * pup opens uses: the Artifact and Workflow tools' definitions, and the
 * suggested next prompt Claude Code generates after every turn.
 */
export const SLIM_CONTEXT_ENV = {
  CLAUDE_CODE_DISABLE_ARTIFACT: '1',
  CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
};

/**
 * Added to a worker's settings `env`, never the conductor's (decision 152). The
 * built-in Explore agent inherits the window's model, which outranks
 * `CLAUDE_CODE_SUBAGENT_MODEL`. Only `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` makes
 * the pin win, and it also removes the Agent tool's `model` parameter. It pins
 * every subagent a worker spawns. The conductor's security review needs Opus,
 * so the conductor never gets it. A value `pup init --session-env` hands the
 * window for one of these names is ignored: Claude Code applies the settings
 * file's `env` over the window's inherited environment, so the pin wins.
 */
export const WORKER_SUBAGENT_ENV = {
  CLAUDE_CODE_SUBAGENT_MODEL: WORKER_SUBAGENT_ROUTE.model,
  CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
  CLAUDE_CODE_SUBAGENT_EFFORT: WORKER_SUBAGENT_ROUTE.effort,
};
