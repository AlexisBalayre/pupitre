import { realpathSync } from 'node:fs';
import { buildProgram } from '@src/cli/index.js';
import { initRepo, seedSession, worktreeOf } from '@test/helpers/cli-index.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No conductor runs in a test: its question is read against no run, as when none is up.
vi.mock('@src/claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/claude/session-runtime.service.js')>()),
  conductorRun: () => undefined,
}));

vi.setConfig({ testTimeout: 30_000 });

// Decision 199: the two verbs the compact hooks run, `pup conductor recap` and
// `pup session recap`, as the CLI gates and prints them.
describe('recap commands', () => {
  const originalExitCode = process.exitCode;
  let logs: string[];
  let errors: string[];
  let repo: string;
  let savedGitEnv: Record<string, string | undefined>;

  beforeEach(() => {
    process.exitCode = undefined;
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((message: string) => void logs.push(message));
    vi.spyOn(console, 'error').mockImplementation((message: string) => void errors.push(message));
    // State resolves under homedir(): a throwaway HOME keeps ~/.pupitre untouched.
    vi.stubEnv('HOME', tempDir('pup-recap-home-'));
    vi.stubEnv('PUP_SESSION_ID', '');
    vi.stubEnv('PUP_CONDUCTOR', '');
    // A pre-commit run leaves GIT_DIR & co. set, which would redirect the
    // CLI's own git calls at this repo instead of the fixture.
    savedGitEnv = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_')) {
        savedGitEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    repo = realpathSync(initRepo());
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedGitEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = originalExitCode;
  });

  const run = (...args: string[]) => buildProgram().parse(args, { from: 'user' });

  describe('pup conductor recap', () => {
    it('prints the fleet for the operator', () => {
      seedSession(repo, 's1');

      run('conductor', 'recap');

      expect(errors).toEqual([]);
      expect(process.exitCode).toBeUndefined();
      expect(logs).toEqual([
        'Sessions by state:',
        '  queued (1): s1',
        '  counted only: merged 0, killed 0',
        'Open PRs: none.',
        'Merge lock: free.',
        'Your unanswered question to the operator: none.',
      ]);
    });

    it('refuses a session, which reads its own', () => {
      seedSession(repo, 's1');
      vi.mocked(process.cwd).mockReturnValue(worktreeOf(repo, 's1'));

      run('conductor', 'recap');

      expect(errors).toEqual(['A session reads its own with `pup session recap`.']);
      expect(process.exitCode).toBe(1);
      expect(logs).toEqual([]);
    });

    it('is named among the actions an unknown one is refused with', () => {
      run('conductor', 'recount');

      expect(errors).toEqual([
        'Unknown conductor action `recount` (expected start|stop|tell|ask|recap).',
      ]);
      expect(process.exitCode).toBe(1);
    });

    it('refuses a message', () => {
      run('conductor', 'recap', 'hello');

      expect(errors).toEqual(['`pup conductor recap` takes no message.']);
      expect(process.exitCode).toBe(1);
      expect(logs).toEqual([]);
    });
  });

  describe('pup session recap', () => {
    it("prints the session's own state from inside its worktree", () => {
      seedSession(repo, 's1');
      vi.stubEnv('PUP_SESSION_ID', 's1');
      vi.mocked(process.cwd).mockReturnValue(worktreeOf(repo, 's1'));

      run('session', 'recap');

      expect(errors).toEqual([]);
      expect(logs).toEqual([
        'Session state: queued (s1), 0 rejections.',
        'Last gate: none run yet.',
        'Unanswered question to the operator: none.',
      ]);
    });

    it('refuses a caller outside any session', () => {
      run('session', 'recap');

      expect(errors).toEqual([
        'pup session recap must run inside a Pupitre session (PUP_SESSION_ID unset).',
      ]);
      expect(process.exitCode).toBe(1);
      expect(logs).toEqual([]);
    });
  });
});
