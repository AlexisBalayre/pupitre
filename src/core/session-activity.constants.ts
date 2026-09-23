/**
 * A running session with no new hook event in this long is presumed stalled —
 * wedged on a transient error or a hung process — rather than just between
 * turns. Observed live: a transient API network error left a session dead at
 * its prompt for an hour while `pup status` still read RUNNING, and it was
 * only caught by reading the tmux pane by hand (decision 35). Set well above
 * the gap a permission ask or an ordinary turn boundary produces, so those
 * don't false-positive.
 */
export const STALLED_AFTER_MS = 10 * 60 * 1000;

/**
 * What a session id may look like before anything joins it into a path. Ids
 * are pup-minted (`sessionSlug`), but every reader gets them back out of a
 * store the sessions themselves can write, and since the fleet views
 * (decisions 60-62) the operator reads *every* registered project's store — so
 * an id is untrusted text, and a `../` in one is a read outside the project
 * directory. A closed allowlist rather than a `..` check: separators and dots
 * are not in it at all, so no combination of them composes into an escape
 * (decision 66, the rule decision 51 already gave dossier file names and the
 * bash-recheck hook gives `tool_use_id`).
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
