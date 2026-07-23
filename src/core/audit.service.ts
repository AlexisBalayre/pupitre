import type { Database } from 'better-sqlite3';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { initProject } from './init.service.js';
import { projectId } from './paths.utils.js';
import { getProject } from './session.repository.js';
import type { AuditReport, StageDelta, StageTransition } from './types/audit.types.js';
import type { BaselineStageStatus, ProjectBaseline } from './types/init.types.js';
import type { TaskId, TaskSpec } from './types/profile.types.js';

function classifyDelta(before: BaselineStageStatus, after: BaselineStageStatus): StageDelta {
  if (before === after) return 'unchanged';
  if (before === 'pass') return 'regressed';
  if (after === 'pass') return 'improved';
  return 'changed';
}

export function compareBaselines(
  previous: ProjectBaseline,
  fresh: ProjectBaseline,
): StageTransition[] {
  return fresh.stages.map((stage) => {
    // A stage absent from the old baseline was never measured — same as skipped.
    const before = previous.stages.find((s) => s.stage === stage.stage)?.status ?? 'skipped';
    return {
      stage: stage.stage,
      before,
      after: stage.status,
      delta: classifyDelta(before, stage.status),
    };
  });
}

/**
 * `pup audit` (no --sweep): re-run the baseline stages exactly like `pup init`,
 * diff against the previously stored baseline, and refresh it. First run (no
 * stored baseline) degenerates to plain init: no transitions to report.
 */
export function auditProject(db: Database, repoPath: string, adapters: Adapter[]): AuditReport {
  const row = getProject(db, projectId(repoPath));
  const previous = row?.baseline ? (JSON.parse(row.baseline) as ProjectBaseline) : null;
  const report = initProject(db, repoPath, adapters);
  const transitions = previous ? compareBaselines(previous, report.baseline) : [];
  return {
    projectId: report.projectId,
    previous,
    baseline: report.baseline,
    transitions,
    hasRegression: transitions.some((t) => t.delta === 'regressed'),
    findings: report.findings,
  };
}

/**
 * Task spec for a `pup audit --sweep` session (docs/02): deletion-only — the
 * agent hunts dead code, unused exports, and unused dependencies, and removes
 * them. The gate's build/test/lint stages are the safety net, so the scope is
 * the whole repo rather than a curated glob list.
 */
export function buildSweepTask(id: TaskId, findings: string[]): TaskSpec {
  const context = findings.length
    ? `\n\nAudit findings to keep in mind (do not fix these, they are context):\n${findings
        .map((finding) => `- ${finding}`)
        .join('\n')}`
    : '';
  return {
    id,
    goal:
      'Deletion-only sweep: find and remove dead code, unused exports, unused files, and ' +
      'unused dependencies. Do not add features, rename, or refactor behaviour. Prefer tools ' +
      `like knip, ts-prune, or depcheck to find candidates, then verify each before deleting.${context}`,
    scopeIn: ['**/*'],
    acceptance: [
      'only remove code, files, and dependencies — no new functionality or renames',
      'build, tests, and lint pass after every deletion',
      'each deletion is independently justified in the commit message',
    ],
  };
}
