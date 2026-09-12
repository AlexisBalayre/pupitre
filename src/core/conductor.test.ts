import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tmux boundary only: the profile compiler and the filesystem run for
// real, per docs/conventions/testing.md.
vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  hasConductorWindow: vi.fn(() => true),
  kickoff: vi.fn(() => true),
  killConductor: vi.fn(),
  launchConductor: vi.fn(({ projectId }: { projectId: string }) => ({
    sessionId: `conductor-${projectId}`,
    paneId: '%3',
  })),
}));

import {
  hasConductorWindow,
  kickoff,
  killConductor,
  launchConductor,
} from '../claude/session-runtime.service.js';
import { isConductorRunning, startConductor, stopConductor } from './conductor.service.js';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { projectId, projectPaths } from './paths.utils.js';

const REPO = '/repo';

describe('startConductor', () => {
  let home: string;
  beforeEach(() => {
    vi.clearAllMocks();
    // projectPaths writes the compiled profile under $HOME/.pupitre.
    home = realpathSync(mkdtempSync(join(tmpdir(), 'pup-conductor-home-')));
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function start(overrides: { model?: string; workerModel?: string } = {}) {
    return startConductor({
      repoPath: REPO,
      base: DEFAULT_BASE_PROFILE,
      claudeUserDir: join(home, '.claude'),
      ...overrides,
    });
  }

  it('compiles the profile beside the sessions, opens the window on it, and kicks its context in', () => {
    const handle = start({ model: 'fable', workerModel: 'opus' });

    const outDir = projectPaths(REPO).conductorCompiledDir;
    expect(handle).toEqual({
      name: `pup-conductor-${projectId(REPO)}`,
      paneId: '%3',
      delivered: true,
    });
    expect(existsSync(join(outDir, 'settings.json'))).toBe(true);
    expect(existsSync(join(outDir, 'hooks', 'edit-block.sh'))).toBe(true);
    expect(launchConductor).toHaveBeenCalledWith({
      projectId: projectId(REPO),
      repoPath: REPO,
      settingsPath: join(outDir, 'settings.json'),
      model: 'fable',
    });
    // The kickoff goes to the pane the launch returned, with the compiled
    // context — the same shape a session's launch has (decision 46).
    const [pane, prompt] = vi.mocked(kickoff).mock.calls[0] ?? [];
    expect(pane).toEqual({ sessionId: `conductor-${projectId(REPO)}`, paneId: '%3' });
    expect(prompt).toBe(readFileSync(join(outDir, 'context.md'), 'utf8'));
    expect(prompt).toContain('pup launch <task> --model opus');
  });

  it('reports a window that never became ready rather than hiding it', () => {
    vi.mocked(kickoff).mockReturnValue(false);

    expect(start().delivered).toBe(false);
  });

  it('touches no store: the conductor is not a session', () => {
    start();

    expect(existsSync(projectPaths(REPO).dbFile)).toBe(false);
  });
});

describe('stopConductor and isConductorRunning', () => {
  it('kills and probes the window by the project id', () => {
    stopConductor(REPO);

    expect(killConductor).toHaveBeenCalledWith(projectId(REPO));
    expect(isConductorRunning(REPO)).toBe(true);
    expect(hasConductorWindow).toHaveBeenCalledWith(projectId(REPO));
  });
});
