import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import { gitDiffNumstat, gitDiffPaths, scrubbedGitEnv } from './git-diff.client.js';
import { countChangedLines } from './merge-gate.service.js';
import {
  RISK_WEIGHT_OVERLAP,
  RISK_WEIGHT_PER_100_LINES,
  RISK_WEIGHT_REJECTION,
  RISK_WEIGHT_SCOPE_VIOLATION,
} from './review.constants.js';
import { listSessions, type SessionRow } from './session.repository.js';
import type { GateReport } from './types/merge-gate.types.js';
import type { TaskSpec } from './types/profile.types.js';
import type { ReviewQueueEntry, SessionReviewDetail } from './types/review.types.js';

function targetBranch(repoPath: string): string {
  const target = execFileSync('git', ['-C', repoPath, 'branch', '--show-current'], {
    encoding: 'utf8',
    env: scrubbedGitEnv(),
  }).trim();
  if (!target) throw new Error(`Main worktree at ${repoPath} is not on a branch.`);
  return target;
}

function taskSpec(db: Database, taskId: string): TaskSpec {
  const row = db.prepare('SELECT spec FROM tasks WHERE id = ?').get(taskId) as { spec: string };
  return JSON.parse(row.spec) as TaskSpec;
}

function scopeViolationCount(db: Database, sessionId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'scope_violation'")
    .get(sessionId) as { n: number };
  return row.n;
}

function lastGateReport(db: Database, sessionId: string): GateReport | undefined {
  const rows = db
    .prepare(
      "SELECT payload FROM events WHERE session_id = ? AND type = 'gate_result' ORDER BY id DESC",
    )
    .all(sessionId) as { payload: string }[];
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { report?: GateReport };
    if (payload.report) return payload.report;
  }
  return undefined;
}

function overlapCount(
  session: SessionRow,
  paths: string[],
  liveDiffs: Map<string, Set<string>>,
): number {
  let overlaps = 0;
  for (const [otherId, otherPaths] of liveDiffs) {
    if (otherId === session.id) continue;
    if (paths.some((p) => otherPaths.has(p))) overlaps += 1;
  }
  return overlaps;
}

function buildEntry(
  db: Database,
  repoPath: string,
  target: string,
  session: SessionRow,
  liveDiffs: Map<string, Set<string>>,
): ReviewQueueEntry {
  const paths = gitDiffPaths(repoPath, target, session.branch);
  const changedLines = countChangedLines(repoPath, target, session.branch);
  const scopeViolations = scopeViolationCount(db, session.id);
  const overlaps = overlapCount(session, paths, liveDiffs);
  const risk =
    (changedLines / 100) * RISK_WEIGHT_PER_100_LINES +
    scopeViolations * RISK_WEIGHT_SCOPE_VIOLATION +
    overlaps * RISK_WEIGHT_OVERLAP +
    session.reject_count * RISK_WEIGHT_REJECTION;
  return {
    sessionId: session.id,
    branch: session.branch,
    goal: taskSpec(db, session.task_id).goal,
    changedLines,
    filesChanged: paths.length,
    rejectCount: session.reject_count,
    scopeViolations,
    overlaps,
    risk: Math.round(risk * 10) / 10,
  };
}

/** Diff paths of every live (running or reviewable) session, keyed by session id. */
function liveSessionDiffs(
  repoPath: string,
  target: string,
  sessions: SessionRow[],
): Map<string, Set<string>> {
  const diffs = new Map<string, Set<string>>();
  for (const session of sessions) {
    diffs.set(session.id, new Set(gitDiffPaths(repoPath, target, session.branch)));
  }
  return diffs;
}

/** The review queue: sessions awaiting review, riskiest first (docs/02-cli.md). */
export function buildReviewQueue(db: Database, repoPath: string): ReviewQueueEntry[] {
  const target = targetBranch(repoPath);
  const live = listSessions(db, ['running', 'awaiting-review']);
  const liveDiffs = liveSessionDiffs(repoPath, target, live);
  return live
    .filter((s) => s.state === 'awaiting-review')
    .map((s) => buildEntry(db, repoPath, target, s, liveDiffs))
    .sort((a, b) => b.risk - a.risk);
}

/**
 * Full detail for one branch: spec, per-file diff stats, last gate report.
 * Blocked sessions are included — a human needs the failure history to
 * unblock them (decision 7).
 */
export function buildSessionReview(
  db: Database,
  repoPath: string,
  sessionId: string,
): SessionReviewDetail {
  const target = targetBranch(repoPath);
  const live = listSessions(db, ['running', 'awaiting-review', 'blocked']);
  const session = live.find((s) => s.id === sessionId);
  if (!session)
    throw new Error(`No live session ${sessionId} (must be running, awaiting-review, or blocked).`);
  const liveDiffs = liveSessionDiffs(repoPath, target, live);
  return {
    entry: buildEntry(db, repoPath, target, session, liveDiffs),
    spec: taskSpec(db, session.task_id),
    state: session.state,
    worktreePath: session.worktree_path,
    files: gitDiffNumstat(repoPath, target, session.branch),
    lastGateReport: lastGateReport(db, session.id),
  };
}
