import { existsSync, statSync } from 'node:fs';
import type { Database } from 'better-sqlite3';

import { sanitizeReason } from '../adapters/capability.utils.js';
import {
  conductorPane,
  deadTurnError,
  SessionPaneMissingError,
  SteerNotDeliveredError,
  steerPane,
} from '../claude/session-runtime.service.js';
import { findStalledSessions } from './dashboard.service.js';
import { projectId, projectPaths } from './paths.utils.js';
import { parseJsonOr, toIsoUtc } from './report-data.utils.js';
import { appendEvent, getSession, listEvents, type SessionRow } from './session.repository.js';
import { STALLED_AFTER_MS } from './session-activity.constants.js';
import { sessionPane, steerSession } from './session-lifecycle.service.js';

/**
 * The turn watchdog: what stands between a sleeping laptop and a fleet that
 * needs the operator (addendum to decision 35).
 *
 * Twice on 2026-09-13 — a machine asleep at 01:16, a DNS outage at 13:00 — a
 * running session's turn ended on `API Error: Connection lost while your
 * computer was asleep`. That is not a turn end: no Stop hook fires, so the
 * events file stops dead, `pup status` reads STALLED for hours, and the
 * session sits at an empty prompt with its edits still in the worktree. The
 * conductor's own waiting turn died the same way both times, so nobody
 * resumed the worker until the operator typed into its window by hand.
 *
 * So the radar's sweep, which already asks which sessions are stalled, now
 * asks the one further question a human was asking: is this pane showing a
 * dead turn? The pane is read for that and nothing else — session state is
 * still hooks and transcripts (decision 2). What the store keeps is the
 * `turn_died` event and the resume steer; the pane is the evidence.
 */

/** What the watcher types into a session whose turn died. */
export const RESUME_MESSAGE =
  'Your last turn ended with an API error; your edits are still in the worktree. Continue the ' +
  'task from where you stopped and run pup session done when the acceptance criteria are met.';

/**
 * What it types into the conductor's window. Deliberately not a resume: the
 * conductor was not doing the work, it was waiting on sessions, so what it
 * needs is to look again — and `pup status` now says which turns died
 * (decision 47).
 */
export const CONDUCTOR_NUDGE =
  'Operator watchdog: your turn died with an API error; read pup status and resume any session ' +
  'that needs it';

/** The conductor's stand-in id in a sweep's result: it has no session row to name. */
export const CONDUCTOR_TARGET = 'conductor';

/** One dead turn the sweep acted on. */
export interface ResumedTurn {
  /** The session resumed, or `conductor` for the operator's delegate. */
  id: string;
  /** The pane's own error line, sanitized for the terminal (decision 29). */
  reason: string;
  /** Why nothing was typed, when the steer was refused; the resume then needs a human. */
  refusal?: string;
}

/** A `turn_died` event as its readers want it. */
export interface DeadTurn {
  reason: string;
  /** When the watcher recorded it. */
  at: Date;
  refusal?: string;
}

/**
 * One watchdog pass over the fleet: every running session the stall rule
 * (decision 35) has flagged is checked against its launch pane, and each one
 * showing a dead turn is recorded and steered back to work. The conductor's
 * window is checked last, so the nudge reaches it after the sessions it will
 * be asked about have been resumed.
 *
 * Returns what it acted on, one entry per pane, for `pup watch` to print.
 */
export function sweepDeadTurns(db: Database, repoPath: string, now: number): ResumedTurn[] {
  const resumed: ResumedTurn[] = [];
  for (const stalled of findStalledSessions(db, repoPath, now)) {
    const entry = resumeSession(db, repoPath, stalled.id);
    if (entry) resumed.push(entry);
  }
  const nudged = nudgeConductor(db, repoPath, now);
  if (nudged) resumed.push(nudged);
  return resumed;
}

/**
 * The dead turn recorded for the stall a session is in right now, or
 * undefined — no stall, or a stall nothing has been recorded against. What
 * `pup status` prints its row from: the stamp is what keeps an hour-old
 * resume off the row of a session that has stalled again since.
 */
export function lastDeadTurn(
  db: Database,
  repoPath: string,
  sessionId: string,
): DeadTurn | undefined {
  const stalledAt = stallStamp(projectPaths(repoPath).eventsFile(sessionId));
  if (stalledAt === undefined) return undefined;
  const event = deadTurnEvents(db, sessionId).find((recorded) => recorded.stalledAt === stalledAt);
  return (
    event && {
      reason: event.reason,
      at: event.at,
      ...(event.refusal ? { refusal: event.refusal } : {}),
    }
  );
}

/**
 * Resume one stalled session, or leave it alone. Everything this reads from
 * the pane is a question about recovery: is there a pane to read, is the turn
 * dead, has this stall already been answered.
 */
function resumeSession(db: Database, repoPath: string, sessionId: string): ResumedTurn | undefined {
  const row = getSession(db, sessionId);
  const stalledAt = stallStamp(projectPaths(repoPath).eventsFile(sessionId));
  // The stall was read off that same file a moment ago, so both are here
  // unless the session was killed or cleaned up mid-sweep.
  if (!row || stalledAt === undefined) return undefined;
  if (deadTurnEvents(db, sessionId).some((event) => event.stalledAt === stalledAt))
    return undefined;
  const reason = readDeadTurn(row);
  if (reason === undefined) return undefined;
  let refusal: string | undefined;
  try {
    steerSession(db, sessionId, RESUME_MESSAGE);
  } catch (error) {
    if (!isRefusedSteer(error)) throw error;
    refusal = sanitizeReason(error.message);
  }
  // One event per stall, written once the outcome is known, so a refusal is on
  // record beside what caused it rather than in a second event. The window it
  // leaves open — a watcher killed between the steer and this write — costs a
  // duplicate resume message on the next sweep, which lands in an empty box
  // behind the first and is read as a follow-up; a refusal nobody recorded
  // would cost a steer every fifteen seconds for as long as the outage lasts.
  appendEvent(db, sessionId, 'turn_died', {
    reason,
    stalledAt,
    ...(refusal ? { refusal } : {}),
  });
  if (!refusal) appendEvent(db, sessionId, 'steer', { kind: 'resume', by: 'watch' });
  return { id: sessionId, reason, ...(refusal ? { refusal } : {}) };
}

/**
 * Nudge the conductor when its own turn died. Its window is on its own socket
 * and has no session row, no events file and no stall age (decision 47), so
 * the pane is the whole reading — and the nudge is what changes it, since a
 * submitted prompt puts the transcript's last line past the error.
 *
 * That leaves one hole the pane cannot close: an outage long enough to kill
 * the nudged turn too, which would have the watcher typing every sweep for as
 * long as the network is down. The event log closes it. The conductor has no
 * row, so the event is filed against no session — the one thing in the store
 * that is a project's rather than a session's — and a nudge is not repeated
 * within the stall window every other recovery here is measured in.
 */
function nudgeConductor(db: Database, repoPath: string, now: number): ResumedTurn | undefined {
  const pane = conductorPane(projectId(repoPath));
  if (!pane || nudgedRecently(db, now)) return undefined;
  let reason: string | undefined;
  try {
    reason = deadTurnError(pane);
    if (reason === undefined) return undefined;
    reason = sanitizeReason(reason);
    steerPane(pane, CONDUCTOR_NUDGE);
  } catch (error) {
    if (!isRefusedSteer(error)) throw error;
    // A refused read leaves nothing to record: there is no evidence the turn
    // died, only that the window could not be read.
    if (reason === undefined) return undefined;
    const refusal = sanitizeReason(error.message);
    appendEvent(db, null, 'turn_died', { target: CONDUCTOR_TARGET, reason, refusal });
    return { id: CONDUCTOR_TARGET, reason, refusal };
  }
  appendEvent(db, null, 'turn_died', { target: CONDUCTOR_TARGET, reason });
  return { id: CONDUCTOR_TARGET, reason };
}

/** Whether the conductor has already been nudged inside the current stall window. */
function nudgedRecently(db: Database, now: number): boolean {
  const row = db
    .prepare(
      `SELECT created_at FROM events
       WHERE session_id IS NULL AND type = 'turn_died' ORDER BY id DESC LIMIT 1`,
    )
    .get() as { created_at: string } | undefined;
  return row !== undefined && now - Date.parse(toIsoUtc(row.created_at)) < STALLED_AFTER_MS;
}

/**
 * The pane's account of a dead turn, sanitized, or undefined when there is
 * nothing to recover: no pane recorded at launch, a window already gone, or a
 * turn that ended some other way.
 */
function readDeadTurn(row: SessionRow): string | undefined {
  try {
    const line = deadTurnError(sessionPane(row));
    return line === undefined ? undefined : sanitizeReason(line);
  } catch (error) {
    if (error instanceof SessionPaneMissingError) return undefined;
    throw error;
  }
}

/**
 * The stall a session is in, named by the mtime of the events file decision 35
 * ages it by: a clock that stands still for exactly as long as the session
 * does. So one dead turn is resumed once however many sweeps see it, while a
 * session that recovers, works and dies again is a new stall with a new stamp
 * and gets its own resume. Undefined when the file is gone.
 */
function stallStamp(eventsFile: string): string | undefined {
  if (!existsSync(eventsFile)) return undefined;
  return new Date(statSync(eventsFile).mtimeMs).toISOString();
}

/** Every `turn_died` recorded for a session, newest first. */
function deadTurnEvents(
  db: Database,
  sessionId: string,
): Array<{ reason: string; stalledAt: string; refusal?: string; at: Date }> {
  return listEvents(db, sessionId)
    .filter((event) => event.type === 'turn_died')
    .reverse()
    .map((event) => {
      // Through the store's own tolerant parse: a payload is JSON pup wrote,
      // but a torn row must drop out of a sweep rather than end it.
      const payload = parseJsonOr<{ reason?: unknown; stalledAt?: unknown; refusal?: unknown }>(
        event.payload,
        {},
      );
      return {
        reason: typeof payload.reason === 'string' ? payload.reason : '',
        stalledAt: typeof payload.stalledAt === 'string' ? payload.stalledAt : '',
        ...(typeof payload.refusal === 'string' ? { refusal: payload.refusal } : {}),
        at: new Date(Date.parse(toIsoUtc(event.created_at))),
      };
    });
}

/**
 * The two ways a steer is refused with nothing typed — the paste never landed
 * whole (decision 45), or the pane is not there to type into (decision 46).
 * Both leave the session running untouched, which is what makes them a
 * refusal to record rather than a failure to crash the sweep on.
 */
function isRefusedSteer(error: unknown): error is SteerNotDeliveredError | SessionPaneMissingError {
  return error instanceof SteerNotDeliveredError || error instanceof SessionPaneMissingError;
}
