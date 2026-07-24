/** Shelled-out debt capabilities get the same budget as gate commands. */
export const DEBT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Node's 1 MiB default would SIGTERM a chatty tool and silently degrade the
 * stage to "not measured" — a session could induce that to dodge the ratchet.
 */
export const DEBT_COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Vulture's "dead code found" exit status — the report we want, not a failure. */
export const VULTURE_DEAD_CODE_EXIT = 3;
