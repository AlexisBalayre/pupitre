import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux boundary only: the snapshot asks whether a conductor window exists.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  hasConductorWindow: vi.fn(() => false),
}));

import { openStore } from './db.client.js';
import { fleetReading, readFleet } from './fleet.service.js';
import { projectId } from './paths.utils.js';
import { ensureProject, insertTask } from './session.repository.js';

const NOW = Date.parse('2026-09-22T12:00:00Z');

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A registry row for `repoPath`, as `listRegisteredProjects` reads one back. */
function registered(
  repoPath: string,
  overrides: { dormantAt?: string | null; repoExists?: boolean; isOwnPath?: boolean } = {},
) {
  const dbFile = join(tempDir('pup-fleet-store-'), 'state.db');
  const db = openStore(dbFile);
  ensureProject(db, projectId(repoPath), repoPath);
  db.close();
  return {
    id: projectId(repoPath),
    repoPath,
    dbFile,
    repoExists: true,
    isOwnPath: true,
    dormantAt: null,
    ...overrides,
  };
}

/** A store no `openStore` has touched: anything that opens it leaves migrations behind. */
function bareStore(repoPath: string): string {
  const dir = tempDir('pup-fleet-bare-');
  const dbFile = join(dir, 'state.db');
  const bare = new BetterSqlite3(dbFile);
  bare.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, repo_path TEXT NOT NULL)');
  bare.prepare('INSERT INTO projects VALUES (?, ?)').run(projectId(repoPath), repoPath);
  bare.close();
  return dbFile;
}

function tablesOf(dbFile: string): string[] {
  const db = new BetterSqlite3(dbFile, { readonly: true });
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  db.close();
  return rows.map((row) => row.name);
}

beforeEach(() => {
  // The snapshot resolves the sessions directory under homedir().
  vi.stubEnv('HOME', tempDir('pup-fleet-home-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readFleet', () => {
  it("reads each shown project's own store, and counts the dormant ones it left out", () => {
    const awake = registered(tempDir('pup-fleet-repo-'));
    const planned = openStore(awake.dbFile);
    insertTask(planned, {
      id: 't-a',
      projectId: awake.id,
      spec: JSON.stringify({ id: 't-a', goal: 'g', scopeIn: ['src/**'], acceptance: ['a'] }),
      origin: 'human',
    });
    planned.close();
    const asleep = registered(tempDir('pup-fleet-repo-'), { dormantAt: '2026-09-21T10:00:00Z' });

    const fleet = readFleet([awake, asleep], NOW, false);

    expect(fleet.hidden).toBe(1);
    expect(fleet.blocks).toEqual([
      expect.objectContaining({
        header: `${awake.id}  ${awake.repoPath}`,
        dormantAt: null,
        summary: expect.objectContaining({ planned: 1 }),
      }),
    ]);
    expect(readFleet([awake, asleep], NOW, true)).toEqual({
      hidden: 0,
      blocks: [
        expect.objectContaining({ header: `${awake.id}  ${awake.repoPath}` }),
        expect.objectContaining({ dormantAt: '2026-09-21T10:00:00Z' }),
      ],
    });
  });

  it('says why a gone, variant or unreadable project was not read, opening neither of the first two', () => {
    const repo = tempDir('pup-fleet-repo-');
    const gone = { ...registered(repo), dbFile: bareStore(repo), repoExists: false };
    const variant = { ...registered(`${repo}/`), dbFile: bareStore(`${repo}/`), isOwnPath: false };
    // Readable by the registry scan, refused by `openStore`: a view on `events` cannot be indexed.
    const odd = registered(tempDir('pup-fleet-repo-'));
    const oddDir = tempDir('pup-fleet-odd-');
    const bare = new BetterSqlite3(join(oddDir, 'state.db'));
    bare.exec('CREATE VIEW events AS SELECT 1 AS session_id');
    bare.close();

    const { blocks } = readFleet(
      [gone, variant, { ...odd, dbFile: join(oddDir, 'state.db') }],
      NOW,
      false,
    );

    expect(blocks).toEqual([
      { header: `${gone.id}  ${repo}`, reason: 'missing: the repo no longer exists' },
      {
        header: `${variant.id}  ${repo}/`,
        reason: 'not its own path: a variant of a repo path, never opened',
      },
      { header: `${odd.id}  ${odd.repoPath}`, reason: 'unreadable: views may not be indexed' },
    ]);
    expect(tablesOf(gone.dbFile)).toEqual(['projects']);
    expect(tablesOf(variant.dbFile)).toEqual(['projects']);
  });

  it('sanitizes the repo path a store wrote into its header', () => {
    const project = { ...registered(tempDir('pup-fleet-repo-')), repoExists: false };

    const { blocks } = readFleet([{ ...project, repoPath: 'evil\u001b[2J' }], NOW, false);

    expect(blocks[0]?.header).toBe(`${project.id}  evil [2J`);
  });
});

describe('fleetReading', () => {
  it('opens each project once and reads its own store, with the bin its keys re-enter', () => {
    const a = registered(tempDir('pup-fleet-repo-'));
    const b = registered(tempDir('pup-fleet-repo-'));

    const read = fleetReading([a, b], false, '/bin/pup');
    const first = read();
    const second = read();

    expect(first.unreadable).toEqual([]);
    expect(first.projects.map((project) => project.deps.repoPath)).toEqual([
      a.repoPath,
      b.repoPath,
    ]);
    expect(first.projects.map((project) => project.snapshot.projectId)).toEqual([a.id, b.id]);
    expect(first.projects[0]?.deps.pupBin).toBe('/bin/pup');
    // Held for the dashboard's life: the next reading drives the same handles.
    expect(second.projects[0]?.deps).toBe(first.projects[0]?.deps);
  });

  it('lists a refused project on every reading and leaves dormant ones out unless asked', () => {
    const live = registered(tempDir('pup-fleet-repo-'));
    const repo = tempDir('pup-fleet-repo-');
    const variant = { ...registered(`${repo}/`), dbFile: bareStore(`${repo}/`), isOwnPath: false };
    const asleep = registered(tempDir('pup-fleet-repo-'), { dormantAt: '2026-09-21T10:00:00Z' });
    const line = `${variant.id}  ${repo}/  not its own path: a variant of a repo path, never opened`;

    const read = fleetReading([live, variant, asleep], false, '/bin/pup');

    expect(read().unreadable).toEqual([line]);
    expect(read().unreadable).toEqual([line]);
    expect(read().projects.map((project) => project.deps.repoPath)).toEqual([live.repoPath]);
    expect(tablesOf(variant.dbFile)).toEqual(['projects']);
    expect(
      fleetReading([live, variant, asleep], true, '/bin/pup')().projects.map(
        (project) => project.deps.repoPath,
      ),
    ).toEqual([live.repoPath, asleep.repoPath]);
  });

  it('lists a store it cannot open as unreadable, and reads the rest', () => {
    const live = registered(tempDir('pup-fleet-repo-'));
    const odd = registered(tempDir('pup-fleet-repo-'));
    const oddDir = tempDir('pup-fleet-odd-');
    const bare = new BetterSqlite3(join(oddDir, 'state.db'));
    bare.exec('CREATE VIEW events AS SELECT 1 AS session_id');
    bare.close();

    const reading = fleetReading(
      [live, { ...odd, dbFile: join(oddDir, 'state.db') }],
      false,
      '/bin/pup',
    )();

    expect(reading.projects.map((project) => project.deps.repoPath)).toEqual([live.repoPath]);
    expect(reading.unreadable).toEqual([
      `${odd.id}  ${odd.repoPath}  unreadable: views may not be indexed`,
    ]);
  });
});
