import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, CoverageReport } from '../adapters/types/adapter.types.js';
import { auditProject, buildSweepTask, formatDebtTransition } from './audit.service.js';
import { listBaselineHistory } from './baseline-history.repository.js';
import { openStore } from './db.client.js';
import { initProject } from './init.service.js';
import { projectId } from './paths.utils.js';
import { getProject } from './session.repository.js';
import type { ProjectBaseline } from './types/init.types.js';
import type { TaskId } from './types/profile.types.js';

function makeAdapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    id: 'fake',
    detect: () => true,
    gateCommands: () => [
      { stage: 'build', command: 'true', args: [] },
      { stage: 'test', command: 'true', args: [] },
      { stage: 'lint', command: 'true', args: [] },
    ],
    ...overrides,
  };
}

function coverageReport(covered: number, instrumented: number): CoverageReport {
  return {
    files: {
      'a.ts': {
        covered: Array.from({ length: covered }, (_, i) => i + 1),
        instrumented: Array.from({ length: instrumented }, (_, i) => i + 1),
      },
    },
  };
}

describe('auditProject', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-audit-')));
  });

  it('flags a stage that went pass -> fail as a regression and refreshes the baseline', () => {
    initProject(db, repo, [makeAdapter()]);
    const failingTest = makeAdapter({
      gateCommands: () => [
        { stage: 'build', command: 'true', args: [] },
        { stage: 'test', command: 'false', args: [] },
        { stage: 'lint', command: 'true', args: [] },
      ],
    });

    const report = auditProject(db, repo, [failingTest]);

    expect(report.transitions).toEqual([
      { stage: 'build', before: 'pass', after: 'pass', delta: 'unchanged' },
      { stage: 'test', before: 'pass', after: 'fail', delta: 'regressed' },
      { stage: 'lint', before: 'pass', after: 'pass', delta: 'unchanged' },
    ]);
    expect(report.hasRegression).toBe(true);
    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.stages[1]).toMatchObject({ stage: 'test', status: 'fail' });
  });

  it('reports a stage that went fail -> pass as an improvement, not a regression', () => {
    initProject(db, repo, [
      makeAdapter({
        gateCommands: () => [
          { stage: 'build', command: 'true', args: [] },
          { stage: 'test', command: 'false', args: [] },
          { stage: 'lint', command: 'true', args: [] },
        ],
      }),
    ]);

    const report = auditProject(db, repo, [makeAdapter()]);

    expect(report.transitions[1]).toEqual({
      stage: 'test',
      before: 'fail',
      after: 'pass',
      delta: 'improved',
    });
    expect(report.hasRegression).toBe(false);
  });

  it('behaves like init when no baseline is stored: no transitions, baseline saved', () => {
    const report = auditProject(db, repo, [makeAdapter()]);

    expect(report.previous).toBeNull();
    expect(report.transitions).toEqual([]);
    expect(report.hasRegression).toBe(false);
    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.stages.map((s) => s.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('reports all stages unchanged when nothing moved', () => {
    initProject(db, repo, [makeAdapter()]);

    const report = auditProject(db, repo, [makeAdapter()]);

    expect(report.transitions.map((t) => t.delta)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(report.hasRegression).toBe(false);
  });

  it('treats losing a command for a passing stage (pass -> skipped) as a regression', () => {
    initProject(db, repo, [makeAdapter()]);
    const buildOnly = makeAdapter({
      gateCommands: () => [{ stage: 'build', command: 'true', args: [] }],
    });

    const report = auditProject(db, repo, [buildOnly]);

    expect(report.transitions[1]).toEqual({
      stage: 'test',
      before: 'pass',
      after: 'skipped',
      delta: 'regressed',
    });
    expect(report.hasRegression).toBe(true);
  });

  it('flags duplicated lines rising as a debt regression and refuses via hasRegression', () => {
    initProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 182, blocks: [] }) }),
    ]);

    const report = auditProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 196, blocks: [] }) }),
    ]);

    expect(report.debtTransitions).toEqual([
      { metric: 'duplicatedLines', before: 182, after: 196, delta: 'regressed' },
    ]);
    expect(report.hasRegression).toBe(true);
    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt?.duplicatedLines).toBe(196);
  });

  it('reports falling duplicated lines as improved, not a regression', () => {
    initProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 196, blocks: [] }) }),
    ]);

    const report = auditProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 182, blocks: [] }) }),
    ]);

    expect(report.debtTransitions).toEqual([
      { metric: 'duplicatedLines', before: 196, after: 182, delta: 'improved' },
    ]);
    expect(report.hasRegression).toBe(false);
  });

  it('flags a growing unused-export count as a debt regression', () => {
    initProject(db, repo, [makeAdapter({ deadCode: () => [{ file: 'a.ts', exportName: 'foo' }] })]);

    const report = auditProject(db, repo, [
      makeAdapter({
        deadCode: () => [
          { file: 'a.ts', exportName: 'foo' },
          { file: 'b.ts', exportName: 'bar' },
        ],
      }),
    ]);

    expect(report.debtTransitions).toEqual([
      { metric: 'deadExports', before: 1, after: 2, delta: 'regressed' },
    ]);
    expect(report.hasRegression).toBe(true);
  });

  it('flags a coverage ratio drop beyond the epsilon as a debt regression', () => {
    initProject(db, repo, [makeAdapter({ coverage: () => coverageReport(90, 100) })]);

    const report = auditProject(db, repo, [
      makeAdapter({ coverage: () => coverageReport(80, 100) }),
    ]);

    expect(report.debtTransitions).toEqual([
      { metric: 'coverageRatio', before: 0.9, after: 0.8, delta: 'regressed' },
    ]);
    expect(report.hasRegression).toBe(true);
  });

  it('treats a coverage ratio move within the epsilon as unchanged', () => {
    initProject(db, repo, [makeAdapter({ coverage: () => coverageReport(900, 1000) })]);

    const report = auditProject(db, repo, [
      makeAdapter({ coverage: () => coverageReport(899, 1000) }),
    ]);

    expect(report.debtTransitions).toEqual([
      { metric: 'coverageRatio', before: 0.9, after: 0.899, delta: 'unchanged' },
    ]);
    expect(report.hasRegression).toBe(false);
  });

  it('leaves a history row for each audit, preserving the numbers it overwrote', () => {
    initProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 182, blocks: [] }) }),
    ]);

    const report = auditProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 196, blocks: [] }) }),
    ]);

    const history = listBaselineHistory(db, projectId(repo));
    expect(
      history.map(
        (r) => (JSON.parse(r.debt ?? '{}') as { duplicatedLines: number }).duplicatedLines,
      ),
    ).toEqual([182, 196]);
    expect(history[1]?.captured_at).toBe(report.baseline.capturedAt);
  });

  it('emits no transition for a metric measured on only one side', () => {
    initProject(db, repo, [makeAdapter()]);

    const report = auditProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 10, blocks: [] }) }),
    ]);

    expect(report.debtTransitions).toEqual([]);
    expect(report.hasRegression).toBe(false);
  });
});

describe('formatDebtTransition', () => {
  it('marks a regressed metric with an old -> new line and a REGRESSED marker', () => {
    const line = formatDebtTransition({
      metric: 'duplicatedLines',
      before: 182,
      after: 196,
      delta: 'regressed',
    });

    expect(line).toContain('182 -> 196');
    expect(line).toContain('REGRESSED');
  });

  it('marks an improved metric with an IMPROVED marker', () => {
    const line = formatDebtTransition({
      metric: 'deadExports',
      before: 5,
      after: 2,
      delta: 'improved',
    });

    expect(line).toContain('5 -> 2');
    expect(line).toContain('IMPROVED');
  });

  it('carries no marker for an unchanged metric', () => {
    const line = formatDebtTransition({
      metric: 'coverageRatio',
      before: 0.9,
      after: 0.9,
      delta: 'unchanged',
    });

    expect(line).toContain('90% -> 90%');
    expect(line).not.toMatch(/REGRESSED|IMPROVED/);
  });
});

describe('buildSweepTask', () => {
  it('builds a deletion-only task scoped to the whole repo with findings as context', () => {
    const task = buildSweepTask('sw-1' as TaskId, ['test stage failing at baseline']);

    expect(task.id).toBe('sw-1');
    expect(task.goal).toMatch(/deletion-only/i);
    expect(task.goal).toContain('test stage failing at baseline');
    expect(task.scopeIn).toEqual(['**/*']);
    expect(task.acceptance.some((a) => /only remove/i.test(a))).toBe(true);
  });

  it('omits the findings section when the audit is clean', () => {
    const task = buildSweepTask('sw-2' as TaskId, []);

    expect(task.goal).not.toMatch(/findings/i);
  });
});
