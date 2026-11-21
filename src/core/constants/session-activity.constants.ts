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
