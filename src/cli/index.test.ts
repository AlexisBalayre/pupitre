import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Side-effecting boundaries only (tmux/git spawns, `claude -p` sessions, and the
// multi-stage merge-gate orchestration) — everything else (sqlite repositories,
// profile-store file reads) is exercised for real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', () => ({
  interruptSession: vi.fn(),
  killWatcher: vi.fn(),
  launchWatcher: vi.fn(),
  steerSession: vi.fn(),
}));
vi.mock('../core/merge-gate.service.js', () => ({
  runMergeGate: vi.fn(),
}));
vi.mock('../core/session-lifecycle.service.js', () => ({
  createSession: vi.fn(),
  killSession: vi.fn(),
  markSessionDone: vi.fn(),
}));
vi.mock('../core/session-handoff.service.js', () => ({
  HANDOFF_WAIT_DEFAULT_MS: 10 * 60 * 1000,
  RESPAWN_SUGGEST_TOKENS: 120_000,
  awaitHandoffReady: vi.fn(),
  hardRespawnSession: vi.fn(),
  isHandoffReady: vi.fn(),
  markHandoffReady: vi.fn(),
  requestHandoff: vi.fn(),
  respawnSession: vi.fn(),
}));

import { interruptSession, steerSession } from '../claude/session-runtime.service.js';
import { DEFAULT_BASE_PROFILE } from '../core/default-profile.constants.js';
import { insertLedgerEntry } from '../core/ledger.repository.js';
import { runMergeGate } from '../core/merge-gate.service.js';
import { projectId, projectPaths } from '../core/paths.utils.js';
import {
  ensureProject,
  insertSession,
  insertTask,
  transitionSession,
} from '../core/session.repository.js';
import { STALLED_AFTER_MS } from '../core/session-activity.constants.js';
import {
  awaitHandoffReady,
  hardRespawnSession,
  isHandoffReady,
  markHandoffReady,
  requestHandoff,
  respawnSession,
} from '../core/session-handoff.service.js';
import { createSession, killSession, markSessionDone } from '../core/session-lifecycle.service.js';
import type { MergeOutcome } from '../core/types/merge-gate.types.js';
import { buildProgram } from './index.js';
import { resolveProject } from './project.utils.js';

const HANDOFF_WAIT_DEFAULT_MS = 10 * 60 * 1000;

// Test repos must not inherit the developer's global git config (hooks, signing)
// nor GIT_DIR & co. — when this suite runs inside a git hook (pre-commit), those
// would redirect every git call at the pupitre repo instead of the temp repo.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A repo with no adapter markers (no package.json, pyproject.toml, ...). */
function initRepo(): string {
  const repo = tempDir('pup-cli-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
  return repo;
}

/** The args of a mock's first call — throws instead of a `!` when it was never called. */
function firstCall<Args extends unknown[]>(mockFn: (...args: Args) => unknown): Args {
  const call = vi.mocked(mockFn).mock.calls[0];
  if (!call) throw new Error('expected the mock to have been called');
  return call;
}

/** A repo the TypeScript adapter detects, for commands that require one. */
function initRepoWithAdapter(): string {
  const repo = initRepo();
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(join(repo, 'tsconfig.json'), '{}');
  return repo;
}

/** Inserts the project/task/session rows a real (unmocked) `getSession` needs. */
function seedSession(repoPath: string, sessionId: string, worktreePath?: string): void {
  const { db } = resolveProject(repoPath);
  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);
  insertTask(db, { id: `t-${sessionId}`, projectId: pid, spec: '{}' });
  insertSession(db, {
    id: sessionId,
    taskId: `t-${sessionId}`,
    worktreePath: worktreePath ?? join(repoPath, '.worktrees', sessionId),
    branch: `pup/${sessionId}`,
    profileHash: 'hash',
  });
  db.close();
}

/** Writes a running session's events file with its mtime `ageMs` in the past. */
function seedEventsFile(repoPath: string, sessionId: string, ageMs: number): void {
  const paths = projectPaths(repoPath);
  mkdirSync(paths.sessionDir(sessionId), { recursive: true });
  const eventsFile = paths.eventsFile(sessionId);
  writeFileSync(eventsFile, `${JSON.stringify({ hook_event_name: 'PostToolUse' })}\n`);
  const time = new Date(Date.now() - ageMs);
  utimesSync(eventsFile, time, time);
}

/** Inserts one open ledger entry (real, unmocked repository) and returns its id. */
function seedLedgerEntry(repoPath: string): number {
  const { db } = resolveProject(repoPath);
  const pid = projectId(repoPath);
  ensureProject(db, pid, repoPath);
  const id = insertLedgerEntry(db, {
    projectId: pid,
    description: 'shortcut taken',
    files: ['src/a.ts'],
    reason: 'ship the demo',
    acceptedBy: 'human',
    reviewBy: 'before the next release',
  });
  db.close();
  return id;
}

describe('CLI commands', () => {
  const originalExitCode = process.exitCode;
  let logs: string[];
  let errors: string[];
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let savedGitEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vi.resetAllMocks();
    process.exitCode = undefined;
    logs = [];
    errors = [];
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = (message: string) => logs.push(message);
    console.error = (message: string) => errors.push(message);
    // resolveProject() always resolves state under homedir() — point it at a
    // throwaway HOME so a test run never touches the developer's real ~/.pupitre.
    vi.stubEnv('HOME', tempDir('pup-cli-home-'));
    // repoRoot() shells out to `git -C <cwd> rev-parse ...` with no env
    // override, so it inherits process.env as-is. Running inside the repo's
    // own pre-commit hook leaves GIT_DIR (and friends) set, which silently
    // redirects that call at the pupitre repo instead of the temp fixture
    // below — strip them for the duration of the test, same hazard the
    // GIT_ENV convention guards against for git calls this suite makes itself.
    savedGitEnv = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_')) {
        savedGitEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    for (const [key, value] of Object.entries(savedGitEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // process.chdir would be process-global and race with the other test
    // files vitest runs concurrently, so cwd is stubbed at the JS level
    // instead (resolveProject/repoRoot default their cwd param to
    // process.cwd(), read fresh on every call).
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = originalExitCode;
  });

  function useCwd(dir: string): void {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  }

  describe('status', () => {
    it('reports no sessions for a freshly initialised repo', () => {
      useCwd(initRepo());

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs).toContain('No sessions.');
      expect(process.exitCode).toBeUndefined();
    });

    it('throws when run outside any git repo (no project to resolve)', () => {
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() => buildProgram().parse(['status'], { from: 'user' })).toThrow();
    });

    it('marks a running session STALLED with its age and sorts it before a fresh one', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's-fresh');
      seedSession(repo, 's-stalled');
      const { db } = resolveProject(repo);
      transitionSession(db, 's-fresh', 'running');
      transitionSession(db, 's-stalled', 'running');
      db.close();
      seedEventsFile(repo, 's-fresh', 0);
      seedEventsFile(repo, 's-stalled', STALLED_AFTER_MS + 60_000);

      buildProgram().parse(['status'], { from: 'user' });

      const stalledLine = logs.find((line) => line.includes('s-stalled'));
      const freshLine = logs.find((line) => line.includes('s-fresh'));
      expect(stalledLine).toMatch(/STALLED \(\d+m\)/);
      expect(freshLine).not.toContain('STALLED');
      expect(logs.indexOf(stalledLine as string)).toBeLessThan(logs.indexOf(freshLine as string));
    });

    it('does not flag a running session with a fresh events file', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's-fresh');
      const { db } = resolveProject(repo);
      transitionSession(db, 's-fresh', 'running');
      db.close();
      seedEventsFile(repo, 's-fresh', 0);

      buildProgram().parse(['status'], { from: 'user' });

      expect(logs.some((line) => line.includes('STALLED'))).toBe(false);
    });
  });

  describe('watch', () => {
    it('emits a STALLED line for a running session with an old events file', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's-stalled');
      const { db } = resolveProject(repo);
      transitionSession(db, 's-stalled', 'running');
      db.close();
      seedEventsFile(repo, 's-stalled', STALLED_AFTER_MS + 60_000);

      buildProgram().parse(['watch', '--once'], { from: 'user' });

      expect(logs.some((line) => line.includes('STALLED') && line.includes('s-stalled'))).toBe(
        true,
      );
    });
  });

  describe('init', () => {
    it('reports the NoAdapterError and exits 1 when no adapter detects the repo', () => {
      useCwd(initRepo());

      buildProgram().parse(['init'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('No adapter detected')]);
      expect(logs).toEqual([]);
    });

    it('throws when run outside any git repo (no project to resolve)', () => {
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() => buildProgram().parse(['init'], { from: 'user' })).toThrow();
    });
  });

  describe('audit', () => {
    it('reports the NoAdapterError and exits 1 when no adapter detects the repo', () => {
      useCwd(initRepo());

      buildProgram().parse(['audit'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('No adapter detected')]);
      expect(logs).toEqual([]);
    });

    it('throws when run outside any git repo (no project to resolve)', () => {
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() => buildProgram().parse(['audit'], { from: 'user' })).toThrow();
    });
  });

  describe('new', () => {
    it('requires --scope', () => {
      useCwd(initRepo());

      expect(() => buildProgram().parse(['new', 'do the thing'], { from: 'user' })).toThrow();
      expect(createSession).not.toHaveBeenCalled();
    });

    it('compiles the task spec from its options and launches a session', () => {
      useCwd(initRepo());
      vi.mocked(createSession).mockReturnValue('t-abc-0');

      buildProgram().parse(
        [
          'new',
          'do the thing',
          '--scope',
          'src/**',
          'docs/**',
          '--scope-out',
          'src/generated/**',
          '--accept',
          'tests pass',
          '--model',
          'opus',
        ],
        { from: 'user' },
      );

      expect(createSession).toHaveBeenCalledTimes(1);
      const [, request] = firstCall(createSession);
      expect(request).toMatchObject({
        base: DEFAULT_BASE_PROFILE,
        model: 'opus',
        task: {
          goal: 'do the thing',
          scopeIn: ['src/**', 'docs/**'],
          scopeOut: ['src/generated/**'],
          acceptance: ['tests pass'],
        },
      });
      expect(request.task.id as string).toMatch(/^t-/);
      expect(logs).toContain('Launched session t-abc-0 (tmux: pup-t-abc-0).');
      expect(logs).toContain('Attach with: tmux attach -t pup-t-abc-0');
    });

    it('defaults acceptance criteria when --accept is omitted', () => {
      useCwd(initRepo());
      vi.mocked(createSession).mockReturnValue('t-abc-0');

      buildProgram().parse(['new', 'do the thing', '--scope', 'src/**'], { from: 'user' });

      const [, request] = firstCall(createSession);
      expect(request.task.acceptance).toEqual(['goal met and committed']);
    });

    it('throws when run outside any git repo (no project to resolve)', () => {
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() =>
        buildProgram().parse(['new', 'goal', '--scope', 'src/**'], { from: 'user' }),
      ).toThrow();
    });
  });

  describe('steer', () => {
    it('reports no session and does not steer', () => {
      useCwd(initRepo());

      buildProgram().parse(['steer', 'missing-session', 'do X instead'], { from: 'user' });

      expect(errors).toEqual(['No session missing-session.']);
      expect(process.exitCode).toBe(1);
      expect(steerSession).not.toHaveBeenCalled();
    });

    it('steers an existing session and records the event', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');

      buildProgram().parse(['steer', 's1', 'do X instead'], { from: 'user' });

      expect(steerSession).toHaveBeenCalledWith('s1', 'do X instead');
      expect(logs).toContain('Steered session s1.');
      expect(process.exitCode).toBeUndefined();

      const { db } = resolveProject(repo);
      const events = db
        .prepare("SELECT type, payload FROM events WHERE session_id = 's1'")
        .all() as { type: string; payload: string }[];
      expect(events).toContainEqual({ type: 'steer', payload: JSON.stringify({ kind: 'manual' }) });
    });

    it('refuses a terminal session', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      const { db } = resolveProject(repo);
      transitionSession(db, 's1', 'killed');
      db.close();

      buildProgram().parse(['steer', 's1', 'do X instead'], { from: 'user' });

      expect(errors).toEqual(['Session s1 is killed; nothing to steer.']);
      expect(process.exitCode).toBe(1);
      expect(steerSession).not.toHaveBeenCalled();
    });
  });

  describe('interrupt', () => {
    function sessionEvents(repo: string, sessionId: string): { type: string; payload: string }[] {
      const { db } = resolveProject(repo);
      return db.prepare('SELECT type, payload FROM events WHERE session_id = ?').all(sessionId) as {
        type: string;
        payload: string;
      }[];
    }

    it('reports no session and touches neither tmux nor the event log', () => {
      useCwd(initRepo());

      buildProgram().parse(['interrupt', 'missing-session'], { from: 'user' });

      expect(errors).toEqual(['No session missing-session.']);
      expect(process.exitCode).toBe(1);
      expect(interruptSession).not.toHaveBeenCalled();
      expect(steerSession).not.toHaveBeenCalled();
    });

    it('sends Escape before steering when a message is given, and records a steered interrupt', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');

      buildProgram().parse(['interrupt', 's1', 'retry the fetch'], { from: 'user' });

      expect(interruptSession).toHaveBeenCalledWith('s1');
      expect(steerSession).toHaveBeenCalledWith('s1', 'retry the fetch');
      // The whole point of `interrupt <sid> "msg"` over `steer` is Escape lands
      // FIRST, so the steer is not queued behind the hung tool call.
      const escapeOrder = vi.mocked(interruptSession).mock.invocationCallOrder[0];
      const steerOrder = vi.mocked(steerSession).mock.invocationCallOrder[0];
      expect(escapeOrder).toBeLessThan(steerOrder as number);
      expect(logs).toContain('Interrupted and steered session s1.');
      expect(process.exitCode).toBeUndefined();
      const events = sessionEvents(repo, 's1');
      expect(events).toContainEqual({
        type: 'interrupt',
        payload: JSON.stringify({ steered: true }),
      });
      // The delivered message is a real steer — logged as one too, so a
      // last-steer query cannot miss steers that arrived via interrupt.
      expect(events).toContainEqual({
        type: 'steer',
        payload: JSON.stringify({ kind: 'interrupt' }),
      });
    });

    it('refuses a terminal session without touching tmux', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');
      const { db } = resolveProject(repo);
      transitionSession(db, 's1', 'killed');
      db.close();

      buildProgram().parse(['interrupt', 's1', 'retry the fetch'], { from: 'user' });

      expect(errors).toEqual(['Session s1 is killed; nothing to interrupt.']);
      expect(process.exitCode).toBe(1);
      expect(interruptSession).not.toHaveBeenCalled();
      expect(steerSession).not.toHaveBeenCalled();
    });

    it('does not steer when no message is given', () => {
      const repo = initRepo();
      useCwd(repo);
      seedSession(repo, 's1');

      buildProgram().parse(['interrupt', 's1'], { from: 'user' });

      expect(interruptSession).toHaveBeenCalledWith('s1');
      expect(steerSession).not.toHaveBeenCalled();
      expect(logs).toContain('Interrupted session s1.');
      expect(process.exitCode).toBeUndefined();
      expect(sessionEvents(repo, 's1')).toContainEqual({
        type: 'interrupt',
        payload: JSON.stringify({ steered: false }),
      });
    });
  });

  describe('kill', () => {
    it('kills a session', () => {
      useCwd(initRepo());

      buildProgram().parse(['kill', 's1'], { from: 'user' });

      expect(killSession).toHaveBeenCalledTimes(1);
      const [, sessionId] = firstCall(killSession);
      expect(sessionId).toBe('s1');
      expect(logs).toContain('Killed session s1.');
      expect(process.exitCode).toBeUndefined();
    });

    it('hard-respawns instead of killing when --respawn is passed', () => {
      useCwd(initRepo());

      buildProgram().parse(['kill', 's1', '--respawn'], { from: 'user' });

      expect(hardRespawnSession).toHaveBeenCalledTimes(1);
      expect(killSession).not.toHaveBeenCalled();
      expect(logs).toContain('Hard-respawned session s1 (tmux: pup-s1).');
    });

    it('reports the error and exits 1 when the hard respawn fails', () => {
      useCwd(initRepo());
      vi.mocked(hardRespawnSession).mockImplementation(() => {
        throw new Error('worktree is dirty');
      });

      buildProgram().parse(['kill', 's1', '--respawn'], { from: 'user' });

      expect(errors).toEqual(['worktree is dirty']);
      expect(process.exitCode).toBe(1);
      expect(logs).toEqual([]);
    });
  });

  describe('respawn', () => {
    it('respawns immediately when the handoff is already ready', () => {
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(true);

      buildProgram().parse(['respawn', 's1'], { from: 'user' });

      expect(requestHandoff).not.toHaveBeenCalled();
      expect(respawnSession).toHaveBeenCalledTimes(1);
      expect(logs).toContain('Respawned s1 on a fresh context window with its handoff.');
      expect(process.exitCode).toBeUndefined();
    });

    it('requests and awaits a handoff before respawning when not yet ready', () => {
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(false);
      vi.mocked(requestHandoff).mockReturnValue('/tmp/handoff.md');
      vi.mocked(awaitHandoffReady).mockReturnValue(true);

      buildProgram().parse(['respawn', 's1'], { from: 'user' });

      expect(requestHandoff).toHaveBeenCalledTimes(1);
      expect(logs).toContain(
        'Handoff requested; waiting for the session to write /tmp/handoff.md …',
      );
      expect(awaitHandoffReady).toHaveBeenCalledWith(
        expect.anything(),
        's1',
        HANDOFF_WAIT_DEFAULT_MS,
      );
      expect(respawnSession).toHaveBeenCalledTimes(1);
      expect(logs).toContain('Respawned s1 on a fresh context window with its handoff.');
    });

    it('forwards a custom --wait as milliseconds', () => {
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(false);
      vi.mocked(requestHandoff).mockReturnValue('/tmp/handoff.md');
      vi.mocked(awaitHandoffReady).mockReturnValue(true);

      buildProgram().parse(['respawn', 's1', '--wait', '30'], { from: 'user' });

      expect(awaitHandoffReady).toHaveBeenCalledWith(expect.anything(), 's1', 30_000);
    });

    it('reports and exits 1 when the handoff never arrives', () => {
      useCwd(initRepo());
      vi.mocked(isHandoffReady).mockReturnValue(false);
      vi.mocked(requestHandoff).mockReturnValue('/tmp/handoff.md');
      vi.mocked(awaitHandoffReady).mockReturnValue(false);

      buildProgram().parse(['respawn', 's1'], { from: 'user' });

      expect(respawnSession).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([
        expect.stringContaining('Session s1 has not signalled handoff-done yet'),
      ]);
    });
  });

  describe('debt', () => {
    it('reports no open ledger entries', () => {
      useCwd(initRepo());

      buildProgram().parse(['debt'], { from: 'user' });

      expect(logs).toContain('No open ledger entries.');
    });

    it('prints open ledger entries', () => {
      const repo = initRepo();
      useCwd(repo);
      const id = seedLedgerEntry(repo);

      buildProgram().parse(['debt'], { from: 'user' });

      expect(logs.some((l) => l.includes(`#${id}`) && l.includes('shortcut taken'))).toBe(true);
      expect(
        logs.some(
          (l) =>
            l.includes('reason: ship the demo') &&
            l.includes('review by: before the next release') &&
            l.includes('accepted by: human'),
        ),
      ).toBe(true);
    });

    describe('close', () => {
      it('closes an open ledger entry', () => {
        const repo = initRepo();
        useCwd(repo);
        const id = seedLedgerEntry(repo);

        buildProgram().parse(['debt', 'close', String(id)], { from: 'user' });

        expect(logs).toContain(`Closed ledger entry #${id}.`);
        expect(process.exitCode).toBeUndefined();
      });

      it('reports and exits 1 for a non-existent or already-closed entry', () => {
        useCwd(initRepo());

        buildProgram().parse(['debt', 'close', '999'], { from: 'user' });

        expect(errors).toEqual(['No open ledger entry #999.']);
        expect(process.exitCode).toBe(1);
      });
    });
  });

  describe('profile', () => {
    it('lists the built-in base layer when no profiles are compiled yet', () => {
      useCwd(initRepo());

      buildProgram().parse(['profile', 'list'], { from: 'user' });

      expect(logs.some((l) => l.startsWith('NAME'))).toBe(true);
      expect(logs.some((l) => l.startsWith(DEFAULT_BASE_PROFILE.name))).toBe(true);
    });

    it('shows the built-in base layer', () => {
      useCwd(initRepo());

      buildProgram().parse(['profile', 'show', 'base'], { from: 'user' });

      expect(logs.some((l) => l.includes('name: base'))).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });

    it('reports and exits 1 for an unknown layer', () => {
      useCwd(initRepo());

      buildProgram().parse(['profile', 'show', 'ghost'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('No profile layer `ghost`')]);
    });

    it('requires a name for `profile show`', () => {
      useCwd(initRepo());

      buildProgram().parse(['profile', 'show'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual(['Usage: pup profile show <name>']);
    });

    it.each(['edit', 'stale'])('reports `%s` as not implemented yet', (action) => {
      useCwd(initRepo());

      buildProgram().parse(['profile', action], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([`pup profile ${action}: not implemented yet`]);
    });

    it('reports an unknown action', () => {
      useCwd(initRepo());

      buildProgram().parse(['profile', 'bogus'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual(['Unknown profile action `bogus` (expected list|show|edit|stale).']);
    });
  });

  describe('session', () => {
    describe('done', () => {
      it('requires PUP_SESSION_ID', () => {
        useCwd(initRepo());
        vi.stubEnv('PUP_SESSION_ID', '');

        buildProgram().parse(['session', 'done', 'summary'], { from: 'user' });

        expect(process.exitCode).toBe(1);
        expect(errors).toEqual([
          'pup session done must run inside a Pupitre session (PUP_SESSION_ID unset).',
        ]);
        expect(markSessionDone).not.toHaveBeenCalled();
      });

      it('marks the session done', () => {
        useCwd(initRepo());
        vi.stubEnv('PUP_SESSION_ID', 's1');

        buildProgram().parse(['session', 'done', 'shipped the thing'], { from: 'user' });

        expect(markSessionDone).toHaveBeenCalledTimes(1);
        const [, sessionId, summary] = firstCall(markSessionDone);
        expect(sessionId).toBe('s1');
        expect(summary).toBe('shipped the thing');
        expect(logs).toContain('Session s1 marked done: shipped the thing');
      });
    });

    describe('handoff-done', () => {
      it('requires PUP_SESSION_ID', () => {
        useCwd(initRepo());
        vi.stubEnv('PUP_SESSION_ID', '');

        buildProgram().parse(['session', 'handoff-done'], { from: 'user' });

        expect(process.exitCode).toBe(1);
        expect(errors).toEqual([
          'pup session handoff-done must run inside a Pupitre session (PUP_SESSION_ID unset).',
        ]);
        expect(markHandoffReady).not.toHaveBeenCalled();
      });

      it('records the handoff', () => {
        useCwd(initRepo());
        vi.stubEnv('PUP_SESSION_ID', 's1');

        buildProgram().parse(['session', 'handoff-done'], { from: 'user' });

        expect(markHandoffReady).toHaveBeenCalledTimes(1);
        const [, sessionId] = firstCall(markHandoffReady);
        expect(sessionId).toBe('s1');
        expect(logs).toContain('Session s1 handoff recorded; Pupitre will respawn you shortly.');
      });
    });
  });

  describe('merge', () => {
    function mergedOutcome(overrides: Partial<MergeOutcome> = {}): MergeOutcome {
      return {
        status: 'merged',
        report: { sessionId: 's1', passed: true, sandbox: 'sandbox-exec (macOS)', stages: [] },
        rejectCount: 0,
        ...overrides,
      };
    }

    it('rejects --accept-debt without --review-by', () => {
      useCwd(initRepo());

      buildProgram().parse(['merge', 's1', '--accept-debt', 'shortcut taken'], { from: 'user' });

      expect(errors).toEqual(['--accept-debt and --review-by must be passed together.']);
      expect(process.exitCode).toBe(1);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    it('rejects --review-by without --accept-debt', () => {
      useCwd(initRepo());

      buildProgram().parse(['merge', 's1', '--review-by', 'before v2'], { from: 'user' });

      expect(errors).toEqual(['--accept-debt and --review-by must be passed together.']);
      expect(process.exitCode).toBe(1);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    it('reports no adapter detected and exits 1', () => {
      useCwd(initRepo());

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([expect.stringContaining('No adapter detected')]);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    it('refuses --pr when called from inside the session being merged', () => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      seedSession(repo, 's1', repo);

      buildProgram().parse(['merge', 's1', '--pr'], { from: 'user' });

      expect(errors).toEqual([
        '`pup merge --pr` is operator-only; sessions cannot open pull requests.',
      ]);
      expect(process.exitCode).toBe(1);
      expect(runMergeGate).not.toHaveBeenCalled();
    });

    it('forwards the repo, session, and detected adapter to the gate', () => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      vi.mocked(runMergeGate).mockReturnValue(mergedOutcome());

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(runMergeGate).toHaveBeenCalledTimes(1);
      const [, request] = firstCall(runMergeGate);
      expect(request.repoPath).toBe(repo);
      expect(request.sessionId).toBe('s1');
      expect(request.adapter.id).toBe('typescript');
      expect(request.openPr).toBeUndefined();
    });

    it('reports a thrown gate error and exits 1', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockImplementation(() => {
        throw new Error('worktree has a held lock');
      });

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(errors).toEqual(['worktree has a held lock']);
      expect(process.exitCode).toBe(1);
      expect(logs).toEqual([]);
    });

    it('merges and cleans up on a passing gate with no PR', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue(
        mergedOutcome({
          report: {
            sessionId: 's1',
            passed: true,
            sandbox: 'sandbox-exec (macOS)',
            stages: [{ stage: 'lint', status: 'pass' }],
          },
        }),
      );

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(logs.some((l) => /lint\s+PASS/.test(l))).toBe(true);
      expect(logs).toContain('Merged s1; worktree and branch cleaned up.');
      expect(process.exitCode).toBeUndefined();
    });

    it('reports an opened PR when merging with --pr', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue(
        mergedOutcome({ prUrl: 'https://github.com/acme/repo/pull/7', prWasAdopted: false }),
      );

      buildProgram().parse(['merge', 's1', '--pr'], { from: 'user' });

      expect(firstCall(runMergeGate)[1].openPr).toBe(true);
      expect(logs).toContain(
        'Gate passed; opened https://github.com/acme/repo/pull/7 — merge it there, then run `pup audit`.',
      );
    });

    it('reports an adopted PR when one was already open', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue(
        mergedOutcome({ prUrl: 'https://github.com/acme/repo/pull/7', prWasAdopted: true }),
      );

      buildProgram().parse(['merge', 's1', '--pr'], { from: 'user' });

      expect(logs).toContain(
        'Gate passed; reused the open PR https://github.com/acme/repo/pull/7 and rewrote its ' +
          'description with this gate report — check it, merge it there, then run `pup audit`.',
      );
    });

    it('surfaces debt candidates touched by the merge', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue(
        mergedOutcome({ debtCandidates: [{ id: 3, description: 'old shortcut' }] }),
      );

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(logs).toContain(
        'This merge touched files of open debt #3 (old shortcut) — if the shortcut is gone, ' +
          'run `pup debt close 3`.',
      );
    });

    it('does not crash when a decision record id has no matching row', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue(mergedOutcome({ decisionRecordId: 999 }));

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(logs).toContain('Merged s1; worktree and branch cleaned up.');
      expect(process.exitCode).toBeUndefined();
    });

    it('reports a refused gate and exits 1', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue({
        status: 'refused',
        report: {
          sessionId: 's1',
          passed: false,
          sandbox: 'sandbox-exec (macOS)',
          stages: [{ stage: 'diff-size', status: 'flagged', detail: 'big diff' }],
        },
        rejectCount: 0,
      });

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(logs).toContain(
        'Merge refused: diff-size flagged. Re-run with --accept-debt "<reason>" --review-by ' +
          '"<condition>", or steer the session to address the flags.',
      );
      expect(process.exitCode).toBe(1);
    });

    it('reports a rejected gate and exits 1', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue({
        status: 'rejected',
        report: { sessionId: 's1', passed: false, sandbox: 'sandbox-exec (macOS)', stages: [] },
        rejectCount: 1,
      });

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(logs).toContain('Gate failed; report re-injected into the session (rejection 1/2).');
      expect(process.exitCode).toBe(1);
    });

    it('reports a blocked gate and exits 1', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue({
        status: 'blocked',
        report: { sessionId: 's1', passed: false, sandbox: 'sandbox-exec (macOS)', stages: [] },
        rejectCount: 2,
      });

      buildProgram().parse(['merge', 's1'], { from: 'user' });

      expect(logs).toContain('Gate failed; session parked as blocked — needs a human.');
      expect(process.exitCode).toBe(1);
    });

    it('forwards --accept-debt/--review-by, defaulting acceptedBy to human', () => {
      useCwd(initRepoWithAdapter());
      vi.mocked(runMergeGate).mockReturnValue(mergedOutcome());

      buildProgram().parse(
        ['merge', 's1', '--accept-debt', 'shipped a shortcut', '--review-by', 'before v2'],
        { from: 'user' },
      );

      const [, request] = firstCall(runMergeGate);
      expect(request.acceptDebt).toEqual({
        reason: 'shipped a shortcut',
        reviewBy: 'before v2',
        acceptedBy: 'human',
      });
    });

    it('attributes accepted debt to the calling session when merge runs from inside it', () => {
      const repo = initRepoWithAdapter();
      useCwd(repo);
      seedSession(repo, 's1', repo);
      vi.mocked(runMergeGate).mockReturnValue(mergedOutcome());

      buildProgram().parse(
        ['merge', 's1', '--accept-debt', 'shipped a shortcut', '--review-by', 'before v2'],
        { from: 'user' },
      );

      const [, request] = firstCall(runMergeGate);
      expect(request.acceptDebt?.acceptedBy).toBe('s1');
    });

    it('throws when run outside any git repo (no project to resolve)', () => {
      useCwd(tempDir('pup-cli-noproj-'));

      expect(() => buildProgram().parse(['merge', 's1'], { from: 'user' })).toThrow();
    });
  });
});
