import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { listBaselineHistory } from './baseline-history.repository.js';
import { openStore } from './db.client.js';
import { BrokenToolchainError, initProject, NoAdapterError } from './init.service.js';
import { DUPLICATION_RULE_ID } from './merge-gate.constants.js';
import { projectId } from './paths.utils.js';
import {
  ensureProject,
  getProject,
  insertSession,
  insertTask,
  saveProjectBaseline,
} from './session.repository.js';
import type { DebtBaseline, ProjectBaseline } from './types/init.types.js';

// Same isolation the other suites use: a test repo must not inherit the
// developer's global git config, nor the GIT_DIR family a pre-commit run sets.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0] as string, args.slice(1), { cwd, encoding: 'utf8', env: GIT_ENV });
}

const ORIGIN_URL = 'git@github.com:owner/repo.git';

/** Turns the fixture into a git repo with an origin, as a real project has. */
function addOrigin(repo: string, url = ORIGIN_URL): void {
  sh(repo, 'git', 'init', '-b', 'main');
  sh(repo, 'git', 'remote', 'add', 'origin', url);
}

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

/** A pre-upgrade store: projects.baseline holds a capture no history row records. */
function seedPreHistoryBaseline(
  db: Database,
  pid: string,
  repoPath: string,
  debt?: DebtBaseline,
): ProjectBaseline {
  ensureProject(db, pid, repoPath);
  const legacy: ProjectBaseline = {
    capturedAt: '2026-07-23T08:00:00.000Z',
    adapters: ['fake'],
    stages: [{ stage: 'build', status: 'pass', durationMs: 3 }],
    ...(debt ? { debt } : {}),
  };
  saveProjectBaseline(db, pid, legacy.adapters, JSON.stringify(legacy));
  return legacy;
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

  it("records origin's URL on the project row, raw", () => {
    addOrigin(repo);
    // The rewrite `remote get-url` would apply and `config --get` does not:
    // recording the rewritten value would record whatever a session had
    // already aimed the repo at (decisions 54, 56).
    sh(repo, 'git', 'config', 'url./tmp/elsewhere/.insteadOf', ORIGIN_URL);

    const report = initProject(db, repo, [makeAdapter()]);

    expect(getProject(db, projectId(repo))?.origin_url).toBe(ORIGIN_URL);
    expect(report.findings).toEqual([]);
  });

  it('refuses to record a URL nobody could have typed', () => {
    // Terminal escapes in a remote URL repaint whatever is printed around it,
    // and a stored one would be reprinted on every init and audit.
    addOrigin(repo, `${ORIGIN_URL}\u001b[2Aowned`);

    const report = initProject(db, repo, [makeAdapter()]);

    expect(getProject(db, projectId(repo))?.origin_url).toBeNull();
    expect(report.findings[0]).toContain('not a URL anyone could have typed');
  });

  it('holds the first record on a project whose sessions could have written it', () => {
    addOrigin(repo);
    const pid = projectId(repo);
    ensureProject(db, pid, repo);
    insertTask(db, { id: 't1', projectId: pid, spec: '{}' });
    insertSession(db, {
      id: 's1',
      taskId: 't1',
      worktreePath: join(repo, '.worktrees', 's1'),
      branch: 'pup/s1',
      profileHash: 'h',
    });

    const held = initProject(db, repo, [makeAdapter()]);

    expect(getProject(db, pid)?.origin_url).toBeNull();
    expect(held.findings[0]).toContain('--origin-moved');
    // The flag is how the operator confirms it, first record or later move.
    const confirmed = initProject(db, repo, [makeAdapter()], undefined, 're-record');
    expect(getProject(db, pid)?.origin_url).toBe(ORIGIN_URL);
    expect(confirmed.findings).toEqual([]);
  });

  it('records nothing when the repo has no origin', () => {
    sh(repo, 'git', 'init', '-b', 'main');

    initProject(db, repo, [makeAdapter()]);

    expect(getProject(db, projectId(repo))?.origin_url).toBeNull();
  });

  it('keeps the recorded push target when origin now says something else, and says so', () => {
    addOrigin(repo);
    initProject(db, repo, [makeAdapter()]);
    sh(repo, 'git', 'config', 'remote.origin.url', 'git@github.com:attacker/repo.git');

    const report = initProject(db, repo, [makeAdapter()]);

    expect(getProject(db, projectId(repo))?.origin_url).toBe(ORIGIN_URL);
    expect(report.findings).toEqual([expect.stringContaining('git@github.com:attacker/repo.git')]);
    expect(report.findings[0]).toContain('--origin-moved');
  });

  it('re-records the push target when the operator says origin moved', () => {
    addOrigin(repo);
    initProject(db, repo, [makeAdapter()]);
    sh(repo, 'git', 'config', 'remote.origin.url', 'git@github.com:owner/renamed.git');

    const report = initProject(db, repo, [makeAdapter()], undefined, 're-record');

    expect(getProject(db, projectId(repo))?.origin_url).toBe('git@github.com:owner/renamed.git');
    expect(report.findings).toEqual([]);
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
      duplicationRule: DUPLICATION_RULE_ID,
    });
  });

  it('captures the repo coverage ratio when the adapter can measure it', () => {
    const adapter = makeAdapter({
      coverage: () => ({ files: { 'src/a.ts': { covered: [1], instrumented: [1, 2] } } }),
    });

    initProject(db, repo, [adapter]);

    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt?.coverageRatio).toBe(0.5);
  });

  it('leaves debt metrics out of the baseline when no adapter can measure them', () => {
    initProject(db, repo, [makeAdapter()]);

    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt).toBeUndefined();
  });

  it('does not store an empty dead-export baseline when the tooling is unavailable', () => {
    initProject(db, repo, [makeAdapter({ deadCode: () => ({ unavailable: 'vulture missing' }) })]);

    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt?.deadExports).toBeUndefined();
  });

  it('reports why a capability could not measure, so the gap is visible before any session', () => {
    const report = initProject(db, repo, [
      makeAdapter({ deadCode: () => ({ unavailable: 'vulture missing' }) }),
    ]);

    expect(report.findings).toContainEqual(expect.stringContaining('vulture missing'));
  });

  it('stores an empty dead-export baseline when the tooling measured and found nothing', () => {
    // [] is a measurement: it becomes the bar every later session is held to.
    initProject(db, repo, [makeAdapter({ deadCode: () => [] })]);

    const stored = JSON.parse(getProject(db, projectId(repo))?.baseline ?? '{}') as ProjectBaseline;
    expect(stored.debt?.deadExports).toEqual([]);
  });

  it('stores nothing when the package manager itself cannot load from the toolchain cache', () => {
    // The poisoned shape: a corepack install with an empty bin/. The repair
    // moves it aside before the child runs, and the stage still runs the path
    // it was handed, so the crash is Node's real missing-entrypoint banner.
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pup-cache-root-')));
    vi.stubEnv('TMPDIR', tmp);
    const install = join(
      tmp,
      'pup-toolchain-cache',
      projectId(repo),
      'corepack',
      'v1',
      'pnpm',
      '10.34.5',
    );
    mkdirSync(join(install, 'bin'), { recursive: true });
    const pnpm = { command: 'node', args: [join(install, 'bin', 'pnpm.cjs')] };
    const adapter = makeAdapter({
      gateCommands: () => [
        { stage: 'build', ...pnpm },
        { stage: 'test', ...pnpm },
        { stage: 'lint', ...pnpm },
      ],
    });

    try {
      expect(() => initProject(db, repo, [adapter])).toThrow(BrokenToolchainError);
      expect(() => initProject(db, repo, [adapter])).toThrow(install);
    } finally {
      vi.unstubAllEnvs();
      rmSync(tmp, { recursive: true, force: true });
    }
    expect(getProject(db, projectId(repo))?.baseline).toBeNull();
    expect(listBaselineHistory(db, projectId(repo))).toEqual([]);
  });

  it('throws when no adapter detects the repo', () => {
    const adapter = makeAdapter({ detect: () => false });
    expect(() => initProject(db, repo, [adapter])).toThrow(NoAdapterError);
  });

  it('appends a history row for every capture, first init included', () => {
    const first = initProject(db, repo, [
      makeAdapter({ duplication: () => ({ duplicatedLines: 12, blocks: [] }) }),
    ]);
    const second = initProject(db, repo, [makeAdapter()]);

    const history = listBaselineHistory(db, projectId(repo));
    expect(history.map((r) => r.captured_at)).toEqual([
      first.baseline.capturedAt,
      second.baseline.capturedAt,
    ]);
    expect(JSON.parse(history[0]?.debt ?? '{}')).toEqual({
      duplicatedLines: 12,
      duplicationRule: DUPLICATION_RULE_ID,
    });
    expect(history[1]?.debt).toBeNull();
  });

  it('backfills a baseline stored before the history table existed, before overwriting it', () => {
    const pid = projectId(repo);
    const legacy = seedPreHistoryBaseline(db, pid, repo, { duplicatedLines: 184 });

    const report = initProject(db, repo, [makeAdapter()]);

    const history = listBaselineHistory(db, pid);
    expect(history.map((r) => r.captured_at)).toEqual([
      legacy.capturedAt,
      report.baseline.capturedAt,
    ]);
    expect(JSON.parse(history[0]?.debt ?? '{}')).toEqual({ duplicatedLines: 184 });
  });

  it('does not seed the same pre-history baseline twice across re-runs', () => {
    const pid = projectId(repo);
    const legacy = seedPreHistoryBaseline(db, pid, repo);

    const first = initProject(db, repo, [makeAdapter()]);
    const second = initProject(db, repo, [makeAdapter()]);

    // Exactly one row per capture: an unguarded backfill would re-append the
    // first run's baseline on the second run, not the legacy one.
    expect(listBaselineHistory(db, pid).map((r) => r.captured_at)).toEqual([
      legacy.capturedAt,
      first.baseline.capturedAt,
      second.baseline.capturedAt,
    ]);
  });
});
