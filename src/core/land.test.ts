import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { buildDashboardSnapshot, needsYou } from './dashboard.service.js';
import { openStore } from './db.client.js';
import { landSession } from './land.service.js';
import { projectId } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  getProject,
  insertSession,
  insertTask,
  listEvents,
  saveProjectOriginUrl,
  transitionSession,
} from './session.repository.js';

// Test repos must not inherit the developer's global git config nor GIT_DIR &
// co., which a pre-commit hook run would aim at the pupitre repo instead.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0] as string, args.slice(1), {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim();
}

function commitIn(dir: string, file: string, content: string): string {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', '-c', 'user.email=l@test', '-c', 'user.name=land', 'commit', '-q', '-m', file);
  return sh(dir, 'git', 'rev-parse', 'HEAD');
}

const SESSION_ID = 's1';
const BRANCH = `pup/${SESSION_ID}`;
const ORIGIN_URL = 'git@github.com:owner/repo.git';
const PR_URL = 'https://github.com/owner/repo/pull/7';

const passingAdapter: Adapter = {
  id: 'fake',
  detect: () => true,
  gateCommands: () => [
    { stage: 'build', command: 'true', args: [] },
    { stage: 'test', command: 'true', args: [] },
    { stage: 'lint', command: 'true', args: [] },
  ],
};

// Real git repos, a bare origin and a sandboxed audit per test.
describe('landSession', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;
  let origin: string;
  let worktree: string;
  /** The commit the gate pinned and pushed: the branch tip. */
  let pinned: string;
  let ghLog: string;
  let originalPath: string | undefined;
  /** The audit stores the baseline under the id the repo path gives. */
  let pid: string;

  beforeEach(() => {
    db = openStore(':memory:');
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-land-repo-')));
    sh(repo, 'git', 'init', '-q', '-b', 'main');
    commitIn(repo, 'src/app.ts', 'export const app = 1;\n');
    // GitHub-shaped origin, rewritten by the operator's global config into a
    // local bare repo so the land's real fetch stays offline.
    const host = realpathSync(mkdtempSync(join(tmpdir(), 'pup-land-origin-')));
    origin = join(host, 'owner', 'repo.git');
    mkdirSync(origin, { recursive: true });
    sh(origin, 'git', 'init', '-q', '--bare', '-b', 'main');
    sh(repo, 'git', 'remote', 'add', 'origin', ORIGIN_URL);
    sh(repo, 'git', 'push', '-q', origin, 'main');
    const globalConfig = join(host, 'gitconfig');
    writeFileSync(globalConfig, `[url "${host}/"]\n\tinsteadOf = git@github.com:\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);

    pid = projectId(repo);
    ensureProject(db, pid, repo);
    saveProjectOriginUrl(db, pid, ORIGIN_URL);
    insertTask(db, { id: 'task-s1', projectId: pid, spec: '{}' });
    worktree = join(repo, '.worktrees', SESSION_ID);
    sh(repo, 'git', 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'HEAD');
    pinned = commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    sh(repo, 'git', 'push', '-q', origin, BRANCH);
    insertSession(db, {
      id: SESSION_ID,
      taskId: 'task-s1',
      worktreePath: worktree,
      branch: BRANCH,
      profileHash: 'hash',
    });
    transitionSession(db, SESSION_ID, 'running');
    transitionSession(db, SESSION_ID, 'awaiting-review');

    ghLog = join(host, 'gh-calls');
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.unstubAllEnvs();
  });

  /** What the gate's `--pr` merge leaves: the session merged, its PR on the event. */
  function seedPrMerge(prUrl: string | null = PR_URL): void {
    transitionSession(db, SESSION_ID, 'merged');
    appendEvent(db, SESSION_ID, 'merge', {
      branch: BRANCH,
      sha: pinned,
      target: 'main',
      files: ['src/feature.ts'],
      ...(prUrl === null ? {} : { prUrl }),
    });
  }

  /** GitHub's merge button: a merge commit of origin's main and `head` on origin's main. */
  function mergeOnGitHub(head = pinned): string {
    const base = sh(origin, 'git', 'rev-parse', 'main');
    const merge = sh(
      origin,
      'git',
      '-c',
      'user.email=gh@test',
      '-c',
      'user.name=github',
      'commit-tree',
      `${head}^{tree}`,
      '-p',
      base,
      '-p',
      head,
      '-m',
      'Merge pull request #7',
    );
    sh(origin, 'git', 'update-ref', 'refs/heads/main', merge);
    return merge;
  }

  /** A gh on PATH that records its argv and answers `pr view` with this JSON. */
  function fakeGh(answer: unknown): void {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-land-gh-')));
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${ghLog}\necho '${JSON.stringify(answer)}'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${originalPath}`;
  }

  const land = () =>
    landSession(db, { repoPath: repo, sessionId: SESSION_ID, adapters: [passingAdapter] });
  const mainSha = () => sh(repo, 'git', 'rev-parse', 'main');
  const hasTrackingRef = () => sh(repo, 'git', 'for-each-ref', 'refs/remotes/origin/main') !== '';
  const landedEvents = () => listEvents(db, SESSION_ID).filter((row) => row.type === 'landed');

  /** Nothing a refusal may touch moved. */
  function expectNothingChanged(mainBefore: string): void {
    expect(mainSha()).toBe(mainBefore);
    expect(existsSync(worktree)).toBe(true);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH)).not.toBe('');
    expect(landedEvents()).toEqual([]);
    expect(getProject(db, pid)?.baseline).toBeNull();
  }

  it('fast-forwards main, removes the worktree and branch, audits and records the land', () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({ state: 'MERGED', mergeCommit: { oid: merge } });

    const outcome = land();

    expect(outcome).toMatchObject({
      prUrl: PR_URL,
      mergeCommit: merge,
      target: 'main',
      targetSha: merge,
      fastForwarded: true,
      removedWorktree: true,
    });
    expect(outcome.keptBranch).toBeUndefined();
    expect(mainSha()).toBe(merge);
    // The checkout moved with the ref, not only the ref.
    expect(sh(repo, 'git', 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, 'src/feature.ts'), 'utf8')).toContain('feature');
    expect(sh(repo, 'git', 'rev-parse', 'refs/remotes/origin/main')).toBe(merge);
    expect(existsSync(worktree)).toBe(false);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH)).toBe('');
    expect(getProject(db, pid)?.baseline).not.toBeNull();
    expect(landedEvents().map((row) => JSON.parse(row.payload))).toEqual([
      { sha: merge, target: 'main', prUrl: PR_URL },
    ]);
    // Asked the way the gate asks gh: the PR by url, pinned to origin's repo.
    expect(readFileSync(ghLog, 'utf8').trim()).toBe(
      `pr view ${PR_URL} --repo github.com/owner/repo --json state,mergeCommit`,
    );
    // The inbox reads the event, so the PR no longer waits on the operator.
    expect(needsYou(buildDashboardSnapshot(db, repo, Date.now()))).toEqual([]);
  });

  it('refuses a second land of the same session', () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    fakeGh({ state: 'MERGED', mergeCommit: { oid: merge } });
    land();

    expect(land).toThrow('has already landed');
    expect(landedEvents()).toHaveLength(1);
  });

  // The gate's teardown keeps a branch that moved past the pin; so does the land.
  it('keeps a branch holding commits main does not', () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    commitIn(worktree, 'src/later.ts', 'export const later = 1;\n');
    fakeGh({ state: 'MERGED', mergeCommit: { oid: merge } });

    const outcome = land();

    expect(outcome.keptBranch).toBe(BRANCH);
    expect(sh(repo, 'git', 'branch', '--list', BRANCH)).not.toBe('');
    expect(mainSha()).toBe(merge);
  });

  it('refuses a session that is not merged, changing nothing', () => {
    const before = mainSha();
    fakeGh({ state: 'MERGED', mergeCommit: { oid: pinned } });

    expect(land).toThrow('is awaiting-review, not merged');
    expectNothingChanged(before);
    expect(existsSync(ghLog)).toBe(false);
  });

  it('refuses a merge that opened no PR, changing nothing', () => {
    seedPrMerge(null);
    const before = mainSha();
    fakeGh({ state: 'MERGED', mergeCommit: { oid: pinned } });

    expect(land).toThrow('opened no pull request');
    expectNothingChanged(before);
    expect(existsSync(ghLog)).toBe(false);
  });

  // The store is session-writable: a merge row can lack what the land checks against.
  it.each<[string, (pin: string) => Record<string, string>]>([
    ['no pinned sha', () => ({ target: 'main' })],
    ['a sha outside the pinned shape', () => ({ sha: '--upload-pack=x', target: 'main' })],
    ['no target', (pin) => ({ sha: pin })],
  ])('refuses a merge event with %s, changing nothing', (_label, fields) => {
    transitionSession(db, SESSION_ID, 'merged');
    db.prepare("INSERT INTO events (session_id, type, payload) VALUES (?, 'merge', ?)").run(
      SESSION_ID,
      JSON.stringify({ branch: BRANCH, files: [], prUrl: PR_URL, ...fields(pinned) }),
    );
    const before = mainSha();
    fakeGh({ state: 'MERGED', mergeCommit: { oid: pinned } });

    expect(land).toThrow('merge event names no pinned sha and target');
    expectNothingChanged(before);
    expect(existsSync(ghLog)).toBe(false);
  });

  // The audit is the land's last step; with nothing to measure it must not start.
  it('refuses with no adapter, changing nothing', () => {
    seedPrMerge();
    mergeOnGitHub();
    const before = mainSha();
    fakeGh({ state: 'MERGED', mergeCommit: { oid: pinned } });

    expect(() => landSession(db, { repoPath: repo, sessionId: SESSION_ID, adapters: [] })).toThrow(
      `No adapter for ${repo}; the audit after the land would measure nothing.`,
    );
    expectNothingChanged(before);
    expect(existsSync(ghLog)).toBe(false);
  });

  it('refuses a session the store does not hold', () => {
    const before = mainSha();

    expect(() =>
      landSession(db, { repoPath: repo, sessionId: 'nope', adapters: [passingAdapter] }),
    ).toThrow('No session nope. Nothing was landed.');
    expectNothingChanged(before);
  });

  it('refuses a merged session with no merge event, changing nothing', () => {
    transitionSession(db, SESSION_ID, 'merged');
    const before = mainSha();

    expect(land).toThrow('opened no pull request');
    expectNothingChanged(before);
  });

  it('refuses a MERGED answer that names no merge commit, changing nothing', () => {
    seedPrMerge();
    mergeOnGitHub();
    const before = mainSha();
    fakeGh({ state: 'MERGED', mergeCommit: null });

    expect(land).toThrow(`GitHub reports ${PR_URL} merged with no merge commit.`);
    expectNothingChanged(before);
    expect(hasTrackingRef()).toBe(false);
  });

  it('refuses when origin cannot be fetched, changing nothing', () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    rmSync(origin, { recursive: true, force: true });
    const before = mainSha();
    fakeGh({ state: 'MERGED', mergeCommit: { oid: merge } });

    expect(land).toThrow(`Fetching main from ${ORIGIN_URL} failed. Nothing was landed.`);
    expectNothingChanged(before);
  });

  it('refuses a local main with commits origin lacks, leaving it where it is', () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    sh(
      repo,
      'git',
      '-c',
      'user.email=l@test',
      '-c',
      'user.name=land',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'local',
    );
    const before = mainSha();
    fakeGh({ state: 'MERGED', mergeCommit: { oid: merge } });

    expect(land).toThrow(`Local main at ${before} has commits origin's main at ${merge} lacks`);
    expectNothingChanged(before);
  });

  // The checkout the fast-forward writes must be the target's, as at the gate.
  it('refuses when the main checkout is on another branch, moving nothing', () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    sh(repo, 'git', 'checkout', '-q', '-b', 'elsewhere');
    const before = mainSha();
    fakeGh({ state: 'MERGED', mergeCommit: { oid: merge } });

    expect(land).toThrow('The main checkout is on elsewhere, not main');
    expectNothingChanged(before);
  });

  // The gate's teardown usually removed both already; the land then has nothing to do there.
  it('lands a session whose worktree and branch are already gone', () => {
    seedPrMerge();
    const merge = mergeOnGitHub();
    sh(repo, 'git', 'worktree', 'remove', '--force', worktree);
    sh(repo, 'git', 'branch', '-q', '-D', BRANCH);
    fakeGh({ state: 'MERGED', mergeCommit: { oid: merge } });

    const outcome = land();

    expect(outcome.removedWorktree).toBe(false);
    expect(outcome.keptBranch).toBeUndefined();
    expect(mainSha()).toBe(merge);
    expect(landedEvents()).toHaveLength(1);
  });

  // The url is store text: one outside origin's repo would land on another PR's word.
  it("refuses a PR url outside origin's repo, asking gh nothing", () => {
    seedPrMerge('https://github.com/elsewhere/repo/pull/7');
    const before = mainSha();
    fakeGh({ state: 'MERGED', mergeCommit: { oid: pinned } });

    expect(land).toThrow('is not a pull request of github.com/owner/repo');
    expectNothingChanged(before);
    expect(existsSync(ghLog)).toBe(false);
  });

  it.each(['OPEN', 'CLOSED'])('refuses when gh says the PR is %s, changing nothing', (state) => {
    seedPrMerge();
    mergeOnGitHub();
    const before = mainSha();
    fakeGh({ state, mergeCommit: null });

    expect(land).toThrow(`${PR_URL} is ${state} on GitHub, not MERGED`);
    expectNothingChanged(before);
    expect(hasTrackingRef()).toBe(false);
  });

  // A squash merge puts other commits on main than the ones the gate measured.
  it("refuses when origin's main does not contain the pinned sha, changing nothing", () => {
    seedPrMerge();
    // The pinned tree on one new commit over origin's main, as GitHub squashes.
    const squash = sh(
      origin,
      'git',
      '-c',
      'user.email=gh@test',
      '-c',
      'user.name=github',
      'commit-tree',
      `${pinned}^{tree}`,
      '-p',
      'main',
      '-m',
      'Squashed (#7)',
    );
    sh(origin, 'git', 'update-ref', 'refs/heads/main', squash);
    const before = mainSha();
    fakeGh({ state: 'MERGED', mergeCommit: { oid: squash } });

    expect(land).toThrow(`does not contain ${pinned}`);
    expectNothingChanged(before);
    expect(hasTrackingRef()).toBe(false);
  });
});
