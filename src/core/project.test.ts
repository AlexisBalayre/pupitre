import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux boundary only: whether a conductor window is up.
vi.mock('./conductor.service.js', () => ({ isConductorRunning: vi.fn(() => false) }));

import { isConductorRunning } from './conductor.service.js';
import { openStore } from './db.client.js';
import { projectId } from './paths.utils.js';
import { listProjects, putProjectToSleep, wakeProject } from './project.service.js';
import {
  ensureProject,
  getProject,
  insertSession,
  insertTask,
  saveProjectDormantAt,
  transitionSession,
} from './session.repository.js';

const NOW = new Date('2026-09-22T12:00:00Z');

let db: Database;
let repo: string;
let pid: string;

function seedSession(sessionId: string): void {
  const taskId = `t-${sessionId}`;
  insertTask(db, {
    id: taskId,
    projectId: pid,
    spec: JSON.stringify({ id: taskId, goal: 'g', scopeIn: ['src/**'], acceptance: ['a'] }),
    origin: 'human',
  });
  insertSession(db, {
    id: sessionId,
    taskId,
    worktreePath: join(repo, '.worktrees', sessionId),
    branch: `pup/${sessionId}`,
    profileHash: 'hash',
  });
}

beforeEach(() => {
  db = openStore(':memory:');
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-project-')));
  pid = projectId(repo);
  ensureProject(db, pid, repo);
});

afterEach(() => {
  db.close();
  vi.mocked(isConductorRunning).mockReset().mockReturnValue(false);
});

describe('listProjects', () => {
  const a = { id: 'aaa', repoPath: '/repo/a' };
  const b = { id: 'bbb', repoPath: '/repo/b' };

  it('lists every project with whether its conductor runs, or the one selected', () => {
    vi.mocked(isConductorRunning).mockImplementation((repoPath) => repoPath === '/repo/a');

    expect(listProjects([a, b], undefined)).toEqual({
      projects: [
        { project: a, isConductorRunning: true },
        { project: b, isConductorRunning: false },
      ],
    });
    expect(listProjects([a, b], 'bbb')).toEqual({
      projects: [{ project: b, isConductorRunning: false }],
    });
  });

  it('refuses an empty registry, and an unknown id with its control characters stripped', () => {
    expect(listProjects([], undefined)).toEqual({
      refusal: 'No project registered; run pup init from the repo you want to control.',
    });
    expect(listProjects([a], 'nope\u001b[2J')).toEqual({
      refusal: 'No project nope [2J; `pup project list` shows the registered ones.',
    });
  });
});

describe('putProjectToSleep', () => {
  it('stamps the project dormant once nothing in it is live', () => {
    expect(putProjectToSleep(db, repo, NOW)).toEqual({
      said: `Project ${pid} is dormant: pup status, pup ui and the radar pass it over until \`pup project wake ${pid}\`.`,
    });
    expect(getProject(db, pid)?.dormant_at).toBe('2026-09-22T12:00:00.000Z');
  });

  it('refuses while the conductor or a holding session is live, naming each, and writes nothing', () => {
    seedSession('s-live');
    transitionSession(db, 's-live', 'running');
    seedSession('s-gone');
    transitionSession(db, 's-gone', 'killed');
    vi.mocked(isConductorRunning).mockReturnValue(true);

    expect(putProjectToSleep(db, repo, NOW)).toEqual({
      refusal: `Project ${pid} still has pup-conductor-${pid}, s-live live; stop them (pup conductor stop, pup kill <session>, or merge) before putting it to sleep.`,
    });

    vi.mocked(isConductorRunning).mockReturnValue(false);
    expect(putProjectToSleep(db, repo, NOW)).toEqual({
      refusal: `Project ${pid} still has s-live live; stop it (pup conductor stop, pup kill <session>, or merge) before putting it to sleep.`,
    });
    expect(getProject(db, pid)?.dormant_at).toBeNull();
  });

  it('says a dormant project is already asleep, scrubbing the stamp a store wrote', () => {
    saveProjectDormantAt(db, pid, '2026\u001b[31m');

    expect(putProjectToSleep(db, repo, NOW)).toEqual({
      said: `Project ${pid} is already dormant since 2026 [31m.`,
    });
  });

  it('refuses a repo that was never registered', () => {
    expect(putProjectToSleep(db, '/never/registered', NOW)).toEqual({
      refusal: 'No project at /never/registered; run pup init from the repo you want to control.',
    });
  });
});

describe('wakeProject', () => {
  it('wakes a dormant project, and says so when it is already active', () => {
    saveProjectDormantAt(db, pid, NOW.toISOString());

    expect(wakeProject(db, repo)).toEqual({
      said: `Project ${pid} is awake: the fleet views and the radar read it again.`,
    });
    expect(getProject(db, pid)?.dormant_at).toBeNull();
    expect(wakeProject(db, repo)).toEqual({ said: `Project ${pid} is already active.` });
  });

  it('refuses a repo that was never registered', () => {
    expect(wakeProject(db, '/never/registered')).toEqual({
      refusal: 'No project at /never/registered; run pup init from the repo you want to control.',
    });
  });
});
