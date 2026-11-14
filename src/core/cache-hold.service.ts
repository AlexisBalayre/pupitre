import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { Database } from 'better-sqlite3';

import { pasteIntoPane, readInputBox, submitPane } from '../claude/session-runtime.service.js';
import { SESSION_ID_PATTERN } from './paths.constants.js';
import { projectPaths } from './paths.utils.js';
import { toIsoUtc } from './report-data.utils.js';
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
 * The cache hold (decision 179): what keeps a worker that waits on someone
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
 * A cost control, not a boundary: the session can record other events itself.
 */
export const CACHE_HOLD_LIMIT = 8;

/**
 * The most of an events file a hold reads, from its end. The classifier walks
 * newest first and needs only the turn that ended, while a long session's file
 * runs to tens of megabytes. A turn longer than this reads as ended unless the
 * part of it read launched a background shell.
 */
export const CACHE_HOLD_EVENTS_TAIL_BYTES = 1 << 20;

/**
 * The events that give a session's window a prompt. A steer covers an answer,
 * an interrupt's message, a peer's message, a kickoff and the watchdog's
 * resume, all recorded as steers; a respawn's kickoff is recorded as the
 * respawn.
 */
const PROMPT_EVENTS: ReadonlySet<string> = new Set(['steer', 'respawn', 'cache_hold']);

/**
 * Hold every worker window that is waiting on someone else and whose cache is
 * about to lapse: `awaiting-review` (the gate or a review answers it), and
 * `running` with a question nobody has answered (decision 76). A running
 * worker with no open question is not waiting on anyone pup can name, so it
 * is left to the stall rule. A `blocked` worker is never held: a hold is a
 * turn, kept from tools by its wording alone, and a parked session is to take
 * no turn until a human unblocks it.
 *
 * Only a turn the hooks show ended, with no prompt recorded since, is held,
 * and only into an empty input box: a draft in the box is the operator's, and
 * a hold must never clear it. Each hold is recorded as a `cache_hold` event,
 * never a `steer`, so it neither answers an open question nor shows as the
 * window's last steer. Best effort: a window that refuses the paste is tried
 * again on the next sweep while the hold window lasts, and a hold still in the
 * box after its second Enter is not recorded, so the next sweep holds the
 * window once its box is empty again. Returns the ids held, for a test to read.
 */
export function holdIdleCaches(db: Database, repoPath: string, now: number): string[] {
  const paths = projectPaths(repoPath);
  const held: string[] = [];
  for (const row of listSessions(db, ['awaiting-review', 'running'])) {
    if (!SESSION_ID_PATTERN.test(row.id)) continue;
    try {
      const due = holdDue(db, row, paths.eventsFile(row.id), now);
      if (due === undefined || !typeHold(row)) continue;
      appendEvent(db, row.id, 'cache_hold', {
        idleMs: Math.round(due.idleMs),
        eventsBytes: due.eventsBytes,
      });
      held.push(row.id);
    } catch {
      // The events file and the pane are the session's to break: a file gone
      // or replaced, a pane tmux cannot reach, or a store write refused skips
      // this window's hold, never the sweep's other holds, resumes and nudge.
      // A hold typed but left unrecorded is typed again by the next sweep if
      // its turn has not moved the events file by then: a duplicate queued
      // behind the first, the cost the watchdog's resume accepts for the same
      // gap.
    }
  }
  return held;
}

/**
 * How long the session's events file has been quiet, and its size, where the
 * hold's turn starts writing, when its window is due a hold. The file is the
 * session's to write, so it is opened as one it may have replaced: no link
 * followed and no fifo blocked on, a regular file only, its mtime read off the
 * descriptor opened, and only its tail read. Throws when it cannot be opened,
 * as a link cannot.
 */
function holdDue(
  db: Database,
  row: SessionRow,
  eventsFile: string,
  now: number,
): { idleMs: number; eventsBytes: number } | undefined {
  const fd = openSync(eventsFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const idleMs = now - stat.mtimeMs;
    if (idleMs < CACHE_HOLD_AFTER_MS || idleMs >= CACHE_HOLD_UNTIL_MS) return undefined;
    const events = listEvents(db, row.id).reverse();
    if (row.state === 'running' && openQuestion(db, row.id) === undefined) return undefined;
    // No hook fires on a submitted prompt, so a turn a prompt started moves the
    // file only at its first tool or its end. Prompted since the file last
    // moved, the window is at work or its turn died, and the tail cannot say
    // which. `created_at` keeps whole seconds, so a prompt inside the file's
    // last second counts as after it.
    const prompt = lastPrompt(events);
    if (prompt && Date.parse(toIsoUtc(prompt.created_at)) >= Math.floor(stat.mtimeMs / 1000) * 1000)
      return undefined;
    if (trailingHolds(events) >= CACHE_HOLD_LIMIT) return undefined;
    return classifySessionActivity(readTail(fd, stat.size)).kind === 'idle'
      ? { idleMs, eventsBytes: stat.size }
      : undefined;
  } finally {
    closeSync(fd);
  }
}

/** The file's last `CACHE_HOLD_EVENTS_TAIL_BYTES` at most, less the line the cut tore. */
function readTail(fd: number, size: number): string {
  const start = Math.max(0, size - CACHE_HOLD_EVENTS_TAIL_BYTES);
  const text = readRange(fd, start, size);
  if (start === 0) return text;
  const torn = text.indexOf('\n');
  return torn === -1 ? '' : text.slice(torn + 1);
}

/** The file's bytes from `start` up to `end`, as far as they can be read. */
function readRange(fd: number, start: number, end: number): string {
  const buffer = Buffer.alloc(end - start);
  let length = 0;
  for (let read = -1; read !== 0 && length < buffer.length; length += read) {
    read = readSync(fd, buffer, length, buffer.length - length, start + length);
  }
  return buffer.toString('utf8', 0, length);
}

/**
 * Whether the window's turn is still the one `hold` started: no Stop in the
 * events file past the size it had when the hold was typed. A dead turn fires
 * no Stop, but Claude Code still sends its idle prompt a minute later, so the
 * file's mtime cannot tell a hold's dead turn from one that ended (decision
 * 179). Read like the hold reads the file, as one the session may have
 * replaced. False whenever the file cannot say: it cannot be opened, is no
 * regular file, is shorter than at the hold, or has more past the hold than
 * `CACHE_HOLD_EVENTS_TAIL_BYTES`, which no turn that ran no tool writes.
 */
export function isHoldTurnOpen(eventsFile: string, hold: EventRow): boolean {
  const from = holdEventsBytes(hold);
  if (from === undefined) return false;
  let fd: number;
  try {
    fd = openSync(eventsFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < from || stat.size - from > CACHE_HOLD_EVENTS_TAIL_BYTES)
      return false;
    return !readRange(fd, from, stat.size).split('\n').some(isStopLine);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** The events file's size a hold recorded, when its payload holds one. */
function holdEventsBytes(hold: EventRow): number | undefined {
  try {
    const { eventsBytes } = JSON.parse(hold.payload) as { eventsBytes?: unknown };
    return Number.isSafeInteger(eventsBytes) && (eventsBytes as number) >= 0
      ? (eventsBytes as number)
      : undefined;
  } catch {
    return undefined;
  }
}

function isStopLine(line: string): boolean {
  try {
    const event: unknown = JSON.parse(line);
    return (
      typeof event === 'object' &&
      event !== null &&
      (event as { hook_event_name?: unknown }).hook_event_name === 'Stop'
    );
  } catch {
    return false;
  }
}

/** The newest event that gave the session's window a prompt, from its events newest first. */
export function lastPrompt(newestFirst: EventRow[]): EventRow | undefined {
  return newestFirst.find((event) => PROMPT_EVENTS.has(event.type));
}

/** The holds since anything else was recorded for the session, newest first. */
function trailingHolds(newestFirst: EventRow[]): number {
  const other = newestFirst.findIndex((event) => event.type !== 'cache_hold');
  return other === -1 ? newestFirst.length : other;
}

/**
 * Type the hold into an empty box and submit it; false, with nothing typed,
 * when the box is absent or holds text, and with the box cleared when the
 * paste never landed whole (decision 45). Enter can land while the UI still
 * folds the paste, so a box that holds text after it gets one Enter more, as a
 * tell's does (decision 85), and one that holds it still is false: the hold
 * never ran, and recording it would refuse every later hold of the window.
 * Enter is never pressed into a box gone from the screen, where it picks a
 * dialog's option.
 */
function typeHold(row: SessionRow): boolean {
  const pane = sessionPane(row);
  if (readInputBox(pane) !== 'empty' || !pasteIntoPane(pane, CACHE_HOLD_MESSAGE)) return false;
  submitPane(pane);
  if (readInputBox(pane) !== 'holds') return true;
  submitPane(pane);
  return readInputBox(pane) !== 'holds';
}
