import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from './index.js';

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

describe('CLI commands', () => {
  const originalExitCode = process.exitCode;
  let logs: string[];
  let errors: string[];
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let savedGitEnv: Record<string, string | undefined>;

  beforeEach(() => {
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
});
