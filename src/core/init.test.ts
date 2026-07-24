import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { openStore } from './db.client.js';
import { initProject, NoAdapterError } from './init.service.js';
import { projectId } from './paths.utils.js';
import { getProject } from './session.repository.js';
import type { ProjectBaseline } from './types/init.types.js';

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

describe('initProject', () => {
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-init-')));
  });

  it('stores a passing baseline on the project row', () => {
    const report = initProject(db, repo, [makeAdapter()]);

    expect(report.baseline.stages.map((s) => s.status)).toEqual(['pass', 'pass', 'pass']);
    expect(report.findings).toEqual([]);
    const row = getProject(db, projectId(repo));
    expect(JSON.parse(row?.adapters ?? '[]')).toEqual(['fake']);
    const stored = JSON.parse(row?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.stages).toHaveLength(3);
  });

  it('records a failing stage and surfaces it as a finding, without throwing', () => {
    const adapter = makeAdapter({
      gateCommands: () => [
        { stage: 'build', command: 'true', args: [] },
        { stage: 'test', command: 'false', args: [] },
        { stage: 'lint', command: 'true', args: [] },
      ],
    });

    const report = initProject(db, repo, [adapter]);

    expect(report.baseline.stages[1]).toMatchObject({ stage: 'test', status: 'fail' });
    expect(report.findings.some((f) => f.includes('test fails at baseline'))).toBe(true);
  });

  it('marks missing commands as skipped with a not-measured finding', () => {
    const adapter = makeAdapter({
      gateCommands: () => [{ stage: 'build', command: 'true', args: [] }],
    });

    const report = initProject(db, repo, [adapter]);

    expect(report.baseline.stages.map((s) => s.status)).toEqual(['pass', 'skipped', 'skipped']);
    expect(report.findings).toHaveLength(2);
  });

  it('refreshes the baseline on re-run', () => {
    initProject(db, repo, [
      makeAdapter({ gateCommands: () => [{ stage: 'build', command: 'false', args: [] }] }),
    ]);
    const second = initProject(db, repo, [makeAdapter()]);

    expect(second.findings).toEqual([]);
    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.stages.map((s) => s.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('captures debt metrics in the baseline when the adapter can measure them', () => {
    const adapter = makeAdapter({
      deadCode: () => [{ file: 'src/a.ts', exportName: 'orphan' }],
      duplication: () => ({ duplicatedLines: 12, blocks: [] }),
    });

    initProject(db, repo, [adapter]);

    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt).toEqual({
      deadExports: [{ file: 'src/a.ts', exportName: 'orphan' }],
      duplicatedLines: 12,
    });
  });

  it('leaves debt metrics out of the baseline when no adapter can measure them', () => {
    initProject(db, repo, [makeAdapter()]);

    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt).toBeUndefined();
  });

  it('throws when no adapter detects the repo', () => {
    const adapter = makeAdapter({ detect: () => false });
    expect(() => initProject(db, repo, [adapter])).toThrow(NoAdapterError);
  });
});
