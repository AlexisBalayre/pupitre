import { execFileSync } from 'node:child_process';
import { scrubbedGitEnv } from './git-diff.client.js';
import type { NewPullRequest, PullRequestRef } from './types/github.types.js';

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

interface ListedPullRequest {
  url?: unknown;
  baseRefName?: unknown;
  isCrossRepository?: unknown;
  autoMergeRequest?: unknown;
}

function ghJson(repoPath: string, args: string[]): unknown {
  const output = execFileSync('gh', args, {
    cwd: repoPath,
    encoding: 'utf8',
    timeout: GH_COMMAND_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: scrubbedGitEnv(),
  });
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Cannot parse \`gh ${args[1]}\` output as JSON:\n${output.trim()}`);
  }
}

/**
 * URL of the open PR pupitre may adopt for `ref.head`, if one exists. Probed
 * before the push so a retried `pup merge --pr` reuses the PR a previous run
 * opened instead of failing on re-create, and so a dead gh (auth, network)
 * aborts the merge before origin is mutated (decision 27).
 *
 * Adoption is a trust decision, not a lookup: `--head` matches a branch NAME,
 * and a session — which has a shell and the operator's ambient gh login — can
 * open its own PR for its own branch before the operator merges. Anything that
 * is not unambiguously the same change onto the same target is refused rather
 * than blessed, and the caller overwrites the description it did not write.
 */
export function findOpenPullRequest(repoPath: string, ref: PullRequestRef): string | undefined {
  const parsed = ghJson(repoPath, [
    'pr',
    'list',
    '--repo',
    ref.repo,
    '--head',
    ref.head,
    '--state',
    'open',
    '--limit',
    '2',
    '--json',
    'url,baseRefName,isCrossRepository,autoMergeRequest',
  ]);
  const matches = Array.isArray(parsed) ? (parsed as ListedPullRequest[]) : [];
  const [pr] = matches;
  if (!pr) return undefined;
  if (matches.length > 1) {
    throw new Error(
      `Several open pull requests use '${ref.head}' as their head branch; resolve that on GitHub, then re-run.`,
    );
  }
  if (typeof pr.url !== 'string') {
    throw new Error(`\`gh pr list\` returned an open PR for '${ref.head}' without a URL.`);
  }
  // A fork PR lives under the base repo's URL, so only isCrossRepository
  // separates "our branch on origin" from "someone else's branch, same name".
  if (pr.isCrossRepository === true) {
    throw new Error(`Open PR ${pr.url} for '${ref.head}' comes from a fork; refusing to adopt it.`);
  }
  if (pr.baseRefName !== ref.base) {
    throw new Error(
      `Open PR ${pr.url} for '${ref.head}' targets '${String(pr.baseRefName)}', not '${ref.base}'; refusing to adopt it.`,
    );
  }
  // Armed auto-merge would land the gated commits the moment the push satisfies
  // the pending checks — no operator click — while the CLI still says the PR is
  // theirs to merge. Refuse rather than make that message a lie.
  if (pr.autoMergeRequest) {
    throw new Error(`Open PR ${pr.url} has auto-merge armed; disable it, then re-run.`);
  }
  return pr.url;
}

/**
 * Replace an adopted PR's title and body with pupitre's mechanical ones. The
 * description of a PR pup did not write is unverifiable — it can carry a
 * forged gate report — so adoption overwrites it with the report the gate
 * actually produced (decision 27).
 */
export function rewritePullRequest(repoPath: string, url: string, pr: NewPullRequest): void {
  execFileSync(
    'gh',
    ['pr', 'edit', url, '--repo', pr.repo, '--title', pr.title, '--body-file', '-'],
    {
      cwd: repoPath,
      encoding: 'utf8',
      input: pr.body,
      timeout: GH_COMMAND_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: scrubbedGitEnv(),
    },
  );
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
