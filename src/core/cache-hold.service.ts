import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Database } from 'better-sqlite3';

import {
  pasteIntoPane,
  readInputBox,
  SessionPaneMissingError,
  submitPane,
} from '../claude/session-runtime.service.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { projectPaths } from './paths.utils.js';
import {
  appendEvent,
  type EventRow,
  listEvents,
  listSessions,
  openQuestion,
  type SessionRow,
} from './session.repository.js';
import { classifySessionActivity } from './session-activity.utils.js';
import { sessionPane } from './session-lifecycle.service.js';

/**
 * The cache hold (decision 180): what keeps a worker that waits on someone
 * else from paying its whole context again when the wait passes the hour.
 *
 * A worker's prompt cache lives an hour from its last request. The retro of
 * 2026-11-09 counted 93 worker requests that came after a longer idle and
 * wrote the whole context back at the write price, about 84 USD in a week.
 * Most followed `pup session done` or `pup session ask`: a window that is
 * certain to be woken (a gate refusal, a review, an answer) and not when. A
 * one-word turn before the hour is out reads the cache at a tenth of the input
 * price and starts its hour again, against twice that price to write it back.
 */

/** What the watcher types into a held window: nothing the worker could take as work or an answer. */
export const CACHE_HOLD_MESSAGE =
  'pup cache hold: nothing has changed and this is not an answer to anything you asked. Run no ' +
  'tool; reply with the single word held and end your turn.';

/**
 * The quiet a worker's events file must reach before a hold. The file's mtime
 * trails the last request by the idle prompt Claude Code sends a minute after
 * a turn ends, so the hold comes within the cache's hour with room for a slow
 * sweep and a paste.
 */
export const CACHE_HOLD_AFTER_MS = 50 * 60 * 1000;

/** Past this the cache may have gone, and a hold would pay the write it exists to avoid. */
export const CACHE_HOLD_UNTIL_MS = 58 * 60 * 1000;

/**
 * Holds in a row before a window is left to lapse. Each reads the context at a
 * tenth of the input price and a re-write costs twice it, so eight cost under
 * half of the one re-write a never-woken window would have avoided: a working
 * day held, then a window left overnight pays the write once, when it wakes.
 */
export const CACHE_HOLD_LIMIT = 8;

/**
 * Hold every worker window that is waiting on someone else and whose cache is
 * about to lapse: `awaiting-review` (the gate or a review answers it),
 * `blocked` (the operator's unblock does), and `running` with a question
 * nobody has answered (decision 76). A running worker with no open question
 * is not waiting on anyone pup can name, so it is left to the stall rule.
 *
 * Only a turn that has ended is held, and only into an empty input box: a
 * draft in the box is the operator's, and a hold must never clear it. Each
 * hold is recorded as a `cache_hold` event, never a `steer`, so it neither
 * answers an open question nor shows as the window's last steer. Best effort:
 * a window that refuses the paste is tried again on the next sweep while the
 * hold window lasts. Returns the ids held, for a test to read.
 */
export function holdIdleCaches(db: Database, repoPath: string, now: number): string[] {
  const paths = projectPaths(repoPath);
  const held: string[] = [];
  for (const row of listSessions(db, ['awaiting-review', 'blocked', 'running'])) {
    if (!SESSION_ID_PATTERN.test(row.id)) continue;
    const eventsFile = paths.eventsFile(row.id);
    if (!existsSync(eventsFile)) continue;
    const idleMs = now - statSync(eventsFile).mtimeMs;
    if (idleMs < CACHE_HOLD_AFTER_MS || idleMs >= CACHE_HOLD_UNTIL_MS) continue;
    const events = listEvents(db, row.id).reverse();
    if (row.state === 'running' && openQuestion(db, row.id) === undefined) continue;
    if (trailingHolds(events) >= CACHE_HOLD_LIMIT) continue;
    if (classifySessionActivity(readFileSync(eventsFile, 'utf8')).kind !== 'idle') continue;
    if (!typeHold(row)) continue;
    appendEvent(db, row.id, 'cache_hold', { idleMs: Math.round(idleMs) });
    held.push(row.id);
  }
  return held;
}

/** The holds since anything else was recorded for the session, newest first. */
function trailingHolds(newestFirst: EventRow[]): number {
  const other = newestFirst.findIndex((event) => event.type !== 'cache_hold');
  return other === -1 ? newestFirst.length : other;
}

/**
 * Type the hold into an empty box and submit it; false, with nothing typed,
 * when the box is absent or holds text, and with the box cleared when the
 * paste never landed whole (decision 45). A window never recorded or gone
 * since its launch is nothing to hold.
 */
function typeHold(row: SessionRow): boolean {
  try {
    const pane = sessionPane(row);
    if (readInputBox(pane) !== 'empty' || !pasteIntoPane(pane, CACHE_HOLD_MESSAGE)) return false;
    submitPane(pane);
    return true;
  } catch (error) {
    if (error instanceof SessionPaneMissingError) return false;
    throw error;
  }
}
