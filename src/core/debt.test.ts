import { describe, expect, it } from 'vitest';
import type { Adapter, CapabilityContext } from '../adapters/types/adapter.types.js';
import {
  type DebtVerdict,
  type GateDebtMeasurement,
  judgeDebt,
  measureDebt,
} from './debt.service.js';
import { DUPLICATION_RULE_ID } from './merge-gate.constants.js';
import type { DebtBaseline } from './types/init.types.js';
import type { GateStageResult } from './types/merge-gate.types.js';

const CTX: CapabilityContext = { measurePath: '/worktree', configPath: '/repo' };

function adapter(id: string, capabilities: Partial<Adapter> = {}): Adapter {
  return { id, detect: () => true, gateCommands: () => [], ...capabilities };
}

describe('measureDebt', () => {
  it('reports no debt at all for adapters that declare no capability', () => {
    expect(measureDebt([adapter('ts')], CTX)).toEqual({ debt: {}, gaps: [] });
  });

  it('unions dead exports over every adapter that measured', () => {
    const measured = measureDebt(
      [
        adapter('ts', { deadCode: () => [{ file: 'src/a.ts', exportName: 'a' }] }),
        adapter('python', { deadCode: () => [{ file: 'pkg/b.py', exportName: 'b' }] }),
      ],
      CTX,
    );

    expect(measured.debt.deadExports).toEqual([
      { file: 'src/a.ts', exportName: 'a' },
      { file: 'pkg/b.py', exportName: 'b' },
    ]);
    expect(measured.gaps).toEqual([]);
  });

  it('keeps what the other adapters measured, and says which one could not', () => {
    const measured = measureDebt(
      [
        adapter('ts', { deadCode: () => [{ file: 'src/a.ts', exportName: 'a' }] }),
        adapter('python', { deadCode: () => ({ unavailable: 'vulture missing' }) }),
      ],
      CTX,
    );

    expect(measured.debt.deadExports).toEqual([{ file: 'src/a.ts', exportName: 'a' }]);
    expect(measured.gaps).toEqual([
      { adapterId: 'python', capability: 'dead code', reason: 'vulture missing' },
    ]);
  });

  // A bar of [] would read as "0 dead exports" and flag every later finding.
  it('leaves the dead-export bar unset when no adapter could measure it', () => {
    const measured = measureDebt(
      [adapter('python', { deadCode: () => ({ unavailable: 'vulture missing' }) })],
      CTX,
    );

    expect(measured.debt.deadExports).toBeUndefined();
    expect(measured.gaps).toHaveLength(1);
  });

  it('sums duplicated lines over every adapter and stamps the rule', () => {
    const measured = measureDebt(
      [
        adapter('ts', {
          duplication: () => ({
            duplicatedLines: 12,
            blocks: [{ locations: [{ file: 'src/a.ts', line: 1 }] }],
            excludedTestBlocks: 2,
          }),
        }),
        adapter('python', {
          duplication: () => ({
            duplicatedLines: 30,
            blocks: [{ locations: [{ file: 'pkg/b.py', line: 4 }] }],
            excludedTestBlocks: 5,
          }),
        }),
      ],
      CTX,
    );

    expect(measured.debt.duplicatedLines).toBe(42);
    expect(measured.debt.duplicationRule).toBe(DUPLICATION_RULE_ID);
    expect(measured.duplication?.blocks).toHaveLength(2);
    expect(measured.duplication?.excludedTestBlocks).toBe(7);
  });

  // A custom adapter self-reports its numbers and may not know the rule, so the
  // gate must fall silent about fixtures rather than claim it counted none.
  it('leaves the fixture count absent when no adapter reported one', () => {
    const measured = measureDebt(
      [adapter('custom', { duplication: () => ({ duplicatedLines: 8, blocks: [] }) })],
      CTX,
    );

    expect(measured.duplication).toEqual({ duplicatedLines: 8, blocks: [] });
  });

  // One ratio per repo: two runners' ratios are not one number, and the gate's
  // patch bar has to come from the same report `coverableFiles` answers about.
  it('takes coverage from the first adapter that declares it, and names that adapter', () => {
    const ts = adapter('ts', {
      coverage: () => ({ files: { 'src/a.ts': { covered: [1], instrumented: [1, 2] } } }),
    });
    const python = adapter('python', {
      coverage: () => ({ files: { 'pkg/b.py': { covered: [], instrumented: [1] } } }),
    });

    const measured = measureDebt([ts, python], CTX);

    expect(measured.debt.coverageRatio).toBe(0.5);
    expect(measured.coverageAdapter).toBe(ts);
  });

  it('records the coverage gap and leaves the ratio unset when the run is unavailable', () => {
    const measured = measureDebt(
      [adapter('ts', { coverage: () => ({ unavailable: 'instrumented run crashed' }) })],
      CTX,
    );

    expect(measured.debt.coverageRatio).toBeUndefined();
    expect(measured.coverage).toBeUndefined();
    expect(measured.gaps).toEqual([
      { adapterId: 'ts', capability: 'coverage', reason: 'instrumented run crashed' },
    ]);
  });
});

function measurement(over: Partial<GateDebtMeasurement> = {}): GateDebtMeasurement {
  return { debt: {}, gaps: [], coverableFiles: [], nestedNote: '', ...over };
}

const SESSION = 's1';

function judge(
  over: Partial<GateDebtMeasurement>,
  baseline?: DebtBaseline,
  changedPaths: string[] = ['src/feature.ts'],
): DebtVerdict {
  return judgeDebt(measurement(over), baseline, changedPaths, SESSION);
}

function stageOf(verdict: DebtVerdict, stage: string): GateStageResult | undefined {
  return verdict.stages.find((s) => s.stage === stage);
}

/** Every case below is one of these: the stage `judgeDebt` returns, verbatim. */
interface StageCase {
  measured: Partial<GateDebtMeasurement>;
  baseline?: DebtBaseline;
  expected: GateStageResult;
}

const DEAD_EXPORT = { file: 'src/feature.ts', exportName: 'feature' };
const LEGACY_EXPORT = { file: 'src/legacy.ts', exportName: 'old' };

describe('judgeDebt', () => {
  it('reports the four debt stages in the gate report order', () => {
    expect(judge({}).stages.map((s) => s.stage)).toEqual([
      'dead-code',
      'duplication',
      'complexity',
      'coverage',
    ]);
  });

  it.each<[string, StageCase]>([
    [
      'no adapter detects dead code',
      {
        measured: {},
        expected: {
          stage: 'dead-code',
          status: 'skipped',
          detail: 'not measured — adapter cannot detect dead code',
        },
      },
    ],
    [
      // The adapter's own reason, not a generic "unavailable" — a stage that
      // skips without saying why reads like a stage that passed.
      'the only adapter that could is unavailable',
      {
        measured: {
          gaps: [{ adapterId: 'ts', capability: 'dead code', reason: 'knip missing' }],
        },
        expected: {
          stage: 'dead-code',
          status: 'skipped',
          detail: 'not measured — knip missing',
        },
      },
    ],
    [
      'several adapters are unavailable, so each is named',
      {
        measured: {
          gaps: [
            { adapterId: 'ts', capability: 'dead code', reason: 'knip missing' },
            { adapterId: 'python', capability: 'dead code', reason: 'vulture missing' },
          ],
        },
        expected: {
          stage: 'dead-code',
          status: 'skipped',
          detail: 'not measured — ts: knip missing; python: vulture missing',
        },
      },
    ],
    [
      'there is no stored bar to compare against',
      {
        measured: { debt: { deadExports: [DEAD_EXPORT] } },
        baseline: {},
        expected: {
          stage: 'dead-code',
          status: 'skipped',
          detail: 'not measured — no debt baseline; run `pup init`',
        },
      },
    ],
    [
      'every finding is already in the bar',
      {
        measured: { debt: { deadExports: [LEGACY_EXPORT] } },
        baseline: { deadExports: [LEGACY_EXPORT] },
        expected: { stage: 'dead-code', status: 'pass', detail: 'no new unused exports' },
      },
    ],
    [
      'the branch adds an export nothing imports',
      {
        measured: { debt: { deadExports: [LEGACY_EXPORT, DEAD_EXPORT] } },
        baseline: { deadExports: [LEGACY_EXPORT] },
        expected: {
          stage: 'dead-code',
          status: 'flagged',
          detail: '1 new unused export(s): src/feature.ts#feature',
        },
      },
    ],
    [
      'one adapter measured and another could not',
      {
        measured: {
          debt: { deadExports: [LEGACY_EXPORT] },
          gaps: [{ adapterId: 'python', capability: 'dead code', reason: 'vulture missing' }],
        },
        baseline: { deadExports: [LEGACY_EXPORT] },
        expected: {
          stage: 'dead-code',
          status: 'pass',
          detail: 'no new unused exports; python not measured — vulture missing',
        },
      },
    ],
  ])('dead-code: %s', (_label, { measured, baseline, expected }) => {
    expect(stageOf(judge(measured, baseline), 'dead-code')).toEqual(expected);
  });

  it('names every file a fresh dead export sits in, sorted for a stable ledger key', () => {
    const verdict = judge(
      {
        debt: {
          deadExports: [
            { file: 'src/z.ts', exportName: 'z' },
            { file: 'src/a.ts', exportName: 'a' },
            { file: 'src/a.ts', exportName: 'b' },
          ],
        },
      },
      { deadExports: [] },
    );

    expect(verdict.flags).toEqual([
      {
        description: `New unused exports (3) merged from session ${SESSION}`,
        files: ['src/a.ts', 'src/z.ts'],
      },
    ]);
  });

  it('ratchets the dead-export bar it measured, even with nothing to compare against', () => {
    expect(judge({ debt: { deadExports: [DEAD_EXPORT] } }, {}).ratchet).toEqual({
      deadExports: [DEAD_EXPORT],
    });
  });

  // A partial count still compares soundly — it can only fail to flag — but
  // ratcheting it would write the missing adapter's known dead exports out of
  // the bar, and the next merge would see them as fresh.
  it('never ratchets a dead-export count an adapter is missing from', () => {
    const verdict = judge(
      {
        debt: { deadExports: [LEGACY_EXPORT] },
        gaps: [{ adapterId: 'python', capability: 'dead code', reason: 'vulture missing' }],
      },
      { deadExports: [LEGACY_EXPORT] },
    );

    expect(verdict.ratchet.deadExports).toBeUndefined();
  });

  it.each<[string, StageCase]>([
    [
      'no adapter detects duplication',
      {
        measured: {},
        expected: {
          stage: 'duplication',
          status: 'skipped',
          detail: 'not measured — adapter cannot detect duplication',
        },
      },
    ],
    [
      'there is no stored bar to compare against',
      {
        measured: { duplication: { duplicatedLines: 8, blocks: [] } },
        baseline: {},
        expected: {
          stage: 'duplication',
          status: 'skipped',
          detail: 'not measured — no debt baseline; run `pup init`',
        },
      },
    ],
    [
      'the count did not rise',
      {
        measured: { duplication: { duplicatedLines: 8, blocks: [] } },
        baseline: { duplicatedLines: 12, duplicationRule: DUPLICATION_RULE_ID },
        expected: {
          stage: 'duplication',
          status: 'pass',
          detail: '8 duplicated lines (baseline 12)',
        },
      },
    ],
    [
      // So a number that fell has a visible reason, and a pile of copy-pasted
      // fixtures is not silently invisible (decisions 29, 39).
      'blocks were left uncounted as test fixtures',
      {
        measured: { duplication: { duplicatedLines: 8, blocks: [], excludedTestBlocks: 17 } },
        baseline: { duplicatedLines: 12, duplicationRule: DUPLICATION_RULE_ID },
        expected: {
          stage: 'duplication',
          status: 'pass',
          detail: '8 duplicated lines (baseline 12); 17 test-fixture block(s) not counted',
        },
      },
    ],
    [
      // The string reaches the terminal, the fenced PR body and the re-steer
      // prompt, and an adapter is not the only possible producer of the number.
      'the fixture count is not a finite number',
      {
        measured: {
          duplication: { duplicatedLines: 8, blocks: [], excludedTestBlocks: Number.NaN },
        },
        baseline: { duplicatedLines: 12, duplicationRule: DUPLICATION_RULE_ID },
        expected: {
          stage: 'duplication',
          status: 'pass',
          detail: '8 duplicated lines (baseline 12)',
        },
      },
    ],
    [
      'the count rose, and a touched block says where',
      {
        measured: {
          duplication: {
            duplicatedLines: 16,
            blocks: [
              {
                locations: [
                  { file: 'src/feature.ts', line: 3 },
                  { file: 'src/app.ts', line: 9 },
                ],
              },
            ],
          },
        },
        baseline: { duplicatedLines: 4, duplicationRule: DUPLICATION_RULE_ID },
        expected: {
          stage: 'duplication',
          status: 'flagged',
          detail: 'duplicated lines rose from 4 to 16 (e.g. src/feature.ts:3 ≈ src/app.ts:9)',
        },
      },
    ],
  ])('duplication: %s', (_label, { measured, baseline, expected }) => {
    expect(stageOf(judge(measured, baseline), 'duplication')).toEqual(expected);
  });

  // The trap this closes: 62 measured under the new rule against 220 stored
  // under the old one passes on the difference, and the ratchet then writes the
  // difference in as the floor, where no later merge or audit ever sees it.
  it.each([
    ['a bar captured before the rule was stamped', undefined, 62],
    ['a bar captured under a superseded rule', 'imports-counted', 62],
    // Decision 59: nested packages left the count, so a pre-59 number is not a bar.
    ['a bar stamped before nested packages were left out', 'tests-excluded', 62],
    // The number is what the old rule would have flagged and refused. Skipping
    // the compare must not turn that refusal into an unbounded silent floor.
    ['a rise the skipped compare never saw', undefined, 5000],
  ])(
    'duplication: skips rather than comparing across rules, and moves no bar — %s',
    (_label, storedRule, measured) => {
      const verdict = judge(
        { duplication: { duplicatedLines: measured, blocks: [] } },
        { duplicatedLines: 220, ...(storedRule ? { duplicationRule: storedRule } : {}) },
      );

      expect(stageOf(verdict, 'duplication')).toEqual({
        stage: 'duplication',
        status: 'skipped',
        detail:
          'not measured — the stored baseline counts duplication a different way; run `pup audit`',
      });
      expect(verdict.ratchet.duplicatedLines).toBeUndefined();
      expect(verdict.ratchet.duplicationRule).toBeUndefined();
    },
  );

  it('names only the changed files a risen block sits in', () => {
    const verdict = judge(
      {
        duplication: {
          duplicatedLines: 16,
          blocks: [
            {
              locations: [
                { file: 'src/feature.ts', line: 3 },
                { file: 'src/untouched.ts', line: 9 },
              ],
            },
          ],
        },
      },
      { duplicatedLines: 4, duplicationRule: DUPLICATION_RULE_ID },
    );

    expect(verdict.flags).toEqual([
      {
        description: `Duplicated lines rose from 4 to 16 in session ${SESSION}`,
        files: ['src/feature.ts'],
      },
    ]);
  });

  it.each<[string, StageCase]>([
    [
      'no adapter measures complexity',
      {
        measured: {},
        expected: {
          stage: 'complexity',
          status: 'skipped',
          detail: 'not measured — adapter cannot measure complexity',
        },
      },
    ],
    [
      'no touched file rose past the threshold',
      {
        measured: {
          complexity: {
            before: [{ file: 'src/feature.ts', complexity: 2 }],
            after: [{ file: 'src/feature.ts', complexity: 9 }],
          },
        },
        expected: {
          stage: 'complexity',
          status: 'pass',
          detail: 'no touched file rose by more than 15 decision points',
        },
      },
    ],
    [
      'a file the branch touched rose sharply',
      {
        measured: {
          complexity: {
            before: [{ file: 'src/feature.ts', complexity: 2 }],
            after: [{ file: 'src/feature.ts', complexity: 40 }],
          },
        },
        expected: {
          stage: 'complexity',
          status: 'flagged',
          detail: 'complexity rose sharply in 1 touched file(s): src/feature.ts (+38)',
        },
      },
    ],
    [
      'a file the branch added counts its whole complexity as the rise',
      {
        measured: {
          complexity: { before: [], after: [{ file: 'src/feature.ts', complexity: 20 }] },
        },
        expected: {
          stage: 'complexity',
          status: 'flagged',
          detail: 'complexity rose sharply in 1 touched file(s): src/feature.ts (+20)',
        },
      },
    ],
  ])('complexity: %s', (_label, { measured, baseline, expected }) => {
    expect(stageOf(judge(measured, baseline), 'complexity')).toEqual(expected);
  });

  const COVERAGE_BAR: DebtBaseline = { coverageRatio: 0.8 };

  it.each<[string, StageCase]>([
    [
      'no adapter measures coverage',
      {
        measured: {},
        expected: {
          stage: 'coverage',
          status: 'skipped',
          detail: 'not measured — adapter cannot measure coverage',
        },
      },
    ],
    [
      'the instrumented run is unavailable and no source changed',
      {
        measured: {
          gaps: [{ adapterId: 'ts', capability: 'coverage', reason: 'instrumented run crashed' }],
        },
        baseline: COVERAGE_BAR,
        expected: {
          stage: 'coverage',
          status: 'skipped',
          detail: 'not measured — instrumented run crashed',
        },
      },
    ],
    [
      // The broad bypass: rather than excluding the changed files, make the
      // whole instrumented run fail. Config lives in the worktree, so this is
      // session-reachable and must not buy a free skip (decision 30).
      'the instrumented run is unavailable over changed source',
      {
        measured: {
          gaps: [{ adapterId: 'ts', capability: 'coverage', reason: 'threshold not met' }],
          coverableFiles: ['src/feature.ts'],
        },
        baseline: COVERAGE_BAR,
        expected: {
          stage: 'coverage',
          status: 'flagged',
          detail: '1 changed source file(s) went unmeasured — threshold not met',
        },
      },
    ],
    [
      'the report instruments nothing at all over changed source',
      {
        measured: { coverage: { files: {} }, coverableFiles: ['src/feature.ts'] },
        baseline: COVERAGE_BAR,
        expected: {
          stage: 'coverage',
          status: 'flagged',
          detail:
            '1 changed source file(s) went unmeasured — the instrumented run reported no instrumentable lines',
        },
      },
    ],
    [
      'there is no stored ratio to compare against',
      {
        measured: {
          debt: { coverageRatio: 0.9 },
          coverage: { files: { 'src/app.ts': { covered: [1], instrumented: [1] } } },
        },
        baseline: {},
        expected: {
          stage: 'coverage',
          status: 'skipped',
          detail: 'not measured — no coverage baseline; run `pup init`',
        },
      },
    ],
    [
      'the diff adds no instrumentable line',
      {
        measured: {
          debt: { coverageRatio: 1 },
          coverage: { files: { 'src/app.ts': { covered: [1], instrumented: [1] } } },
          patch: { covered: 0, instrumented: 0, uncovered: [] },
        },
        baseline: COVERAGE_BAR,
        expected: {
          stage: 'coverage',
          status: 'pass',
          detail: 'no instrumentable changed lines',
        },
      },
    ],
    [
      'the patch is fully covered',
      {
        measured: {
          debt: { coverageRatio: 1 },
          coverage: { files: { 'src/feature.ts': { covered: [1], instrumented: [1] } } },
          coverableFiles: ['src/feature.ts'],
          patch: { covered: 1, instrumented: 1, uncovered: [] },
        },
        baseline: COVERAGE_BAR,
        expected: {
          stage: 'coverage',
          status: 'pass',
          detail: 'patch coverage 100% (baseline 80%)',
        },
      },
    ],
    [
      'the patch falls below the stored ratio',
      {
        measured: {
          debt: { coverageRatio: 0 },
          coverage: { files: { 'src/feature.ts': { covered: [], instrumented: [1] } } },
          coverableFiles: ['src/feature.ts'],
          patch: { covered: 0, instrumented: 1, uncovered: [{ file: 'src/feature.ts', line: 1 }] },
        },
        baseline: COVERAGE_BAR,
        expected: {
          stage: 'coverage',
          status: 'flagged',
          detail: 'patch coverage 0% below repo baseline 80% (uncovered: src/feature.ts:1)',
        },
      },
    ],
    [
      // The loophole patch coverage alone cannot see: a file excluded from the
      // coverage config reads as "no instrumentable changed lines" and passes
      // for free (decision 30).
      'a changed source file never reached the report',
      {
        measured: {
          debt: { coverageRatio: 1 },
          coverage: { files: { 'src/app.ts': { covered: [1], instrumented: [1] } } },
          coverableFiles: ['src/feature.ts'],
          patch: { covered: 0, instrumented: 0, uncovered: [] },
        },
        baseline: COVERAGE_BAR,
        expected: {
          stage: 'coverage',
          status: 'flagged',
          detail:
            '1 changed source file(s) never reached the coverage report — no test loads them, or coverage config excludes them: src/feature.ts',
        },
      },
    ],
    [
      'changed assets and tests are free, which coverage never reports anyway',
      {
        measured: {
          debt: { coverageRatio: 1 },
          coverage: { files: { 'src/app.ts': { covered: [1], instrumented: [1] } } },
          patch: { covered: 0, instrumented: 0, uncovered: [] },
        },
        baseline: COVERAGE_BAR,
        expected: {
          stage: 'coverage',
          status: 'pass',
          detail: 'no instrumentable changed lines',
        },
      },
    ],
  ])('coverage: %s', (_label, { measured, baseline, expected }) => {
    expect(stageOf(judge(measured, baseline), 'coverage')).toEqual(expected);
  });

  // Both are evaluated, never short-circuited: a merge that hides files AND
  // drops patch coverage must record both, or the ledger understates what was
  // accepted while the baseline ratchets anyway.
  it('records both coverage problems when a merge hides files and drops the ratio', () => {
    const verdict = judge(
      {
        debt: { coverageRatio: 0 },
        coverage: { files: { 'src/thin.ts': { covered: [], instrumented: [1] } } },
        coverableFiles: ['src/hidden.ts', 'src/thin.ts'],
        patch: { covered: 0, instrumented: 1, uncovered: [{ file: 'src/thin.ts', line: 1 }] },
      },
      COVERAGE_BAR,
    );

    const detail = stageOf(verdict, 'coverage')?.detail ?? '';
    expect(detail).toContain('src/hidden.ts');
    expect(detail).toContain('patch coverage 0%');
    // One flag, but naming every file both problems touched.
    expect(verdict.flags).toEqual([
      {
        description: `Coverage gap (unreported files and patch coverage) merged from session ${SESSION}`,
        files: ['src/hidden.ts', 'src/thin.ts'],
      },
    ]);
  });

  it('ratchets every metric it could measure, and nothing it could not', () => {
    const verdict = judge(
      {
        debt: { deadExports: [], duplicatedLines: 5, duplicationRule: DUPLICATION_RULE_ID },
        duplication: { duplicatedLines: 5, blocks: [] },
      },
      { deadExports: [], duplicatedLines: 9, duplicationRule: DUPLICATION_RULE_ID },
    );

    expect(verdict.ratchet).toEqual({
      deadExports: [],
      duplicatedLines: 5,
      duplicationRule: DUPLICATION_RULE_ID,
    });
  });

  // Decision 58 leaves a nested package out of every root measurement, so a
  // pass on the stages that exclusion shapes must say what it left out.
  it('appends the nested-package note to every stage the exclusion shapes', () => {
    const note = '; 2 changed file(s) in a nested package not measured here (tools/cli)';
    const verdict = judge(
      {
        debt: { deadExports: [], duplicatedLines: 5, coverageRatio: 1 },
        duplication: { duplicatedLines: 5, blocks: [] },
        coverage: { files: { 'src/app.ts': { covered: [1], instrumented: [1] } } },
        complexity: { before: [], after: [] },
        patch: { covered: 0, instrumented: 0, uncovered: [] },
        nestedNote: note,
      },
      {
        deadExports: [],
        duplicatedLines: 5,
        duplicationRule: DUPLICATION_RULE_ID,
        coverageRatio: 1,
      },
    );

    for (const stage of ['dead-code', 'duplication', 'coverage']) {
      expect(stageOf(verdict, stage)?.detail).toContain(note);
    }
    // Complexity compares two checkouts file by file, so a nested package it
    // never measured cannot shift the number it reports.
    expect(stageOf(verdict, 'complexity')?.detail).not.toContain(note);
  });

  // A filename is raw bytes from `git diff -z`, and a detail is printed to the
  // terminal, fenced into the PR body and pasted back as a re-steer prompt.
  it('strips escapes out of a path before it reaches a stage detail', () => {
    const verdict = judge(
      { debt: { deadExports: [{ file: 'src/\u001b[31mevil.ts', exportName: 'x' }] } },
      { deadExports: [] },
    );

    expect(stageOf(verdict, 'dead-code')?.detail).toBe(
      '1 new unused export(s): src/ [31mevil.ts#x',
    );
  });
});
