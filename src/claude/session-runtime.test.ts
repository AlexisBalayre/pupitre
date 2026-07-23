import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { preseedTrust } from './session-runtime.service.js';

// Test repos must not inherit the developer's global git config nor GIT_DIR & co.
// — when this suite runs inside a git hook (pre-commit), those would redirect
// every git call at the pupitre repo instead of the temp repo.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cwd: string, ...args: string[]): void {
  execFileSync(args[0] as string, args.slice(1), { cwd, encoding: 'utf8', env: GIT_ENV });
}

function initRepoWithWorktree(): { repo: string; worktree: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-trust-')));
  sh(repo, 'git', 'init', '-b', 'main');
  sh(repo, 'git', 'config', 'user.email', 'trust@test');
  sh(repo, 'git', 'config', 'user.name', 'trust-test');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  sh(repo, 'git', 'add', '.');
  sh(repo, 'git', 'commit', '-m', 'init');
  sh(repo, 'git', 'worktree', 'add', join(repo, '.worktrees', 'wt'), '-b', 'feature/wt');
  return { repo, worktree: join(repo, '.worktrees', 'wt') };
}

function readProjects(claudeJsonPath: string): Record<string, Record<string, unknown>> {
  return (JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as Record<string, unknown>)
    .projects as Record<string, Record<string, unknown>>;
}

describe('preseedTrust', () => {
  it('seeds trust for the worktree AND the main repo root', () => {
    // Claude Code keys the trust dialog on the git common-dir root, so seeding
    // only the worktree path still leaves the dialog blocking kickoff.
    const { repo, worktree } = initRepoWithWorktree();
    const claudeJson = join(mkdtempSync(join(tmpdir(), 'pup-cfg-')), 'claude.json');

    preseedTrust(worktree, claudeJson);

    const projects = readProjects(claudeJson);
    expect(projects[worktree]?.hasTrustDialogAccepted).toBe(true);
    expect(projects[repo]?.hasTrustDialogAccepted).toBe(true);
  });

  it('preserves existing project entries and flips declined trust to accepted', () => {
    const { repo, worktree } = initRepoWithWorktree();
    const claudeJson = join(mkdtempSync(join(tmpdir(), 'pup-cfg-')), 'claude.json');
    writeFileSync(
      claudeJson,
      JSON.stringify({
        numStartups: 3,
        projects: { [repo]: { hasTrustDialogAccepted: false, allowedTools: ['Read'] } },
      }),
    );

    preseedTrust(worktree, claudeJson);

    const config = JSON.parse(readFileSync(claudeJson, 'utf8')) as Record<string, unknown>;
    expect(config.numStartups).toBe(3);
    const projects = readProjects(claudeJson);
    expect(projects[repo]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Read'] });
  });

  it('seeds only the launch path when it is not a git checkout', () => {
    const plainDir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-plain-')));
    const claudeJson = join(mkdtempSync(join(tmpdir(), 'pup-cfg-')), 'claude.json');

    preseedTrust(plainDir, claudeJson);

    const projects = readProjects(claudeJson);
    expect(projects[plainDir]?.hasTrustDialogAccepted).toBe(true);
    expect(Object.keys(projects)).toHaveLength(1);
  });

  it('writes a single entry when launching at the repo root itself', () => {
    const { repo } = initRepoWithWorktree();
    const claudeJson = join(mkdtempSync(join(tmpdir(), 'pup-cfg-')), 'claude.json');

    preseedTrust(repo, claudeJson);

    const projects = readProjects(claudeJson);
    expect(projects[repo]?.hasTrustDialogAccepted).toBe(true);
    expect(Object.keys(projects)).toHaveLength(1);
  });
});
