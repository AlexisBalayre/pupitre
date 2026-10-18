import type { Database } from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Adapter, CoverageReport } from '../adapters/types/adapter.types.js';
import { tempDir } from '../test/temp-dir.mock.js';
import { auditProject, buildSweepTask, formatDebtTransition } from './audit.service.js';
import { listBaselineHistory } from './baseline-history.repository.js';
import { openStore } from './db.client.js';
import { initProject } from './init.service.js';
import { projectId } from './paths.utils.js';
import { endSandboxRun, UndeclaredSandboxError } from './sandbox.utils.js';
import { getProject, saveProjectBaseline } from './session.repository.js';
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

/** Pretend to be another platform for one test; `process.platform` is a plain property. */
function onPlatform(platform: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', original);
    vi.unstubAllEnvs();
  });
}

// The gate children this file runs outside a gate start a sandbox run the
// gate would have ended, and a test worker exits without the `exit` event
// that ends it otherwise (decision 100).
afterAll(() => {
  endSandboxRun();
});

describe('auditProject', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = tempDir('pup-audit-');
  });

  describe('off darwin (decision 78)', () => {
    it('refuses without the declaration and leaves the stored baseline alone', async () => {
      await initProject(db, repo, [makeAdapter()]);
      const stored = getProject(db, projectId(repo))?.baseline;
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', undefined);
      const detect = vi.fn(() => true);

      expect(() => auditProject(db, repo, [makeAdapter({ detect })])).toThrow(
        UndeclaredSandboxError,
      );
      expect(detect).not.toHaveBeenCalled();
      expect(getProject(db, projectId(repo))?.baseline).toBe(stored);
    });

    it('re-runs under the declaration and names it', async () => {
      onPlatform('linux');
      vi.stubEnv('PUP_SANDBOX', 'vm');

      expect((await auditProject(db, repo, [makeAdapter()])).sandbox).toBe(
        'vm (declared by operator)',
      );
    });
  });

  it('flags a stage that went pass -> fail as a regression and refreshes the baseline', async () => {
    await initProject(db, repo, [makeAdapter()]);
    const failingTest = makeAdapter({
      gateCommands: () => [
        { stage: 'build', command: 'true', args: [] },
        { stage: 'test', command: 'false', args: [] },
        { stage: 'lint', command: 'true', args: [] },
      ],
    });

    const report = await auditProject(db, repo, [failingTest]);

    expect(report.transitions).toEqual([
      { stage: 'build', before: 'pass', after: 'pass', delta: 'unchanged' },
      { stage: 'test', before: 'pass', after: 'fail', delta: 'regressed' },
      { stage: 'lint', before: 'pass', after: 'pass', delta: 'unchanged' },
    ]);
    expect(report.hasRegression).toBe(true);
    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.stages[1]).toMatchObject({ stage: 'test', status: 'fail' });
  });

  it('reports a stage that went fail -> pass as an improvement, not a regression', async () => {
    await initProject(db, repo, [
      makeAdapter({
        gateCommands: () => [
          { stage: 'build', command: 'true', args: [] },
          { stage: 'test', command: 'false', args: [] },
          { stage: 'lint', command: 'true', args: [] },
        ],
      }),
    ]);

    const report = await auditProject(db, repo, [makeAdapter()]);

    expect(report.transitions[1]).toEqual({
      stage: 'test',
      before: 'fail',
      after: 'pass',
      delta: 'improved',
    });
    expect(report.hasRegression).toBe(false);
  });

  it('behaves like init when no baseline is stored: no transitions, baseline saved', async () => {
    const report = await auditProject(db, repo, [makeAdapter()]);

    expect(report.previous).toBeNull();
    expect(report.transitions).toEqual([]);
    expect(report.hasRegression).toBe(false);
    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.stages.map((s) => s.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('reports all stages unchanged when nothing moved', async () => {
    await initProject(db, repo, [makeAdapter()]);

    const report = await auditProject(db, repo, [makeAdapter()]);

    expect(report.transitions.map((t) => t.delta)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(report.hasRegression).toBe(false);
  });

  it('treats losing a command for a passing stage (pass -> skipped) as a regression', async () => {
    await initProject(db, repo, [makeAdapter()]);
    const buildOnly = makeAdapter({
      gateCommands: () => [{ stage: 'build', command: 'true', args: [] }],
    });

    const report = await auditProject(db, repo, [buildOnly]);

    expect(report.transitions[1]).toEqual({
      stage: 'test',
      before: 'pass',
      after: 'skipped',
      delta: 'regressed',
    });
    expect(report.hasRegression).toBe(true);
  });

  it('flags duplicated lines rising as a debt regression and refuses via hasRegression', async () => {
    await initProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 182, blocks: [] }) }),
    ]);

    const report = await auditProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 196, blocks: [] }) }),
    ]);

    expect(report.debtTransitions).toEqual([
      { metric: 'duplicatedLines', before: 182, after: 196, delta: 'regressed' },
    ]);
    expect(report.hasRegression).toBe(true);
    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt?.duplicatedLines).toBe(196);
  });

  it('reports falling duplicated lines as improved, not a regression', async () => {
    await initProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 196, blocks: [] }) }),
    ]);

    const report = await auditProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 182, blocks: [] }) }),
    ]);

    expect(report.debtTransitions).toEqual([
      { metric: 'duplicatedLines', before: 196, after: 182, delta: 'improved' },
    ]);
    expect(report.hasRegression).toBe(false);
  });

  it('flags a growing unused-export count as a debt regression', async () => {
    await initProject(db, repo, [
      makeAdapter({ deadCode: () => [{ file: 'a.ts', exportName: 'foo' }] }),
    ]);

    const report = await auditProject(db, repo, [
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

  it('flags a coverage ratio drop beyond the epsilon as a debt regression', async () => {
    await initProject(db, repo, [makeAdapter({ coverage: () => coverageReport(90, 100) })]);

    const report = await auditProject(db, repo, [
      makeAdapter({ coverage: () => coverageReport(80, 100) }),
    ]);

    expect(report.debtTransitions).toEqual([
      { metric: 'coverageRatio', before: 0.9, after: 0.8, delta: 'regressed' },
    ]);
    expect(report.hasRegression).toBe(true);
  });

  it('treats a coverage ratio move within the epsilon as unchanged', async () => {
    await initProject(db, repo, [makeAdapter({ coverage: () => coverageReport(900, 1000) })]);

    const report = await auditProject(db, repo, [
      makeAdapter({ coverage: () => coverageReport(899, 1000) }),
    ]);

    expect(report.debtTransitions).toEqual([
      { metric: 'coverageRatio', before: 0.9, after: 0.899, delta: 'unchanged' },
    ]);
    expect(report.hasRegression).toBe(false);
  });

  it('leaves a history row for each audit, preserving the numbers it overwrote', async () => {
    await initProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 182, blocks: [] }) }),
    ]);

    const report = await auditProject(db, repo, [
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

  it('keeps the stored baseline and its history whole when coverage was not measured', async () => {
    await initProject(db, repo, [makeAdapter({ coverage: () => coverageReport(90, 100) })]);
    const stored = getProject(db, projectId(repo))?.baseline;
    const history = listBaselineHistory(db, projectId(repo));

    const report = await auditProject(db, repo, [
      makeAdapter({ coverage: () => ({ unavailable: 'instrumented vitest run failed: boom' }) }),
    ]);

    expect(report.unmeasured).toEqual([
      'fake: coverage not measured — instrumented vitest run failed: boom',
    ]);
    expect(getProject(db, projectId(repo))?.baseline).toBe(stored);
    expect(listBaselineHistory(db, projectId(repo))).toEqual(history);
  });

  it('refreshes the baseline when every metric measured', async () => {
    await initProject(db, repo, [makeAdapter({ coverage: () => coverageReport(90, 100) })]);

    const report = await auditProject(db, repo, [
      makeAdapter({ coverage: () => coverageReport(95, 100) }),
    ]);

    expect(report.unmeasured).toEqual([]);
    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt?.coverageRatio).toBe(0.95);
    expect(listBaselineHistory(db, projectId(repo))).toHaveLength(2);
  });

  // A runner that was never declared gaps on every run; refusing for it would
  // block the audit for good over a figure the baseline never held.
  it('refreshes the baseline when the unmeasured metric was never measured before', async () => {
    await initProject(db, repo, [makeAdapter({ coverage: () => ({ unavailable: 'no runner' }) })]);

    const report = await auditProject(db, repo, [
      makeAdapter({ coverage: () => ({ unavailable: 'no runner' }) }),
    ]);

    expect(report.unmeasured).toEqual([]);
    expect(listBaselineHistory(db, projectId(repo))).toHaveLength(2);
  });

  // `deadExports` is one flat array across adapters, so the figure alone cannot
  // say whose share went missing; the recorded gaps can.
  describe('with two adapters measuring dead code', () => {
    const ts = makeAdapter({ id: 'ts', deadCode: () => [] });
    const pyWithout = makeAdapter({
      id: 'py',
      deadCode: () => ({ unavailable: 'no vulture declared' }),
    });

    it('refreshes when the second adapter never measured dead code', async () => {
      await initProject(db, repo, [ts, pyWithout]);

      const report = await auditProject(db, repo, [ts, pyWithout]);

      expect(report.unmeasured).toEqual([]);
      expect(listBaselineHistory(db, projectId(repo))).toHaveLength(2);
    });

    it('refreshes when the second adapter was not run by the stored capture at all', async () => {
      await initProject(db, repo, [ts]);

      const report = await auditProject(db, repo, [ts, pyWithout]);

      expect(report.unmeasured).toEqual([]);
      const stored = JSON.parse(
        getProject(db, projectId(repo))?.baseline ?? '{}',
      ) as ProjectBaseline;
      expect(stored.gaps).toEqual([{ adapterId: 'py', capability: 'dead code' }]);
    });

    it('keeps the baseline when the second adapter measured before and failed now', async () => {
      await initProject(db, repo, [ts, makeAdapter({ id: 'py', deadCode: () => [] })]);
      const stored = getProject(db, projectId(repo))?.baseline;

      const report = await auditProject(db, repo, [ts, pyWithout]);

      expect(report.unmeasured).toEqual(['py: dead code not measured — no vulture declared']);
      expect(getProject(db, projectId(repo))?.baseline).toBe(stored);
    });
  });

  // Stored before gaps were recorded: judged by the figures it holds, so a
  // coverage figure is still protected and a metric it never had still is not.
  describe('with a baseline stored before gaps were recorded', () => {
    async function storeLegacy(adapter: Adapter): Promise<void> {
      await initProject(db, repo, [adapter]);
      const stored = JSON.parse(
        getProject(db, projectId(repo))?.baseline ?? '{}',
      ) as ProjectBaseline;
      const { gaps: _gaps, ...legacy } = stored;
      saveProjectBaseline(db, projectId(repo), legacy.adapters, JSON.stringify(legacy));
    }

    it('keeps the baseline when a coverage figure it holds went unmeasured', async () => {
      await storeLegacy(makeAdapter({ coverage: () => coverageReport(90, 100) }));
      const stored = getProject(db, projectId(repo))?.baseline;

      const report = await auditProject(db, repo, [
        makeAdapter({ coverage: () => ({ unavailable: 'boom' }) }),
      ]);

      expect(report.unmeasured).toEqual(['fake: coverage not measured — boom']);
      expect(getProject(db, projectId(repo))?.baseline).toBe(stored);
    });

    it('refreshes and records the gap for a metric it never held', async () => {
      await storeLegacy(makeAdapter({ coverage: () => ({ unavailable: 'no runner' }) }));

      const report = await auditProject(db, repo, [
        makeAdapter({ coverage: () => ({ unavailable: 'no runner' }) }),
      ]);

      expect(report.unmeasured).toEqual([]);
      const refreshed = JSON.parse(
        getProject(db, projectId(repo))?.baseline ?? '{}',
      ) as ProjectBaseline;
      expect(refreshed.gaps).toEqual([{ adapterId: 'fake', capability: 'coverage' }]);
    });
  });

  it('stores a first baseline with a gap like `pup init` does: there is nothing to keep', async () => {
    const report = await auditProject(db, repo, [
      makeAdapter({ coverage: () => ({ unavailable: 'no runner' }) }),
    ]);

    expect(report.unmeasured).toEqual([]);
    expect(getProject(db, projectId(repo))?.baseline).toBeDefined();
    expect(listBaselineHistory(db, projectId(repo))).toHaveLength(1);
  });

  it('emits no transition for a metric measured on only one side', async () => {
    await initProject(db, repo, [makeAdapter()]);

    const report = await auditProject(db, repo, [
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
