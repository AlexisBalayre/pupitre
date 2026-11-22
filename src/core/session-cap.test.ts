import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from './db.client.js';
import { EventType } from './enums/event-type.enums.js';
import { GateStageStatus } from './enums/gate-stage-status.enums.js';
import { MergeStatus } from './enums/merge-status.enums.js';
import { SessionState } from './enums/session-state.enums.js';
import { LockBacklogOverBudgetError, MachineLoadedError } from './errors/session-cap.errors.js';
import { projectId, projectPaths } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  insertSession,
  insertTask,
  transitionSession,
} from './session.repository.js';
import {
  assertLaunchRoom,
  GATE_CEILING_MS,
  GATE_FLOOR_MS,
  LAND_WINDOW_MS,
  launchHolds,
  launchRoom,
  launchRoomLines,
  lockBacklog,
  machineLoad,
  UNTIMED_GATE_MS,
} from './session-cap.service.js';
import type { LockBacklog } from './types/session-cap.types.js';

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

  const merged = () =>
    session(SessionState.Running, SessionState.AwaitingReview, SessionState.Merged);

  /** A gate run on `id` whose stages took `stageMs`, written as the gate's verdict `edge`. */
  function gateRun(id: string, ...stageMs: unknown[]): void {
    gateReport(id, { from: SessionState.AwaitingReview, to: SessionState.Merged }, ...stageMs);
  }

  function gateReport(id: string, edge: object, ...stageMs: unknown[]): void {
    db.prepare(
      `INSERT INTO events (session_id, type, payload) VALUES (?, '${EventType.GateResult}', ?)`,
    ).run(
      id,
      JSON.stringify({
        ...edge,
        report: {
          sessionId: id,
          passed: true,
          sandbox: 'none',
          stages: stageMs.map((durationMs, index) => ({
            stage: `stage-${index}`,
            status: GateStageStatus.Pass,
            durationMs,
          })),
        },
      }),
    );
  }

  function mergeEvent(id: string, prUrl?: string): void {
    appendEvent(db, id, EventType.Merge, {
      branch: `pup/${id}`,
      sha: 'abc',
      target: 'main',
      files: [],
      ...(prUrl === undefined ? {} : { prUrl }),
    });
  }

  /** Back-date `id`'s events by `ms`, as a store holding older history has them. */
  function age(id: string, ms: number): void {
    db.prepare("UPDATE events SET created_at = datetime('now', ?) WHERE session_id = ?").run(
      `-${Math.round(ms / 1000)} seconds`,
      id,
    );
  }

  it('reads nothing queued, at the untimed gate and the default budget, on an empty store', () => {
    expect(lockBacklog(db, repo)).toEqual({
      minutes: 0,
      budgetMinutes: 60,
      uses: 0,
      gateMs: UNTIMED_GATE_MS,
      gatesTimed: 0,
      unlanded: [],
    });
  });

  it.each<[string, SessionState[]]>([
    [SessionState.Queued, []],
    // A fix round puts a merged session back in `running` (`FIX_ROUND_EDGE`).
    ['running or in a fix round', [SessionState.Running]],
    [
      SessionState.Rejected,
      [SessionState.Running, SessionState.AwaitingReview, SessionState.Rejected],
    ],
    [SessionState.Blocked, [SessionState.Running, SessionState.Blocked]],
  ])('counts a gate and a land for a session %s', (_name, path) => {
    session(...path);

    expect(lockBacklog(db, repo).uses).toBe(2);
  });

  // Decision 144: a session in review costs memory, not turns.
  it('counts nothing for a session awaiting review', () => {
    session(SessionState.Running, SessionState.AwaitingReview);

    expect(lockBacklog(db, repo).uses).toBe(0);
  });

  it('counts a land for a merged session whose PR has not landed, and names it', () => {
    const id = merged();
    mergeEvent(id, PR);

    expect(lockBacklog(db, repo)).toMatchObject({ uses: 1, unlanded: [id] });
  });

  // A PR merged in GitHub's UI, or one `pup land` refused, records no land.
  it('counts no land for a merge older than the window', () => {
    const recent = merged();
    mergeEvent(recent, PR);
    age(recent, LAND_WINDOW_MS - 60 * 60_000);
    const stale = merged();
    mergeEvent(stale, PR);
    age(stale, LAND_WINDOW_MS + 60_000);

    expect(lockBacklog(db, repo)).toMatchObject({ uses: 1, unlanded: [recent] });
  });

  // A time that does not parse is counted, never hidden.
  it('counts a land for a merge whose time does not parse', () => {
    const id = merged();
    mergeEvent(id, PR);
    db.prepare("UPDATE events SET created_at = 'garbage' WHERE session_id = ?").run(id);

    expect(lockBacklog(db, repo)).toMatchObject({ uses: 1, unlanded: [id] });
  });

  // A blob reads back as a Buffer, which toIsoUtc cannot rewrite.
  it('counts a land for a merge whose time is not text', () => {
    const id = merged();
    mergeEvent(id, PR);
    db.prepare(
      "UPDATE events SET created_at = CAST('2026-11-17 10:00:00' AS BLOB) WHERE session_id = ?",
    ).run(id);

    expect(lockBacklog(db, repo)).toMatchObject({ uses: 1, unlanded: [id] });
  });

  it('counts nothing for a merge that moved the target itself', () => {
    mergeEvent(merged());

    expect(lockBacklog(db, repo).uses).toBe(0);
  });

  it.each([
    [
      'landed',
      (id: string) =>
        appendEvent(db, id, EventType.Landed, { sha: 'def', target: 'main', prUrl: PR }),
    ],
    [
      'retired',
      (id: string) => appendEvent(db, id, EventType.Retired, { prUrl: PR, supersededBy: `${PR}0` }),
    ],
    [
      'closed unmerged',
      (id: string) => appendEvent(db, id, EventType.PrClosed, { prUrl: PR, sha: 'abc' }),
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
    appendEvent(db, id, EventType.Landed, { sha: 'def', target: 'main', prUrl: PR });
    mergeEvent(id, PR);

    expect(lockBacklog(db, repo).uses).toBe(1);
  });

  it('counts nothing for a killed session, nor a merged one with no merge recorded', () => {
    session(SessionState.Running, SessionState.Killed);
    merged();

    expect(lockBacklog(db, repo).uses).toBe(0);
  });

  it('times each run by its longest stage, the stages running alongside one another', () => {
    const id = session(SessionState.Running, SessionState.Killed);
    gateRun(id, 60_000, 300_000, 120_000);

    expect(lockBacklog(db, repo)).toMatchObject({ gateMs: 300_000, gatesTimed: 1 });
  });

  it('takes the median over the newest 30 timed runs', () => {
    const id = session(SessionState.Running, SessionState.Killed);
    for (let run = 0; run < 30; run++) gateRun(id, 20 * 60_000);
    for (let run = 0; run < 30; run++) gateRun(id, 5 * 60_000);
    session(SessionState.Running);

    expect(lockBacklog(db, repo)).toEqual({
      minutes: 10,
      budgetMinutes: 60,
      uses: 2,
      gateMs: 5 * 60_000,
      gatesTimed: 30,
      unlanded: [],
    });
  });

  // The reports are session-writable: a forged median neither turns the backlog off nor holds every launch.
  it.each([
    ['zero', 0, GATE_FLOOR_MS],
    ['under the floor', GATE_FLOOR_MS - 1, GATE_FLOOR_MS],
    ['huge', 1e12, GATE_CEILING_MS],
  ])('holds a %s median to its bounds', (_name, forged, bound) => {
    const id = session(SessionState.Running, SessionState.Killed);
    for (let run = 0; run < 30; run++) gateRun(id, forged);
    for (let live = 0; live < 8; live++) session(SessionState.Running);

    expect(lockBacklog(db, repo)).toMatchObject({
      gateMs: bound,
      minutes: (16 * bound) / 60_000,
      gatesTimed: 30,
    });
  });

  it('reads at most 64 stages of a report', () => {
    const id = session(SessionState.Running, SessionState.Killed);
    const stages: number[] = Array.from({ length: 100 }, () => 5 * 60_000);
    stages[80] = 50 * 60_000;
    gateRun(id, ...stages);

    expect(lockBacklog(db, repo).gateMs).toBe(5 * 60_000);
  });

  it('passes over a run with no time, or one a session wrote out of shape', () => {
    const id = session(SessionState.Running, SessionState.Killed);
    gateRun(id, 600_000);
    gateRun(id);
    gateRun(id, '900000', -1, null, Number.POSITIVE_INFINITY);
    db.prepare(
      `INSERT INTO events (session_id, type, payload) VALUES (?, '${EventType.GateResult}', ?)`,
    ).run(id, 'not json');
    db.prepare(
      `INSERT INTO events (session_id, type, payload) VALUES (?, '${EventType.GateResult}', ?)`,
    ).run(id, JSON.stringify({ report: { stages: 'many' } }));

    // The transitions' own gate_result events carry no report and are passed over too.
    expect(lockBacklog(db, repo)).toMatchObject({ gateMs: 600_000, gatesTimed: 1 });
  });

  it("reads only a report shaped like the gate's verdict on a session in review", () => {
    const id = session(SessionState.Running, SessionState.Killed);
    gateRun(id, 600_000);
    gateReport(id, { from: SessionState.AwaitingReview, to: SessionState.Rejected }, 900_000);
    gateReport(id, {}, 0);
    gateReport(id, { outcome: MergeStatus.Refused }, 0);
    gateReport(id, { from: SessionState.Merged, to: SessionState.Merged }, 0);
    gateReport(id, { from: SessionState.Blocked, to: SessionState.Running }, 0);
    gateReport(id, { from: SessionState.AwaitingReview, to: SessionState.Killed }, 0);

    expect(lockBacklog(db, repo)).toMatchObject({ gateMs: 600_000, gatesTimed: 2 });
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
    unlanded: [],
    ...overrides,
  });
  const idle = { average: 1, cores: 8, factor: 1 };
  /** Memory above the floor and no usage hold: only the two signals decide. */
  const clear = { memoryBytes: 16 * 1024 ** 3, usageHeld: false };

  it('allows a launch with the backlog at its budget and the load at the cores', () => {
    expect(() =>
      assertLaunchRoom({ backlog: backlog(60), load: { average: 8, cores: 8, factor: 1 } }),
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
    expect(
      new MachineLoadedError({ average: 1234.5, cores: 1024, factor: 1 }).message.length,
    ).toBeLessThan(300);
  });

  it('refuses above the cores, naming the load and the cores', () => {
    expect(() =>
      assertLaunchRoom({ backlog: backlog(10), load: { average: 8.04, cores: 8, factor: 1 } }),
    ).toThrow(
      "The machine's 1-minute load average is 8.0, above its 8 cores; nothing was launched. " +
        "Wait for the load to fall; only the operator's --over-cap goes beyond.",
    );
    expect(() =>
      assertLaunchRoom({ backlog: backlog(10), load: { average: 9, cores: 8, factor: 1 } }),
    ).toThrow(MachineLoadedError);
  });

  // A fix round has no --over-cap to offer.
  it('words a fix round refused on the load as one to run again', () => {
    expect(new MachineLoadedError({ average: 9, cores: 8, factor: 1 }, 'fix round').message).toBe(
      "The machine's 1-minute load average is 9.0, above its 8 cores; the fix round was not " +
        'started. Wait for the load to fall, then run it again.',
    );
  });

  it('names the backlog first when both are past their limits', () => {
    expect(() =>
      assertLaunchRoom({ backlog: backlog(70), load: { average: 9, cores: 8, factor: 1 } }),
    ).toThrow(LockBacklogOverBudgetError);
  });

  it('prints both signals and the verdict for `pup status`', () => {
    expect(
      launchRoomLines(
        { backlog: backlog(20), load: { average: 2.345, cores: 10, factor: 1 } },
        clear,
      ),
    ).toEqual([
      'Launch: allowed',
      '  merge-lock backlog: 20 of 60 minutes (2 gates and lands to go at 10 minutes, the median of the last 30 gates)',
      '  load: 2.3 of 10 cores',
      '  memory: 16.0 GB available, 1.5 GB a launch needs',
    ]);
    expect(
      launchRoomLines(
        {
          backlog: backlog(62.5, { uses: 5, gateMs: 750_000, gatesTimed: 3 }),
          load: { average: 9, cores: 8, factor: 1 },
        },
        clear,
      ),
    ).toEqual([
      "Launch: refused (merge-lock backlog over budget, load above the cores); only the operator's --over-cap lifts the backlog and the load",
      '  merge-lock backlog: 62.5 of 60 minutes (5 gates and lands to go at 12.5 minutes, the median of the last 3 gates)',
      '  load: 9.0 of 8 cores',
      '  memory: 16.0 GB available, 1.5 GB a launch needs',
    ]);
  });

  // `pup launch` refuses on the memory floor and the usage hold too, so the
  // verdict never reads allowed while either would refuse it.
  it('refuses in the verdict under the memory floor and while the usage holds launches', () => {
    const room = { backlog: backlog(20), load: idle };

    expect(launchRoomLines(room, { memoryBytes: 1.2 * 1024 ** 3, usageHeld: false })).toEqual([
      'Launch: refused (under 1.5 GB of memory available)',
      '  merge-lock backlog: 20 of 60 minutes (2 gates and lands to go at 10 minutes, the median of the last 30 gates)',
      '  load: 1.0 of 8 cores',
      '  memory: 1.2 GB available, 1.5 GB a launch needs',
    ]);
    expect(launchRoomLines(room, { ...clear, usageHeld: true })[0]).toBe(
      "Launch: refused (the plan's usage at its hold line); only the operator's --over-limit the usage hold",
    );
    expect(
      launchRoomLines(
        { backlog: backlog(70), load: idle },
        { memoryBytes: 1024 ** 3, usageHeld: true },
      )[0],
    ).toBe(
      "Launch: refused (merge-lock backlog over budget, under 1.5 GB of memory available, the plan's " +
        "usage at its hold line); only the operator's --over-cap lifts the backlog and the load, " +
        '--over-limit the usage hold',
    );
    expect(launchRoomLines(room, { ...clear, memoryBytes: 1.5 * 1024 ** 3 })[0]).toBe(
      'Launch: allowed',
    );
  });

  it('names the merged sessions counted for a land, up to 8', () => {
    const ids = Array.from({ length: 10 }, (_, index) => `t-${index}`);

    expect(
      launchRoomLines(
        { backlog: backlog(20, { unlanded: ids.slice(0, 2) }), load: idle },
        clear,
      )[2],
    ).toBe('    awaiting a land: t-0, t-1 (`pup land` records each, --abandon-closed a closed PR)');
    expect(launchRoomLines({ backlog: backlog(20, { unlanded: ids }), load: idle }, clear)[2]).toBe(
      '    awaiting a land: t-0, t-1, t-2, t-3, t-4, t-5, t-6, t-7 and 2 more (`pup land` ' +
        'records each, --abandon-closed a closed PR)',
    );
  });

  // The store is session-writable: an id with an escape could fake the Launch line.
  it('counts an id that is not printable as unnamed rather than print it', () => {
    const forged = '\u001b[1A\u001b[2KLaunch: allowed';
    const line = (unlanded: string[]) =>
      launchRoomLines({ backlog: backlog(20, { unlanded }), load: idle }, clear)[2];

    expect(line(['t-0', forged])).toBe(
      '    awaiting a land: t-0 and 1 unnamed (`pup land` records each, --abandon-closed a closed PR)',
    );
    expect(line([forged])).toBe(
      '    awaiting a land: 1 unnamed (`pup land` records each, --abandon-closed a closed PR)',
    );
    expect(line(['t-0', forged])).not.toContain('\u001b');
  });

  describe('launchHolds', () => {
    const REPO = '/repo';

    beforeEach(() => {
      vi.stubEnv('HOME', tempDir('pup-session-cap-home-'));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('reads the usage hold from a fresh reading at its hold line, and the memory available', () => {
      expect(launchHolds(REPO).usageHeld).toBe(false);

      const file = projectPaths(REPO).usageFile;
      mkdirSync(dirname(file), { recursive: true });
      const resetsAt = Math.floor(Date.now() / 1000) + 3600;
      writeFileSync(
        file,
        JSON.stringify({ seven_day: { used_percentage: 90, resets_at: resetsAt } }),
      );
      const holds = launchHolds(REPO);

      expect(holds.usageHeld).toBe(true);
      expect(holds.memoryBytes).toBeGreaterThan(0);
    });
  });

  it('reads the load against the cores the machine offers', () => {
    const load = machineLoad();

    expect(load.average).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(load.cores) && load.cores >= 1).toBe(true);
  });
});

describe("the project's loadAllowanceFactor (decision 197's amendment of 2026-11-20)", () => {
  const clear = { memoryBytes: 16 * 1024 ** 3, usageHeld: false };
  let db: Database;
  let repo: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = tempDir('pup-session-cap-factor-');
    ensureProject(db, projectId(repo), repo);
    mkdirSync(join(repo, '.pupitre'));
  });

  const roomAt = (average: number) => launchRoom(db, repo, { average, cores: 8 });

  it('allows a launch at 11 and refuses one at 13 on 8 cores at 1.5, naming the factor', () => {
    writeFileSync(join(repo, '.pupitre', 'project.yml'), 'loadAllowanceFactor: 1.5\n');

    expect(() => assertLaunchRoom(roomAt(11))).not.toThrow();
    expect(launchRoomLines(roomAt(11), clear).slice(0, 1)).toEqual(['Launch: allowed']);
    expect(launchRoomLines(roomAt(11), clear)[2]).toBe(
      '  load: 11.0 of 8 cores times loadAllowanceFactor 1.5 (12)',
    );
    expect(() => assertLaunchRoom(roomAt(13))).toThrow(
      "The machine's 1-minute load average is 13.0, above its 8 cores times loadAllowanceFactor " +
        "1.5 (12); nothing was launched. Wait for the load to fall; only the operator's " +
        '--over-cap goes beyond.',
    );
    expect(launchRoomLines(roomAt(13), clear)[0]).toBe(
      "Launch: refused (load above the allowance); only the operator's --over-cap lifts the backlog and the load",
    );
  });

  it('holds the load to the cores with no factor set or one outside 1 to 3', () => {
    expect(roomAt(9).load.factor).toBe(1);
    expect(() => assertLaunchRoom(roomAt(9))).toThrow(MachineLoadedError);
    for (const value of ['0.5', '3.5', 'lots', 'true', '[2]']) {
      writeFileSync(join(repo, '.pupitre', 'project.yml'), `loadAllowanceFactor: ${value}\n`);

      expect(roomAt(9).load.factor).toBe(1);
    }
  });

  it('prints the factor as written and the product to two decimals', () => {
    writeFileSync(join(repo, '.pupitre', 'project.yml'), 'loadAllowanceFactor: 1.25\n');
    const room = launchRoom(db, repo, { average: 9, cores: 6 });

    expect(room.load.factor).toBe(1.25);
    expect(launchRoomLines(room, clear)[2]).toBe(
      '  load: 9.0 of 6 cores times loadAllowanceFactor 1.25 (7.5)',
    );
    expect(() => assertLaunchRoom(room)).toThrow(
      'above its 6 cores times loadAllowanceFactor 1.25 (7.5);',
    );
    expect(new MachineLoadedError({ average: 20, cores: 6, factor: 2.75 }).message).toContain(
      '6 cores times loadAllowanceFactor 2.75 (16.5)',
    );
    expect(new MachineLoadedError({ average: 20, cores: 7, factor: 1.125 }).message).toContain(
      '7 cores times loadAllowanceFactor 1.125 (7.88)',
    );
  });

  it('keeps a refusal naming the factor whole at extreme figures', () => {
    expect(
      new MachineLoadedError({ average: 1234.5, cores: 1024, factor: 2.75 }).message.length,
    ).toBeLessThan(300);
  });
});
