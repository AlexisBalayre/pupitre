import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../claude/session-runtime.service.js', () => ({
  kickoff: vi.fn(() => true),
  killSession: vi.fn(),
  launchSession: vi.fn(() => ({ target: 'pup-s1' })),
  steerSession: vi.fn(),
}));

import {
  kickoff,
  killSession,
  launchSession,
  steerSession,
} from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { projectPaths } from './paths.utils.js';
import {
  ensureProject,
  insertSession,
  insertTask,
  transitionSession,
} from './session.repository.js';
import {
  hardRespawnSession,
  isHandoffReady,
  markHandoffReady,
  requestHandoff,
  respawnSession,
} from './session-handoff.service.js';

describe('session handoff', () => {
  let db: Database;
  let repoPath: string;
  let stateBase: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    repoPath = realpathSync(mkdtempSync(join(tmpdir(), 'pup-handoff-repo-')));
    stateBase = realpathSync(mkdtempSync(join(tmpdir(), 'pup-handoff-state-')));
    ensureProject(db, 'proj-1', repoPath);
    insertTask(db, { id: 'task-s1', projectId: 'proj-1', spec: '{}' });
    insertSession(db, {
      id: 's1',
      taskId: 'task-s1',
      worktreePath: join(repoPath, '.worktrees', 's1'),
      branch: 'pup/s1',
      profileHash: 'hash',
    });
    transitionSession(db, 's1', 'running');
  });

  // projectPaths defaults to ~/.pupitre; tests must never write there.
  const paths = () => projectPaths(repoPath, stateBase);

  function writeCompiledAndHandoff(): void {
    const compiled = paths().compiledDir('s1');
    mkdirSync(compiled, { recursive: true });
    writeFileSync(join(compiled, 'context.md'), '# task context\n');
    writeFileSync(join(compiled, 'settings.json'), '{}');
    writeFileSync(paths().handoffFile('s1'), 'half the work is done\n');
  }

  it('steers the session with the handoff path and records the request', () => {
    const handoffPath = requestHandoff(db, repoPath, 's1');

    expect(handoffPath).toContain('handoff.md');
    expect(vi.mocked(steerSession).mock.calls[0]?.[1]).toContain('pup session handoff-done');
    expect(isHandoffReady(db, 's1')).toBe(false);
  });

  it('becomes ready only after handoff-done follows the request', () => {
    requestHandoff(db, repoPath, 's1');
    expect(isHandoffReady(db, 's1')).toBe(false);

    markHandoffReady(db, 's1');
    expect(isHandoffReady(db, 's1')).toBe(true);

    requestHandoff(db, repoPath, 's1');
    expect(isHandoffReady(db, 's1')).toBe(false);
  });

  // A `handoff_ready` nobody asked for is not readiness: otherwise a session
  // could write another session's handoff, mark it ready, and have `pup respawn`
  // relaunch that session on its text without ever steering it (decision 44).
  it('is not ready when no handoff was requested', () => {
    markHandoffReady(db, 's1');

    expect(isHandoffReady(db, 's1')).toBe(false);
  });

  it('refuses to request a handoff from a session that is not running', () => {
    transitionSession(db, 's1', 'killed');
    expect(() => requestHandoff(db, repoPath, 's1')).toThrow('only running sessions');
  });

  it('respawns with the compiled context plus the handoff as kickoff', () => {
    writeCompiledAndHandoff();

    respawnSessionWithTestPaths();

    expect(killSession).toHaveBeenCalledWith('s1');
    expect(vi.mocked(launchSession).mock.calls[0]?.[0]).toMatchObject({
      sessionId: 's1',
      worktreePath: join(repoPath, '.worktrees', 's1'),
    });
    const prompt = vi.mocked(kickoff).mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('# task context');
    expect(prompt).toContain('## Handoff from your previous run');
    expect(prompt).toContain('half the work is done');
    const event = db.prepare("SELECT payload FROM events WHERE type = 'respawn'").get() as {
      payload: string;
    };
    expect(JSON.parse(event.payload)).toMatchObject({ delivered: true });
  });

  it('refuses to respawn without a handoff file', () => {
    expect(() => respawnSessionWithTestPaths()).toThrow('No handoff at');
    expect(killSession).not.toHaveBeenCalled();
  });

  it('hard-respawns without a handoff, pointing the fresh run at the worktree state', () => {
    const compiled = paths().compiledDir('s1');
    mkdirSync(compiled, { recursive: true });
    writeFileSync(join(compiled, 'context.md'), '# task context\n');
    writeFileSync(join(compiled, 'settings.json'), '{}');

    hardRespawnSession(db, repoPath, 's1', stateBase);

    expect(killSession).toHaveBeenCalledWith('s1');
    const prompt = vi.mocked(kickoff).mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('# task context');
    expect(prompt).toMatch(/previous run .* killed/i);
    expect(prompt).toContain('git status');
    expect(prompt).not.toContain('## Handoff from your previous run');
    const event = db.prepare("SELECT payload FROM events WHERE type = 'respawn'").get() as {
      payload: string;
    };
    expect(JSON.parse(event.payload)).toMatchObject({ delivered: true, hard: true });
    const state = db.prepare("SELECT state FROM sessions WHERE id = 's1'").get() as {
      state: string;
    };
    expect(state.state).toBe('running');
  });

  it('refuses a hard respawn on a session that is not running', () => {
    transitionSession(db, 's1', 'killed');
    expect(() => hardRespawnSession(db, repoPath, 's1', stateBase)).toThrow(
      'only running sessions',
    );
  });

  function respawnSessionWithTestPaths(): void {
    respawnSession(db, repoPath, 's1', stateBase);
  }
});
