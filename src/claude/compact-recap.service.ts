import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { readPlainFile, sanitizeReason } from '../adapters/capability.utils.js';
import { openConductorQuestion } from '../core/conductor.service.js';
import { MERGE_LOCK_DIRNAME } from '../core/constants/merge-gate.constants.js';
import { EventType } from '../core/enums/event-type.enums.js';
import { GateStageStatus } from '../core/enums/gate-stage-status.enums.js';
import { SessionState } from '../core/enums/session-state.enums.js';
import { runGit, verifiedWorktreeGitEnv } from '../core/git-diff.client.js';
import {
  currentFixRound,
  decodeEvent,
  getSession,
  listSessions,
  newestEventOf,
  openQuestion,
} from '../core/session.repository.js';
import type { QuestionEvent, SessionRow } from '../core/types/session.types.js';

/**
 * What the SessionStart hook on `compact` prints after the summary (decision 199):
 * the live state a compaction summary was measured to lose, read from the store
 * and git rather than recalled. Lines, each list capped, so the hook's output
 * stays under its byte cap with room to spare.
 */

/** The most ids, PRs or failed stages one line or list names before it counts the rest. */
const MAX_LISTED = 12;

/** The states the conductor sees named one by one; the rest are counted (decision 199). */
const NAMED_STATES: readonly SessionState[] = [
  SessionState.Running,
  SessionState.Queued,
  SessionState.Blocked,
  SessionState.Rejected,
  SessionState.AwaitingReview,
];

/**
 * All the open PRs' git reads together, so a hung one leaves the rest of the
 * recap inside the hook's timeout; a local rev-parse takes milliseconds.
 */
const RECAP_GIT_BUDGET_MS = 5_000;

/** An abbreviated commit id, as the recap prints it. */
const SHORT_SHA = 12;

/** The session's store-side state for its own window after a compaction. */
export function sessionRecap(db: Database, sessionId: string): string[] {
  const session = getSession(db, sessionId);
  if (!session)
    return [`Session state: unknown — no session ${sanitizeReason(sessionId)} in the store.`];
  const fixRound = currentFixRound(db, session.id);
  // No CHECK constraint holds `state` to its type, so a BLOB comes back a Buffer,
  // and SQLite's INTEGER affinity keeps a non-numeric `reject_count` as text:
  // both are stringified, then scrubbed like the rest.
  return [
    `Session state: ${sanitizeReason(String(session.state))} (${sanitizeReason(session.id)})` +
      `${fixRound ? `, in a CI fix round since ${utc(fixRound.created_at)}` : ''}` +
      `, ${sanitizeReason(String(session.reject_count))} rejection${session.reject_count === 1 ? '' : 's'}.`,
    lastGateLine(db, session.id),
    questionLine('Unanswered question to the operator', openQuestion(db, session.id)),
  ];
}

/**
 * The newest gate verdict: a `gate_result` carrying a report. A bare transition
 * (a steer, an unblock) says nothing about passing, so it is passed over.
 */
function lastGateLine(db: Database, sessionId: string): string {
  const rows = db
    .prepare(
      'SELECT type, payload, created_at FROM events WHERE session_id = ? AND type = ? ORDER BY id DESC',
    )
    .iterate(sessionId, EventType.GateResult) as IterableIterator<{
    type: EventType.GateResult;
    payload: string;
    created_at: string;
  }>;
  for (const row of rows) {
    const event = decodeEvent(row);
    if (event.type !== 'gate_result' || !event.report) continue;
    const failed = event.report.stages.filter((stage) => stage.status === GateStageStatus.Fail);
    const verdict = event.report.passed
      ? 'passed'
      : `failed${failed.length ? ` at ${listed(failed.map((stage) => sanitizeReason(stage.stage)))}` : ''}`;
    const edge =
      event.from && event.to
        ? ` (${sanitizeReason(event.from)} → ${sanitizeReason(event.to)})`
        : '';
    return `Last gate: ${verdict}${edge}, ${utc(row.created_at)}.`;
  }
  return 'Last gate: none run yet.';
}

function questionLine(label: string, question: QuestionEvent | undefined): string {
  if (!question) return `${label}: none.`;
  const options = question.options.map((option, i) => `${i + 1}) ${sanitizeReason(option)}`);
  return (
    `${label} (#${question.id}): ${sanitizeReason(question.text ?? '')}` +
    `${options.length ? ` Options: ${options.join('; ')}.` : ''}` +
    `${question.recommended ? ` Recommended: ${question.recommended}.` : ''}`
  );
}

/**
 * The fleet as the conductor drives it, after its own compaction: the sessions
 * by state, each open PR's heads, the merge lock and its own open question.
 */
export function conductorRecap(db: Database, repoPath: string): string[] {
  const sessions = listSessions(db);
  const lines = ['Sessions by state:'];
  for (const state of NAMED_STATES) {
    const inState = sessions.filter((session) => session.state === state);
    if (inState.length === 0) continue;
    const ids = inState.map((session) =>
      currentFixRound(db, session.id)
        ? `${sanitizeReason(session.id)} (fix round)`
        : sanitizeReason(session.id),
    );
    lines.push(`  ${state} (${inState.length}): ${listed(ids)}`);
  }
  const counted = [SessionState.Merged, SessionState.Killed]
    .map((state) => `${state} ${sessions.filter((session) => session.state === state).length}`)
    .join(', ');
  lines.push(`  counted only: ${counted}`);
  lines.push(...openPrLines(db, repoPath, sessions));
  lines.push(mergeLockLine(repoPath));
  lines.push(
    questionLine('Your unanswered question to the operator', openConductorQuestion(db, repoPath)),
  );
  return lines;
}

/**
 * Each session whose newest `merge`, `landed`, `retired` or `pr_closed` is a
 * merge that opened or updated a PR, newest first, with three heads: the gate's
 * pin, `origin/<branch>` as pup's push last moved it, and the worktree's own.
 * A worktree past its pin holds commits no gate measured.
 */
function openPrLines(db: Database, repoPath: string, sessions: SessionRow[]): string[] {
  const open = sessions
    .filter((session) => session.state !== SessionState.Killed)
    .flatMap((session) => {
      const newest = newestEventOf(db, session.id, [
        EventType.Merge,
        EventType.Landed,
        EventType.Retired,
        EventType.PrClosed,
      ]);
      if (newest?.type !== EventType.Merge) return [];
      const merge = decodeEvent(newest);
      return merge.type === 'merge' && merge.prUrl
        ? [{ session, merge, prUrl: merge.prUrl, at: newest.id }]
        : [];
    })
    .sort((a, b) => b.at - a.at);
  if (open.length === 0) return ['Open PRs: none.'];
  const lines = [
    'Open PRs (pin = the head the gate measured; pushed = origin/<branch>; worktree = its head now):',
  ];
  const deadline = Date.now() + RECAP_GIT_BUDGET_MS;
  for (const { session, merge, prUrl } of open.slice(0, MAX_LISTED)) {
    const pin = merge.sha ? short(merge.sha) : 'none';
    const pushed = readHead(deadline, (read) =>
      runGit(
        repoPath,
        ['rev-parse', '-q', '--verify', `refs/remotes/origin/${session.branch}^{commit}`],
        read,
      ),
    );
    const worktree = readHead(deadline, (read) =>
      runGit(session.worktree_path, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], {
        ...read,
        env: { ...verifiedWorktreeGitEnv(repoPath, session.worktree_path) },
      }),
    );
    const drift =
      merge.sha && worktree !== short(merge.sha) && worktree !== 'unreadable'
        ? ' (worktree past the pin: not gated yet)'
        : '';
    lines.push(
      `  ${sanitizeReason(session.id)} ${sanitizeReason(String(session.state))} ${sanitizeReason(prUrl)}` +
        ` pin ${pin} pushed ${pushed} worktree ${worktree}${drift}`,
    );
  }
  if (open.length > MAX_LISTED) lines.push(`  … ${open.length - MAX_LISTED} more`);
  return lines;
}

/**
 * One head, or `unreadable` when git fails or the recap's git budget is spent.
 * git's stderr is dropped: a missing worktree is a line here, not noise.
 */
function readHead(
  deadline: number,
  read: (opts: { stdio: ['ignore', 'pipe', 'ignore']; timeout: number }) => string,
): string {
  const left = deadline - Date.now();
  if (left <= 0) return 'unreadable';
  try {
    return short(read({ stdio: ['ignore', 'pipe', 'ignore'], timeout: left }).trim());
  } catch {
    return 'unreadable';
  }
}

/**
 * Who holds the merge lock, read as the gate reads it (decision 88): the
 * directory in the main `.git`, the pid inside it and, beside the pid, what the
 * holder runs and its stage (decision 184). Never a link followed or a fifo
 * opened, and its text scrubbed, since a session can write there.
 */
function mergeLockLine(repoPath: string): string {
  const lockPath = join(repoPath, '.git', MERGE_LOCK_DIRNAME);
  if (!lstatSync(lockPath, { throwIfNoEntry: false })?.isDirectory()) return 'Merge lock: free.';
  const read = (name: string): string | undefined => {
    try {
      return readPlainFile(join(lockPath, name), { followLinks: false });
    } catch {
      return undefined;
    }
  };
  const pid = read('pid')?.trim();
  if (!pid || !/^[1-9]\d*$/.test(pid)) return 'Merge lock: held, by no pid it recorded.';
  let doing = '';
  try {
    const status = JSON.parse(read('status') ?? '') as { command?: unknown; stage?: unknown };
    if (typeof status.command === 'string')
      doing += ` running \`${sanitizeReason(status.command)}\``;
    if (typeof status.stage === 'string' && status.stage)
      doing += ` at ${sanitizeReason(status.stage)}`;
  } catch {
    // No status: a lock an earlier pup took, or one read mid-write.
  }
  return `Merge lock: held by pid ${pid}${doing}${isLive(Number(pid)) ? '' : ' (gone: the next run reclaims it)'}.`;
}

/** EPERM is a live process another user runs, as the gate counts it. */
function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function listed(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${shown}, … ${items.length - MAX_LISTED} more` : shown;
}

function short(sha: string): string {
  return sanitizeReason(sha).slice(0, SHORT_SHA);
}

/** A store time (SQLite's `YYYY-MM-DD HH:MM:SS`, UTC) as the recap prints it. */
function utc(createdAt: string): string {
  return `${sanitizeReason(createdAt)} UTC`;
}
