import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { auditProject, buildSweepTask } from './audit.service.js';
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
