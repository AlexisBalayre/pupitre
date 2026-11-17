import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionState } from './db.client.js';
import { openStore } from './db.client.js';
import { projectId } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  insertSession,
  insertTask,
  transitionSession,
} from './session.repository.js';
import {
  assertLaunchRoom,
  type LockBacklog,
  LockBacklogOverBudgetError,
  launchRoomLines,
  lockBacklog,
  MachineLoadedError,
  machineLoad,
  UNTIMED_GATE_MS,
} from './session-cap.service.js';

const PR = 'https://github.com/o/r/pull/1';

describe('lockBacklog (decision 197)', () => {
  let db: Database;
  let repo: string;
  let seeded: number;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = tempDir('pup-session-cap-');
    ensureProject(db, projectId(repo), repo);
    seeded = 0;
  });

  /** A session walked through `path`, its states in order from `queued`; its id. */
  function session(...path: SessionState[]): string {
    const id = `s${seeded++}`;
    insertTask(db, { id: `t-${id}`, projectId: projectId(repo), spec: '{}' });
    insertSession(db, {
      id,
      taskId: `t-${id}`,
      worktreePath: join(repo, '.worktrees', id),
      branch: `pup/${id}`,
      profileHash: 'hash',
    });
    for (const state of path) transitionSession(db, id, state);
    return id;
  }

  const merged = () => session('running', 'awaiting-review', 'merged');

  /** A gate run on `id` whose stages took `stageMs`. */
  function gateRun(id: string, ...stageMs: unknown[]): void {
    db.prepare("INSERT INTO events (session_id, type, payload) VALUES (?, 'gate_result', ?)").run(
      id,
      JSON.stringify({
        from: 'awaiting-review',
        to: 'merged',
        report: {
          sessionId: id,
          passed: true,
          sandbox: 'none',
          stages: stageMs.map((durationMs, index) => ({
            stage: `stage-${index}`,
            status: 'pass',
            durationMs,
          })),
        },
      }),
    );
  }

  function mergeEvent(id: string, prUrl?: string): void {
    appendEvent(db, id, 'merge', {
      branch: `pup/${id}`,
      sha: 'abc',
      target: 'main',
      files: [],
      ...(prUrl === undefined ? {} : { prUrl }),
    });
  }

  it('reads nothing queued, at the untimed gate and the default budget, on an empty store', () => {
    expect(lockBacklog(db, repo)).toEqual({
      minutes: 0,
      budgetMinutes: 60,
      uses: 0,
      gateMs: UNTIMED_GATE_MS,
      gatesTimed: 0,
    });
  });

  it.each<[string, SessionState[]]>([
    ['queued', []],
    // A fix round puts a merged session back in `running` (`FIX_ROUND_EDGE`).
    ['running or in a fix round', ['running']],
    ['awaiting its first gate', ['running', 'awaiting-review']],
    ['rejected', ['running', 'awaiting-review', 'rejected']],
    ['blocked', ['running', 'blocked']],
  ])('counts a gate and a land for a session %s', (_name, path) => {
    session(...path);

    expect(lockBacklog(db, repo).uses).toBe(2);
  });

  it('counts a land for a merged session whose PR has not landed', () => {
    mergeEvent(merged(), PR);

    expect(lockBacklog(db, repo).uses).toBe(1);
  });

  it('counts nothing for a merge that moved the target itself', () => {
    mergeEvent(merged());

    expect(lockBacklog(db, repo).uses).toBe(0);
  });

  it.each([
    [
      'landed',
      (id: string) => appendEvent(db, id, 'landed', { sha: 'def', target: 'main', prUrl: PR }),
    ],
    [
      'retired',
      (id: string) => appendEvent(db, id, 'retired', { prUrl: PR, supersededBy: `${PR}0` }),
    ],
    [
      'closed unmerged',
      (id: string) => appendEvent(db, id, 'pr_closed', { prUrl: PR, sha: 'abc' }),
    ],
  ])('counts nothing once its PR is %s', (_name, close) => {
    const id = merged();
    mergeEvent(id, PR);
    close(id);

    expect(lockBacklog(db, repo).uses).toBe(0);
  });

  it('counts the land again for a re-gate after an earlier land', () => {
    const id = merged();
    mergeEvent(id, PR);
    appendEvent(db, id, 'landed', { sha: 'def', target: 'main', prUrl: PR });
    mergeEvent(id, PR);

    expect(lockBacklog(db, repo).uses).toBe(1);
  });

  it('counts nothing for a killed session, nor a merged one with no merge recorded', () => {
    session('running', 'killed');
    merged();

    expect(lockBacklog(db, repo).uses).toBe(0);
  });

  it('times each run by its longest stage, the stages running alongside one another', () => {
    const id = session('running', 'killed');
    gateRun(id, 60_000, 300_000, 120_000);

    expect(lockBacklog(db, repo)).toMatchObject({ gateMs: 300_000, gatesTimed: 1 });
  });

  it('takes the median over the newest 30 timed runs', () => {
    const id = session('running', 'killed');
    for (let run = 0; run < 30; run++) gateRun(id, 20 * 60_000);
    for (let run = 0; run < 30; run++) gateRun(id, 2 * 60_000);
    session('running');

    expect(lockBacklog(db, repo)).toEqual({
      minutes: 4,
      budgetMinutes: 60,
      uses: 2,
      gateMs: 2 * 60_000,
      gatesTimed: 30,
    });
  });

  it('passes over a run with no time, or one a session wrote out of shape', () => {
    const id = session('running', 'killed');
    gateRun(id, 600_000);
    gateRun(id);
    gateRun(id, '900000', -1, null, Number.POSITIVE_INFINITY);
    db.prepare("INSERT INTO events (session_id, type, payload) VALUES (?, 'gate_result', ?)").run(
      id,
      'not json',
    );
    db.prepare("INSERT INTO events (session_id, type, payload) VALUES (?, 'gate_result', ?)").run(
      id,
      JSON.stringify({ report: { stages: 'many' } }),
    );

    // The transitions' own gate_result events carry no report and are passed over too.
    expect(lockBacklog(db, repo)).toMatchObject({ gateMs: 600_000, gatesTimed: 1 });
  });

  it("reads the project's budget", () => {
    mkdirSync(join(repo, '.pupitre'));
    writeFileSync(join(repo, '.pupitre', 'project.yml'), 'lockBacklogBudgetMinutes: 25\n');

    expect(lockBacklog(db, repo).budgetMinutes).toBe(25);
  });
});

describe('the launch room (decision 197)', () => {
  const backlog = (minutes: number, overrides: Partial<LockBacklog> = {}): LockBacklog => ({
    minutes,
    budgetMinutes: 60,
    uses: minutes / 10,
    gateMs: 600_000,
    gatesTimed: 30,
    ...overrides,
  });
  const idle = { average: 1, cores: 8 };

  it('allows a launch with the backlog at its budget and the load at the cores', () => {
    expect(() =>
      assertLaunchRoom({ backlog: backlog(60), load: { average: 8, cores: 8 } }),
    ).not.toThrow();
  });

  it('refuses over the budget, naming the backlog, its budget and its terms', () => {
    expect(() => assertLaunchRoom({ backlog: backlog(70), load: idle })).toThrow(
      new LockBacklogOverBudgetError(backlog(70)),
    );
    expect(new LockBacklogOverBudgetError(backlog(70)).message).toBe(
      "The merge lock's backlog is 70 minutes, over the project's budget of 60 (7 gates and " +
        'lands to go at 10 minutes, the median of the last 30 gates); nothing was launched. ' +
        'lockBacklogBudgetMinutes in .pupitre/project.yml sets the budget; only the ' +
        "operator's --over-cap goes beyond.",
    );
  });

  // The CLI prints a refusal clipped at 300 characters (`sanitizeReason`).
  it('keeps a refusal whole at extreme figures', () => {
    const huge = backlog(1437.5, { uses: 115, gateMs: 750_000, budgetMinutes: 120.5 });

    expect(new LockBacklogOverBudgetError(huge).message.length).toBeLessThanOrEqual(300);
    expect(
      new LockBacklogOverBudgetError({ ...huge, gateMs: UNTIMED_GATE_MS, gatesTimed: 0 }).message
        .length,
    ).toBeLessThanOrEqual(300);
    expect(new MachineLoadedError({ average: 1234.5, cores: 1024 }).message.length).toBeLessThan(
      300,
    );
  });

  it('refuses above the cores, naming the load and the cores', () => {
    expect(() =>
      assertLaunchRoom({ backlog: backlog(10), load: { average: 8.04, cores: 8 } }),
    ).toThrow(
      "The machine's 1-minute load average is 8.0, above its 8 cores; nothing was launched. " +
        "Wait for the load to fall; only the operator's --over-cap goes beyond.",
    );
    expect(() =>
      assertLaunchRoom({ backlog: backlog(10), load: { average: 9, cores: 8 } }),
    ).toThrow(MachineLoadedError);
  });

  it('names the backlog first when both are past their limits', () => {
    expect(() =>
      assertLaunchRoom({ backlog: backlog(70), load: { average: 9, cores: 8 } }),
    ).toThrow(LockBacklogOverBudgetError);
  });

  it('prints both signals and the verdict for `pup status`', () => {
    expect(launchRoomLines({ backlog: backlog(20), load: { average: 2.345, cores: 10 } })).toEqual([
      'Launch: allowed',
      '  merge-lock backlog: 20 of 60 minutes (2 gates and lands to go at 10 minutes, the median of the last 30 gates)',
      '  load: 2.3 of 10 cores',
    ]);
    expect(
      launchRoomLines({
        backlog: backlog(62.5, { uses: 5, gateMs: 750_000, gatesTimed: 3 }),
        load: { average: 9, cores: 8 },
      }),
    ).toEqual([
      "Launch: refused (merge-lock backlog over budget, load above the cores); only the operator's --over-cap goes beyond",
      '  merge-lock backlog: 62.5 of 60 minutes (5 gates and lands to go at 12.5 minutes, the median of the last 3 gates)',
      '  load: 9.0 of 8 cores',
    ]);
  });

  it('reads the load against the cores the machine offers', () => {
    const load = machineLoad();

    expect(load.average).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(load.cores) && load.cores >= 1).toBe(true);
  });
});
