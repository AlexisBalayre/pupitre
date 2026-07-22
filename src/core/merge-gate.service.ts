import { execFileSync } from 'node:child_process';
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { killSession as killTmux, steerSession } from '../claude/session-runtime.service.js';
import { insertLedgerEntry } from './ledger.repository.js';
import {
  DIFF_SIZE_FLAG_LINES,
  GATE_COMMAND_TIMEOUT_MS,
  GATE_OUTPUT_TAIL_CHARS,
  LOCKFILE_NAMES,
  MAX_REJECTS_BEFORE_BLOCKED,
  MERGE_LOCK_DIRNAME,
} from './merge-gate.constants.js';
import { MergeLockHeldError, SessionNotReviewableError } from './merge-gate.errors.js';
import { auditScope } from './scope-audit.utils.js';
import {
  appendEvent,
  getSession,
  incrementRejectCount,
  type SessionRow,
  transitionSession,
} from './session.repository.js';
import type {
  GateReport,
  GateStageResult,
  MergeOutcome,
  MergeRequest,
} from './types/merge-gate.types.js';
import type { TaskSpec } from './types/profile.types.js';

/**
 * Environment without the GIT_DIR family: when `pup merge` itself runs inside a
 * git hook, those inherited vars would point every child git call (and any git
 * usage in gate commands) at the hook's repo instead of the target path.
 */
function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const scrubbed = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !scrubbed.includes(key)));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: scrubbedGitEnv(),
  }).trim();
}

function isAncestor(repoPath: string, maybeAncestor: string, ref: string): boolean {
  try {
    git(repoPath, 'merge-base', '--is-ancestor', maybeAncestor, ref);
    return true;
  } catch {
    return false;
  }
}

function commandFailureDetail(error: unknown): string {
  const failure = error as { stdout?: string; stderr?: string; message?: string };
  const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
  return (output || (failure.message ?? 'command failed')).slice(-GATE_OUTPUT_TAIL_CHARS);
}

/**
 * Repo-relative paths changed on the branch. NUL-delimited (`-z`) so git never
 * C-quotes non-ASCII names — the scope audit must see the exact byte paths, or
 * a quoted `.claude/…` path would slip past the protected-glob backstop.
 */
function diffPaths(repoPath: string, target: string, branch: string): string[] {
  return git(repoPath, 'diff', '-z', '--name-only', `${target}...${branch}`)
    .split('\0')
    .filter(Boolean);
}

/** Adds + deletes across the branch diff, excluding lockfiles and binary files. */
function countChangedLines(repoPath: string, target: string, branch: string): number {
  // With -z, a renamed entry is "added\tdeleted\t" followed by the old and new
  // paths as two separate NUL fields.
  const fields = git(repoPath, 'diff', '-z', '--numstat', `${target}...${branch}`).split('\0');
  let changed = 0;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const [added, deleted, inlinePath] = field.split('\t');
    const path = inlinePath || fields[i + 2];
    if (!inlinePath) i += 2;
    if (!path || added === '-' || LOCKFILE_NAMES.includes(path)) continue;
    changed += Number(added) + Number(deleted);
  }
  return changed;
}

function withMergeLock<TResult>(repoPath: string, fn: () => TResult): TResult {
  const lockPath = join(repoPath, '.git', MERGE_LOCK_DIRNAME);
  try {
    mkdirSync(lockPath);
  } catch {
    throw new MergeLockHeldError(lockPath);
  }
  try {
    return fn();
  } finally {
    rmdirSync(lockPath);
  }
}

export function formatGateReport(report: GateReport): string {
  const lines = report.stages.map(
    (s) => `- ${s.stage}: ${s.status.toUpperCase()}${s.detail ? ` — ${s.detail}` : ''}`,
  );
  const header = `Merge gate ${report.passed ? 'passed' : 'FAILED'} for session ${report.sessionId}.`;
  if (report.passed) return [header, ...lines].join('\n');
  return [
    header,
    ...lines,
    '',
    'Fix the failures above, commit in this worktree, then run `pup session done "<summary>"` again.',
  ].join('\n');
}

/**
 * `pup merge`: fresh-base check with mechanical auto-rebase (decision 8), then the
 * v1 gate stages — build, tests, lint, scope audit, diff-size flag (decision 14).
 * Pass: ff-only merge and full cleanup (decision 16). Hard fail: re-steer with the
 * report, cap at two rejections then park as blocked (decisions 7, 15). Diff-size
 * flag without --accept-debt refuses the merge but leaves the session reviewable
 * (decision 17). The whole run holds the per-repo merge lock.
 */
export function runMergeGate(db: Database, req: MergeRequest): MergeOutcome {
  const session = getSession(db, req.sessionId);
  if (!session) throw new Error(`No session ${req.sessionId}.`);
  if (session.state !== 'awaiting-review') {
    throw new SessionNotReviewableError(req.sessionId, session.state);
  }
  const target = git(req.repoPath, 'branch', '--show-current');
  if (!target) {
    throw new Error(`Main worktree at ${req.repoPath} is not on a branch; cannot merge.`);
  }
  return withMergeLock(req.repoPath, () => gateAndMerge(db, req, session, target));
}

function gateAndMerge(
  db: Database,
  req: MergeRequest,
  session: SessionRow,
  target: string,
): MergeOutcome {
  const worktree = session.worktree_path;
  const stages: GateStageResult[] = [];
  const failed = (): MergeOutcome =>
    rejectOrBlock(db, { sessionId: session.id, passed: false, stages });

  const dirty = git(worktree, 'status', '--porcelain');
  if (dirty) {
    stages.push({
      stage: 'worktree-clean',
      status: 'fail',
      detail: `Uncommitted changes in the worktree:\n${dirty}`,
    });
    return failed();
  }
  stages.push({ stage: 'worktree-clean', status: 'pass' });

  if (isAncestor(req.repoPath, target, session.branch)) {
    stages.push({ stage: 'fresh-base', status: 'pass', detail: `already based on ${target}` });
  } else {
    try {
      git(worktree, 'rebase', target);
      stages.push({ stage: 'fresh-base', status: 'pass', detail: `auto-rebased onto ${target}` });
    } catch (error) {
      try {
        git(worktree, 'rebase', '--abort');
      } catch {
        // nothing to abort — the rebase never started
      }
      stages.push({
        stage: 'fresh-base',
        status: 'fail',
        detail:
          `Auto-rebase onto ${target} hit conflicts. Run \`git rebase ${target}\`, ` +
          `resolve the conflicts, and finish the rebase.\n${commandFailureDetail(error)}`,
      });
      return failed();
    }
  }

  // Resolved from the trusted main checkout, not the session's worktree: a
  // session that deletes a script fails that stage instead of skipping it.
  const commands = req.adapter.gateCommands(req.repoPath);
  for (const stage of ['build', 'test', 'lint'] as const) {
    const command = commands.find((c) => c.stage === stage);
    if (!command) {
      stages.push({ stage, status: 'skipped', detail: 'not measured — no command available' });
      continue;
    }
    try {
      execFileSync(command.command, command.args, {
        cwd: worktree,
        encoding: 'utf8',
        timeout: GATE_COMMAND_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: scrubbedGitEnv(),
      });
      stages.push({ stage, status: 'pass' });
    } catch (error) {
      stages.push({ stage, status: 'fail', detail: commandFailureDetail(error) });
      return failed();
    }
  }

  const changedPaths = diffPaths(req.repoPath, target, session.branch);
  const specRow = db
    .prepare('SELECT project_id, spec FROM tasks WHERE id = ?')
    .get(session.task_id) as { project_id: string; spec: string };
  const spec = JSON.parse(specRow.spec) as TaskSpec;
  const violations = auditScope(changedPaths, spec.scopeIn, spec.scopeOut ?? []);
  if (violations.length > 0) {
    stages.push({
      stage: 'scope-audit',
      status: 'fail',
      detail: `Out-of-scope changes:\n${violations
        .map((v) => `  ${v.path} (${v.reason})`)
        .join('\n')}`,
    });
    return failed();
  }
  stages.push({
    stage: 'scope-audit',
    status: 'pass',
    detail: `${changedPaths.length} files in scope`,
  });

  const changedLines = countChangedLines(req.repoPath, target, session.branch);
  if (changedLines > DIFF_SIZE_FLAG_LINES) {
    if (!req.acceptDebt) {
      stages.push({
        stage: 'diff-size',
        status: 'flagged',
        detail:
          `${changedLines} changed lines exceeds the ${DIFF_SIZE_FLAG_LINES}-line flag. ` +
          'Re-run with --accept-debt "<reason>" --review-by "<condition>", or steer the session to shrink the diff.',
      });
      const report: GateReport = { sessionId: session.id, passed: false, stages };
      appendEvent(db, session.id, 'gate_result', { outcome: 'refused', report });
      return { status: 'refused', report, rejectCount: session.reject_count };
    }
    stages.push({
      stage: 'diff-size',
      status: 'flagged',
      detail: `${changedLines} changed lines accepted as debt: ${req.acceptDebt.reason}`,
    });
    insertLedgerEntry(db, {
      projectId: specRow.project_id,
      description: `Oversize diff (${changedLines} lines) merged from session ${session.id}`,
      files: changedPaths,
      reason: req.acceptDebt.reason,
      acceptedBy: 'human',
      reviewBy: req.acceptDebt.reviewBy,
    });
  } else {
    stages.push({ stage: 'diff-size', status: 'pass', detail: `${changedLines} changed lines` });
  }

  const report: GateReport = { sessionId: session.id, passed: true, stages };
  git(req.repoPath, 'merge', '--ff-only', session.branch);
  transitionSession(db, session.id, 'merged', { report });
  appendEvent(db, session.id, 'merge', { branch: session.branch, target, files: changedPaths });
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(session.task_id);

  killTmux(session.id);
  git(req.repoPath, 'worktree', 'remove', '--force', worktree);
  git(req.repoPath, 'branch', '-d', session.branch);
  return { status: 'merged', report, rejectCount: session.reject_count };
}

function rejectOrBlock(db: Database, report: GateReport): MergeOutcome {
  const rejectCount = incrementRejectCount(db, report.sessionId);
  transitionSession(db, report.sessionId, 'rejected', { report });
  if (rejectCount > MAX_REJECTS_BEFORE_BLOCKED) {
    transitionSession(db, report.sessionId, 'blocked', {
      reason: `reject cap of ${MAX_REJECTS_BEFORE_BLOCKED} reached`,
      rejectCount,
    });
    return { status: 'blocked', report, rejectCount };
  }
  try {
    steerSession(report.sessionId, formatGateReport(report));
  } catch {
    transitionSession(db, report.sessionId, 'blocked', {
      reason: 're-steer failed — session unreachable',
      rejectCount,
    });
    return { status: 'blocked', report, rejectCount };
  }
  appendEvent(db, report.sessionId, 'steer', { kind: 'gate-rejection' });
  transitionSession(db, report.sessionId, 'running', { kind: 'gate-rejection-resteer' });
  return { status: 'rejected', report, rejectCount };
}
