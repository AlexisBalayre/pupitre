import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ProfileCompiler from '@src/core/profile-compiler.service.js';
import { makeInput } from '@test/helpers/profile-compiler.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real git and sh, and one case waits out the store's deadline.
vi.setConfig({ testTimeout: 30_000 });

// Decision 199: after a compaction a worker restarts from git and the store as
// they are, not from the summary's memory of them.
describe('the compact recap hook', () => {
  const GIT_ENV: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  let root: string;
  let repo: string;
  let worktree: string;
  let bin: string;
  let outDir: string;

  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).stdout.trim();

  function commit(cwd: string, path: string, content: string): void {
    writeFileSync(join(cwd, path), content);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', `add ${path}`);
  }

  beforeEach(() => {
    root = realpathSync(tempDir('pup-recap-hook-'));
    repo = join(root, 'repo');
    worktree = join(repo, '.worktrees', 's-1');
    bin = join(root, 'bin');
    outDir = join(root, 'compiled');
    mkdirSync(repo);
    mkdirSync(bin);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
    commit(repo, '.gitignore', '.worktrees/\n');
    git(repo, 'worktree', 'add', '-q', '-b', 'pup/s-1', worktree, 'main');
    commit(worktree, 'feature.ts', 'one\n');
    writeFileSync(join(worktree, 'draft.ts'), 'wip\n');
    const compiled = ProfileCompiler.compileProfile(
      makeInput({
        repoPath: repo,
        worktreePath: worktree,
        eventsFile: join(root, 'e.jsonl'),
        outDir,
      }),
    );
    ProfileCompiler.writeCompiledProfile(compiled, outDir);
  });

  /** A `pup` first on PATH, whose body stands in for the store's side. */
  function fakePup(body: string): void {
    writeFileSync(join(bin, 'pup'), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, 'pup'), 0o755);
  }

  function runRecap(env: NodeJS.ProcessEnv = {}) {
    return spawnSync('/bin/sh', [join(outDir, 'hooks', 'compact-recap.sh')], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }),
      cwd: root,
      encoding: 'utf8',
      timeout: 25_000,
      env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, PUP_SESSION_ID: 's-1', ...env },
    });
  }

  it('is wired on SessionStart, matched on compact only, ahead of any layer hook', () => {
    const compiled = ProfileCompiler.compileProfile(
      makeInput({
        repoPath: repo,
        worktreePath: worktree,
        eventsFile: join(root, 'e.jsonl'),
        outDir,
        role: {
          name: 'r',
          hooks: {
            SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'x' }] }],
          },
        },
      }),
    );

    const settings = JSON.parse(compiled.files['settings.json'] as string);
    expect(settings.hooks.SessionStart.map((entry: { matcher: string }) => entry.matcher)).toEqual([
      'compact',
      'startup',
    ]);
    expect(settings.hooks.SessionStart[0].hooks).toEqual([
      {
        type: 'command',
        command: join(outDir, 'hooks', 'compact-recap.sh'),
        timeout: expect.any(Number),
      },
    ]);
  });

  it("prints the branch head, the commits and dirty files, then the store's lines from the worktree", () => {
    fakePup('echo "Session state: running (s-1) from $(pwd -P) via $*"');

    const result = runRecap();

    expect(result.status).toBe(0);
    const head = git(worktree, 'rev-parse', 'HEAD');
    expect(result.stdout).toContain(`Branch head: pup/s-1 at ${head}`);
    expect(result.stdout).toContain("Commits past the main checkout's HEAD: 1");
    expect(result.stdout).toContain('add feature.ts');
    expect(result.stdout).toContain('Uncommitted files: 1\n  ?? draft.ts');
    expect(result.stdout).toContain(
      `Session state: running (s-1) from ${worktree} via session recap`,
    );
    expect(result.stdout).not.toContain('unknown');
  });

  it('still names the branch head, says the state is unknown and exits 0 when the store cannot be read', () => {
    fakePup('echo "Error: unable to open database file" >&2; exit 1');

    const result = runRecap();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Branch head: pup/s-1 at ${git(worktree, 'rev-parse', 'HEAD')}`,
    );
    expect(result.stdout).toContain('Session state: unknown — pup could not read the store');
    expect(result.stderr).toBe('');
  });

  it('falls back to node "$PUP_BIN" with no pup on PATH, and exits 0 when that fails too', () => {
    const result = runRecap({ PATH: '/usr/bin:/bin', PUP_BIN: join(root, 'no-such-pup.js') });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Branch head: pup/s-1 at');
    expect(result.stdout).toContain('Session state: unknown');
  });

  it('kills a pup that never answers at its deadline, keeping the git lines', () => {
    fakePup('exec sleep 60');

    const result = runRecap();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Branch head: pup/s-1 at');
    expect(result.stdout).toContain('Session state: unknown');
  });

  it('caps its output, however much the store prints', () => {
    fakePup(
      "i=0; while [ $i -lt 2000 ]; do echo 'Session state: running, padded to fill the cap'; i=$((i+1)); done",
    );

    const result = runRecap();

    expect(result.status).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(5_000);
    expect(result.stdout).toContain('Branch head: pup/s-1 at');
  });

  it("says git is unreadable, not a head, when the worktree's pointer was rewritten", () => {
    fakePup('echo "Session state: running (s-1)"');
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(root, 'elsewhere')}\n`);

    const result = runRecap();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Branch head: unreadable');
    expect(result.stdout).toContain('Session state: running (s-1)');
  });
});
