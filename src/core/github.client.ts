import { execFileSync } from 'node:child_process';
import { scrubbedGitEnv } from './git-diff.client.js';
import type { NewPullRequest } from './types/github.types.js';

// GitHub interaction goes through the operator's `gh` CLI and its normal
// interactive login (the decision-12 rationale) — never tokens or keys.

/** Version probe is local; PR creation talks to GitHub and gets a network budget. */
const GH_PROBE_TIMEOUT_MS = 10_000;
const GH_COMMAND_TIMEOUT_MS = 60_000;

/** `git@host:owner/repo.git`, `https://host/owner/repo`, `ssh://git@host/owner/repo.git`. */
const REMOTE_URL = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/;

/** Fail before the gate runs, not after ten minutes of stages. */
export function assertGhAvailable(): void {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore', timeout: GH_PROBE_TIMEOUT_MS });
  } catch {
    throw new Error('`pup merge --pr` needs the `gh` CLI on PATH, logged in to GitHub.');
  }
}

/**
 * `HOST/OWNER/REPO` for gh's `--repo` from the origin URL. Pinning is the
 * point: without it gh resolves the base repo itself — in a forked clone that
 * is the upstream parent, and `GH_REPO`/`GH_HOST` retarget it silently — and a
 * PR full of session-authored code must never land somewhere the operator
 * didn't point `origin` at.
 */
export function originRepoSlug(originUrl: string): string {
  const match = REMOTE_URL.exec(originUrl.trim());
  if (!match) {
    throw new Error(`Cannot derive the GitHub repo from origin URL '${originUrl}'.`);
  }
  return `${match[1]}/${match[2]}`;
}

export function createPullRequest(repoPath: string, pr: NewPullRequest): string {
  return execFileSync(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      pr.repo,
      '--head',
      pr.head,
      '--base',
      pr.base,
      '--title',
      pr.title,
      '--body-file',
      '-',
    ],
    {
      cwd: repoPath,
      encoding: 'utf8',
      // Body over stdin: argv is visible in `ps` and has length limits.
      input: pr.body,
      timeout: GH_COMMAND_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: scrubbedGitEnv(),
    },
  ).trim();
}
