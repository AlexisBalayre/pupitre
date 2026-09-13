import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
    socket: `pup-conductor-${projectId}`,
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

// Test repos must not inherit the developer's global git config nor GIT_DIR & co.
// — when this suite runs inside a git hook (pre-commit), those would redirect
// every git call at the pupitre repo instead of the temp repo.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/**
 * A PATH with no `codegraph` on it, so the conductor's code graph is a property
 * of the test rather than of the machine running it (decision 51). `git` is
 * still reachable — the exclude line is written with it.
 */
const NO_CODEGRAPH_PATH = '/usr/bin:/bin';

describe('startConductor', () => {
  let home: string;
  beforeEach(() => {
    vi.clearAllMocks();
    // projectPaths writes the compiled profile under $HOME/.pupitre.
    home = realpathSync(mkdtempSync(join(tmpdir(), 'pup-conductor-home-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(console.error).mockRestore();
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
      mcpConfigPath: undefined,
    });
    // The kickoff goes to the pane the launch returned, with the compiled
    // context — the same shape a session's launch has (decision 46) — and
    // carries the socket that pane is on, or it would type into whatever wears
    // the id on the default server (decision 47).
    const [pane, prompt] = vi.mocked(kickoff).mock.calls[0] ?? [];
    expect(pane).toEqual({
      sessionId: `conductor-${projectId(REPO)}`,
      paneId: '%3',
      socket: `pup-conductor-${projectId(REPO)}`,
    });
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

/**
 * The conductor's graph is the main checkout's, indexed at `pup conductor start`
 * and served the way a session's worktree graph is (decision 51). The binary is
 * faked per docs/conventions/testing.md: what is under test is what pup asks
 * codegraph to index and what it then hands `claude`.
 */
describe('startConductor code graph', () => {
  let home: string;
  let repo: string;
  let cgLog: string;

  function gitIn(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
  }

  function fakeCodegraph(body: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-cg-bin-')));
    cgLog = join(dir, 'calls.log');
    writeFileSync(
      join(dir, 'codegraph'),
      ['#!/bin/sh', `printf '%s\\n' "$*" >> ${cgLog}`, body].join('\n'),
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', `${dir}:${NO_CODEGRAPH_PATH}`);
    return join(dir, 'codegraph');
  }

  const INDEXES = [
    'mkdir -p "$2/.codegraph"',
    'printf \'*\\n!.gitignore\\n\' > "$2/.codegraph/.gitignore"',
    'echo sqlite > "$2/.codegraph/codegraph.db"',
    'exit 0',
  ].join('\n');

  const cgCalls = (): string[] =>
    existsSync(cgLog) ? readFileSync(cgLog, 'utf8').split('\n').filter(Boolean) : [];

  const start = () =>
    startConductor({
      repoPath: repo,
      base: DEFAULT_BASE_PROFILE,
      claudeUserDir: join(home, '.claude'),
    });

  const launchedWith = () => vi.mocked(launchConductor).mock.calls.at(-1)?.[0];
  const kickoffContext = () => vi.mocked(kickoff).mock.calls.at(-1)?.[1];

  beforeEach(() => {
    vi.clearAllMocks();
    home = realpathSync(mkdtempSync(join(tmpdir(), 'pup-cg-cond-home-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', NO_CODEGRAPH_PATH);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-cg-cond-')));
    gitIn(repo, 'init', '-b', 'main');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(console.error).mockRestore();
  });

  // The main checkout, never a session worktree: the conductor plans and reviews
  // from what has merged, and the index it leaves behind is excluded because the
  // gate and the overlap radar read a clean tree.
  it('indexes the main checkout and leaves it clean', () => {
    fakeCodegraph(INDEXES);

    start();

    expect(cgCalls()).toEqual([`init ${repo} --yes`]);
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
  });

  it('launches claude against a compiled mcp.json pinned to the main checkout', () => {
    const binary = fakeCodegraph(INDEXES);

    start();

    const mcpConfigPath = launchedWith()?.mcpConfigPath as string;
    expect(mcpConfigPath).toBe(join(projectPaths(repo).conductorCompiledDir, 'mcp.json'));
    const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
    expect(config.mcpServers.codegraph.command).toBe(binary);
    expect(config.mcpServers.codegraph.args).toContain(repo);
  });

  // And it is told which checkout it is reading: an answer out of main reported
  // as a session's branch is the failure mode decision 51 pins the path against.
  it("names the main checkout in the conductor's code-graph section", () => {
    fakeCodegraph(INDEXES);

    start();

    expect(kickoffContext()).toContain('## Code graph');
    expect(kickoffContext()).toContain('codegraph_explore');
    expect(kickoffContext()).toContain('The main checkout is indexed');
  });

  // No graph, never the wrong one — and never at the cost of the window.
  it('withholds the mcp config when the index fails, and still opens the window', () => {
    fakeCodegraph('echo "out of disk" >&2\nexit 1');

    expect(start().paneId).toBe('%3');

    expect(launchedWith()?.mcpConfigPath).toBeUndefined();
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('without a code graph');
  });

  it('compiles no mcp.json and no section when the operator has no codegraph', () => {
    start();

    expect(existsSync(join(projectPaths(repo).conductorCompiledDir, 'mcp.json'))).toBe(false);
    expect(launchedWith()?.mcpConfigPath).toBeUndefined();
    expect(kickoffContext()).not.toContain('## Code graph');
  });
});
