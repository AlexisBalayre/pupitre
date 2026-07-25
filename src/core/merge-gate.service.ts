import { execFileSync } from 'node:child_process';
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { killSession as killTmux, steerSession } from '../claude/session-runtime.service.js';
import { patchCoverage, repoCoverageRatio } from './coverage.utils.js';
import { draftDecisionRecord } from './decision-record.service.js';
import {
  gitDiffAddedLines,
  gitDiffNumstat,
  gitDiffPaths,
  scrubbedGitEnv,
} from './git-diff.client.js';
import { assertGhAvailable, createPullRequest, originRepoSlug } from './github.client.js';
import { insertLedgerEntry, listLedgerEntries } from './ledger.repository.js';
import {
  COMPLEXITY_FILE_FLAG_DELTA,
  COVERAGE_RATIO_EPSILON,
  DEBT_DETAIL_SAMPLES,
  DIFF_SIZE_FLAG_LINES,
  GATE_COMMAND_TIMEOUT_MS,
  GATE_OUTPUT_TAIL_CHARS,
  LOCKFILE_NAMES,
  MAX_REJECTS_BEFORE_BLOCKED,
  MERGE_LOCK_DIRNAME,
  PR_TITLE_MAX_CHARS,
} from './merge-gate.constants.js';
import { MergeLockHeldError, SessionNotReviewableError } from './merge-gate.errors.js';
import { auditScope } from './scope-audit.utils.js';
import {
  appendEvent,
  getProject,
  getSession,
  incrementRejectCount,
  type SessionRow,
  saveProjectBaseline,
  transitionSession,
} from './session.repository.js';
import type { DebtBaseline, ProjectBaseline } from './types/init.types.js';
import type {
  GateReport,
  GateStageResult,
  MergeOutcome,
  MergeRequest,
} from './types/merge-gate.types.js';
import type { TaskSpec } from './types/profile.types.js';

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

/** Adds + deletes across the branch diff, excluding lockfiles and binary files. */
export function countChangedLines(repoPath: string, target: string, branch: string): number {
  let changed = 0;
  for (const stat of gitDiffNumstat(repoPath, target, branch)) {
    if (stat.added === null || stat.deleted === null || LOCKFILE_NAMES.includes(stat.path)) {
      continue;
    }
    changed += stat.added + stat.deleted;
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

function formatGateReport(report: GateReport): string {
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
 * hard stages — build, tests, lint, scope audit — and the soft debt stages:
 * diff-size plus the v1.1 debt deltas (dead code, duplication, complexity;
 * decision 21). Pass: ff-only merge, full cleanup (decision 16), and the debt
 * baseline ratchets to the merged state. Hard fail: re-steer with the report, cap
 * at two rejections then park as blocked (decisions 7, 15). Any soft flag without
 * --accept-debt refuses the merge but leaves the session reviewable (decision 17);
 * with it, each flag writes a ledger entry. The whole run holds the per-repo
 * merge lock.
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
  let prRepo: string | undefined;
  if (req.openPr) {
    assertGhAvailable();
    let originUrl: string;
    try {
      originUrl = git(req.repoPath, 'remote', 'get-url', 'origin');
    } catch {
      throw new Error('`pup merge --pr` needs an `origin` remote to push the branch to.');
    }
    prRepo = originRepoSlug(originUrl);
  }
  return withMergeLock(req.repoPath, () => gateAndMerge(db, req, session, target, prRepo));
}

function gateAndMerge(
  db: Database,
  req: MergeRequest,
  session: SessionRow,
  target: string,
  prRepo?: string,
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

  const changedPaths = gitDiffPaths(req.repoPath, target, session.branch);
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

  // Snapshot before any --accept-debt entry from THIS merge is written, so a
  // merge never flags its own fresh debt as closeable.
  const debtCandidates = listLedgerEntries(db, specRow.project_id)
    .filter((entry) => {
      const files = JSON.parse(entry.files) as string[];
      return files.some((f) => changedPaths.includes(f));
    })
    .map((entry) => ({ id: entry.id, description: entry.description }));

  const project = getProject(db, specRow.project_id);
  const baseline = project?.baseline
    ? (JSON.parse(project.baseline) as ProjectBaseline)
    : undefined;
  const measuredDebt: DebtBaseline = {};
  const flaggedDebt: { description: string; files: string[] }[] = [];
  const acceptHint =
    'Re-run with --accept-debt "<reason>" --review-by "<condition>", or steer the session to address it.';
  const flagDetail = (summary: string): string =>
    req.acceptDebt
      ? `${summary} — accepted as debt: ${req.acceptDebt.reason}`
      : `${summary}. ${acceptHint}`;

  const changedLines = countChangedLines(req.repoPath, target, session.branch);
  if (changedLines > DIFF_SIZE_FLAG_LINES) {
    flaggedDebt.push({
      description: `Oversize diff (${changedLines} lines) merged from session ${session.id}`,
      files: changedPaths,
    });
    stages.push({
      stage: 'diff-size',
      status: 'flagged',
      detail: flagDetail(
        `${changedLines} changed lines exceeds the ${DIFF_SIZE_FLAG_LINES}-line flag`,
      ),
    });
  } else {
    stages.push({ stage: 'diff-size', status: 'pass', detail: `${changedLines} changed lines` });
  }

  if (!req.adapter.deadCode) {
    stages.push({
      stage: 'dead-code',
      status: 'skipped',
      detail: 'not measured — adapter cannot detect dead code',
    });
  } else {
    const current = req.adapter.deadCode(worktree);
    if (current) measuredDebt.deadExports = current;
    const known = baseline?.debt?.deadExports;
    if (!current) {
      stages.push({
        stage: 'dead-code',
        status: 'skipped',
        detail: 'not measured — dead-code tooling unavailable or the run failed',
      });
    } else if (!known) {
      stages.push({
        stage: 'dead-code',
        status: 'skipped',
        detail: 'not measured — no debt baseline; run `pup init`',
      });
    } else {
      const knownKeys = new Set(known.map((d) => `${d.file}\u0000${d.exportName}`));
      const fresh = current.filter((d) => !knownKeys.has(`${d.file}\u0000${d.exportName}`));
      if (fresh.length === 0) {
        stages.push({ stage: 'dead-code', status: 'pass', detail: 'no new unused exports' });
      } else {
        const quoted = fresh
          .slice(0, DEBT_DETAIL_SAMPLES)
          .map((d) => `${d.file}#${d.exportName}`)
          .join(', ');
        const ellipsis = fresh.length > DEBT_DETAIL_SAMPLES ? ', …' : '';
        flaggedDebt.push({
          description: `New unused exports (${fresh.length}) merged from session ${session.id}`,
          files: [...new Set(fresh.map((d) => d.file))],
        });
        stages.push({
          stage: 'dead-code',
          status: 'flagged',
          detail: flagDetail(`${fresh.length} new unused export(s): ${quoted}${ellipsis}`),
        });
      }
    }
  }

  if (!req.adapter.duplication) {
    stages.push({
      stage: 'duplication',
      status: 'skipped',
      detail: 'not measured — adapter cannot detect duplication',
    });
  } else {
    const duplication = req.adapter.duplication(worktree);
    measuredDebt.duplicatedLines = duplication.duplicatedLines;
    const knownLines = baseline?.debt?.duplicatedLines;
    if (knownLines === undefined) {
      stages.push({
        stage: 'duplication',
        status: 'skipped',
        detail: 'not measured — no debt baseline; run `pup init`',
      });
    } else if (duplication.duplicatedLines <= knownLines) {
      stages.push({
        stage: 'duplication',
        status: 'pass',
        detail: `${duplication.duplicatedLines} duplicated lines (baseline ${knownLines})`,
      });
    } else {
      const changedSet = new Set(changedPaths);
      const touchedBlocks = duplication.blocks.filter((b) =>
        b.locations.some((l) => changedSet.has(l.file)),
      );
      const samples = (touchedBlocks.length > 0 ? touchedBlocks : duplication.blocks)
        .slice(0, DEBT_DETAIL_SAMPLES)
        .map((b) =>
          b.locations
            .slice(0, 2)
            .map((l) => `${l.file}:${l.line}`)
            .join(' ≈ '),
        )
        .join('; ');
      const files = [
        ...new Set(
          touchedBlocks
            .flatMap((b) => b.locations.map((l) => l.file))
            .filter((f) => changedSet.has(f)),
        ),
      ];
      flaggedDebt.push({
        description: `Duplicated lines rose from ${knownLines} to ${duplication.duplicatedLines} in session ${session.id}`,
        files: files.length > 0 ? files : changedPaths,
      });
      stages.push({
        stage: 'duplication',
        status: 'flagged',
        detail: flagDetail(
          `duplicated lines rose from ${knownLines} to ${duplication.duplicatedLines} (e.g. ${samples})`,
        ),
      });
    }
  }

  if (!req.adapter.complexity) {
    stages.push({
      stage: 'complexity',
      status: 'skipped',
      detail: 'not measured — adapter cannot measure complexity',
    });
  } else {
    // "Before" reads the main checkout, which the merge lock holds at the target
    // branch — no historical checkout needed.
    const before = new Map(
      req.adapter.complexity(req.repoPath, changedPaths).map((f) => [f.file, f.complexity]),
    );
    const risen = req.adapter
      .complexity(worktree, changedPaths)
      .map((f) => ({ ...f, delta: f.complexity - (before.get(f.file) ?? 0) }))
      .filter((f) => f.delta > COMPLEXITY_FILE_FLAG_DELTA);
    if (risen.length === 0) {
      stages.push({
        stage: 'complexity',
        status: 'pass',
        detail: `no touched file rose by more than ${COMPLEXITY_FILE_FLAG_DELTA} decision points`,
      });
    } else {
      const quoted = risen
        .slice(0, DEBT_DETAIL_SAMPLES)
        .map((f) => `${f.file} (+${f.delta})`)
        .join(', ');
      const ellipsis = risen.length > DEBT_DETAIL_SAMPLES ? ', …' : '';
      flaggedDebt.push({
        description: `Complexity rise (+${risen.reduce((sum, f) => sum + f.delta, 0)} decision points) merged from session ${session.id}`,
        files: risen.map((f) => f.file),
      });
      stages.push({
        stage: 'complexity',
        status: 'flagged',
        detail: flagDetail(
          `complexity rose sharply in ${risen.length} touched file(s): ${quoted}${ellipsis}`,
        ),
      });
    }
  }

  if (!req.adapter.coverage) {
    stages.push({
      stage: 'coverage',
      status: 'skipped',
      detail: 'not measured — adapter cannot measure coverage',
    });
  } else {
    const coverageReport = req.adapter.coverage(worktree);
    const repoRatio = coverageReport ? repoCoverageRatio(coverageReport) : undefined;
    if (repoRatio !== undefined) measuredDebt.coverageRatio = repoRatio;
    const baselineRatio = baseline?.debt?.coverageRatio;
    if (!coverageReport || repoRatio === undefined) {
      stages.push({
        stage: 'coverage',
        status: 'skipped',
        detail: 'not measured — coverage tooling unavailable or the instrumented run failed',
      });
    } else if (baselineRatio === undefined) {
      stages.push({
        stage: 'coverage',
        status: 'skipped',
        detail: 'not measured — no coverage baseline; run `pup init`',
      });
    } else {
      const patch = patchCoverage(
        coverageReport,
        gitDiffAddedLines(req.repoPath, target, session.branch),
      );
      const pct = (ratio: number): string => `${Math.round(ratio * 1000) / 10}%`;
      if (patch.instrumented === 0) {
        stages.push({
          stage: 'coverage',
          status: 'pass',
          detail: 'no instrumentable changed lines',
        });
      } else if (patch.covered / patch.instrumented + COVERAGE_RATIO_EPSILON >= baselineRatio) {
        stages.push({
          stage: 'coverage',
          status: 'pass',
          detail: `patch coverage ${pct(patch.covered / patch.instrumented)} (baseline ${pct(baselineRatio)})`,
        });
      } else {
        const quoted = patch.uncovered
          .slice(0, DEBT_DETAIL_SAMPLES)
          .map((u) => `${u.file}:${u.line}`)
          .join(', ');
        const ellipsis = patch.uncovered.length > DEBT_DETAIL_SAMPLES ? ', …' : '';
        flaggedDebt.push({
          description: `Patch coverage ${pct(patch.covered / patch.instrumented)} below baseline ${pct(baselineRatio)} merged from session ${session.id}`,
          files: [...new Set(patch.uncovered.map((u) => u.file))],
        });
        stages.push({
          stage: 'coverage',
          status: 'flagged',
          detail: flagDetail(
            `patch coverage ${pct(patch.covered / patch.instrumented)} below repo baseline ${pct(baselineRatio)} (uncovered: ${quoted}${ellipsis})`,
          ),
        });
      }
    }
  }

  if (flaggedDebt.length > 0) {
    if (!req.acceptDebt) {
      const report: GateReport = { sessionId: session.id, passed: false, stages };
      appendEvent(db, session.id, 'gate_result', { outcome: 'refused', report });
      return { status: 'refused', report, rejectCount: session.reject_count };
    }
    for (const flag of flaggedDebt) {
      insertLedgerEntry(db, {
        projectId: specRow.project_id,
        description: flag.description,
        files: flag.files,
        reason: req.acceptDebt.reason,
        acceptedBy: 'human',
        reviewBy: req.acceptDebt.reviewBy,
      });
    }
  }

  const report: GateReport = { sessionId: session.id, passed: true, stages };
  const commitSubjects = git(
    req.repoPath,
    'log',
    '--reverse',
    '--format=%s',
    `${target}..${session.branch}`,
  )
    .split('\n')
    .filter(Boolean);
  let prUrl: string | undefined;
  if (prRepo !== undefined) {
    // Unlike the shared git() helper this gets a timeout: a stalled push would
    // otherwise hang while holding the merge lock.
    execFileSync('git', ['-C', req.repoPath, 'push', '--set-upstream', 'origin', session.branch], {
      encoding: 'utf8',
      timeout: GATE_COMMAND_TIMEOUT_MS,
      env: scrubbedGitEnv(),
    });
    prUrl = createPullRequest(req.repoPath, {
      repo: prRepo,
      head: session.branch,
      base: target,
      title: prTitle(spec.goal) || `pup session ${session.id}`,
      body: prBody(spec, report, commitSubjects),
    });
  } else {
    git(req.repoPath, 'merge', '--ff-only', session.branch);
  }
  transitionSession(db, session.id, 'merged', { report });
  appendEvent(db, session.id, 'merge', {
    branch: session.branch,
    target,
    files: changedPaths,
    ...(prUrl !== undefined ? { prUrl } : {}),
  });
  if (
    // In PR mode the target branch has not moved, so the bar must not either:
    // the next `pup audit` after the PR lands ratchets it (decision 26).
    !req.openPr &&
    project &&
    baseline &&
    (measuredDebt.deadExports !== undefined ||
      measuredDebt.duplicatedLines !== undefined ||
      measuredDebt.coverageRatio !== undefined)
  ) {
    // Ratchet (docs/04): the merged state becomes the new bar. Accepted-debt merges
    // move it too — the accepted amount lives in the ledger, and re-flagging it would
    // punish later sessions for debt they didn't add.
    const next: ProjectBaseline = { ...baseline, debt: { ...baseline.debt, ...measuredDebt } };
    saveProjectBaseline(
      db,
      specRow.project_id,
      JSON.parse(project.adapters) as string[],
      JSON.stringify(next),
    );
  }
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(session.task_id);
  const decisionRecordId = draftDecisionRecord(db, {
    sessionId: session.id,
    spec,
    files: changedPaths,
    commitSubjects,
  });

  killTmux(session.id);
  git(req.repoPath, 'worktree', 'remove', '--force', worktree);
  // PR mode needs -D: the branch is not in the local target's history, only on origin.
  git(req.repoPath, 'branch', req.openPr ? '-D' : '-d', session.branch);
  return {
    status: 'merged',
    report,
    rejectCount: session.reject_count,
    debtCandidates,
    decisionRecordId,
    ...(prUrl !== undefined ? { prUrl } : {}),
  };
}

function prTitle(goal: string): string {
  const line = (goal.split('\n')[0] as string).trim();
  return line.length <= PR_TITLE_MAX_CHARS ? line : `${line.slice(0, PR_TITLE_MAX_CHARS - 1)}…`;
}

function prBody(spec: TaskSpec, report: GateReport, commitSubjects: string[]): string {
  // Commit subjects and gate details quote session-authored text. Fenced so
  // GitHub renders it inert — no `Closes #n` auto-closing, no @mention pings,
  // no invisible HTML comments aimed at review bots.
  return [
    '## Goal',
    '',
    spec.goal,
    '',
    '## Acceptance',
    '',
    ...spec.acceptance.map((item) => `- ${item}`),
    '',
    '## Commits',
    '',
    '````',
    ...commitSubjects,
    '````',
    '',
    '## Gate report',
    '',
    '````',
    formatGateReport(report),
    '````',
  ].join('\n');
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
