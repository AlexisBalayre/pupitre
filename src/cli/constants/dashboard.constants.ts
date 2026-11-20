import type { SessionState } from '../../core/db.client.js';

/**
 * How often `pup ui` rebuilds the snapshot. Two seconds because of what it
 * watches: hook events land every few seconds at most, and the operator reads
 * this screen rather than watching it tick. It is also the idle cost — one
 * rebuild is a handful of SELECTs plus a `statSync` and a transcript read per
 * running session — so the number is a budget, not a taste.
 */
export const SNAPSHOT_REFRESH_MS = 2_000;

/**
 * The state column's colour. Red is "stopped, needs a person", yellow "a person
 * is next in line", green "it moved"; a state the operator cannot act on keeps
 * the terminal's own foreground rather than spending a colour on history.
 */
export const STATE_COLOURS: Record<SessionState, string | undefined> = {
  queued: 'cyan',
  running: 'green',
  'awaiting-review': 'yellow',
  merged: 'gray',
  killed: 'gray',
  rejected: 'red',
  blocked: 'red',
};

/**
 * The two fixed columns every row starts with, at the widths `pup status`
 * already pads them to: wide enough for the longest state (`awaiting-review`)
 * and for a session id, which is a 24-character task stem plus a collision
 * suffix. Fixed rather than measured because the point of the left edge is that
 * the eye finds the state and the id in the same place on every row.
 */
export const STATE_COLUMN_CHARS = 16;
export const ID_COLUMN_CHARS = 28;

/**
 * The project column `pup ui --all` puts before the state (decision 61): a
 * project id is twelve hex characters, the name `--project` takes and the
 * fleet header prints beside each repo, plus the two-space gutter. The id
 * rather than the repo's directory name, which two checkouts can share.
 */
export const PROJECT_COLUMN_CHARS = 14;

/**
 * How often `R` asks whether the session has written its handoff yet. The same
 * cadence `pup respawn` polls at, for the same reason: the answer is a file the
 * session writes at the end of a turn, and a turn is minutes long. The
 * dashboard's own poll exists because the CLI's sleeps the thread, which on a
 * screen would stop the clock and swallow every key for as long as the wait.
 */
export const HANDOFF_POLL_MS = 5_000;

/**
 * How many lines of a merge child's output the log pane keeps. The gate prints
 * roughly a line per stage and this pane shares a screen with the fleet it was
 * opened from; the tail is the part that says where the gate stopped.
 */
export const MERGE_LOG_LINES = 12;
