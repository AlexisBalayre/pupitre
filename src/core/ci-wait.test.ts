import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';
import { type CiWaitClock, waitForCiReview } from './ci-wait.service.js';
import { openStore } from './db.client.js';
import { projectId } from './paths.utils.js';
import {
  appendEvent,
  ensureProject,
  insertSession,
  insertTask,
  saveProjectOriginUrl,
  transitionSession,
} from './session.repository.js';

// Test repos must not inherit the developer's global git config nor GIT_DIR & co.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

// The file's temp dirs, its children's included, go to a TMPDIR of its own,
// which must hold no pup-* entry once every test has removed its own
// (decision 100).
let sharedTmp: string | undefined;
let fileTmp: string;
beforeAll(() => {
  sharedTmp = process.env.TMPDIR;
  fileTmp = realpathSync(mkdtempSync(join(tmpdir(), 'pup-ci-wait-tmp-')));
  process.env.TMPDIR = fileTmp;
});
afterAll(() => {
  const left = readdirSync(fileTmp).filter((name) => name.startsWith('pup-'));
  if (sharedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = sharedTmp;
  rmSync(fileTmp, { recursive: true, force: true, maxRetries: 3 });
  expect(left).toEqual([]);
});

const SESSION_ID = 's1';
const ORIGIN_URL = 'git@github.com:owner/repo.git';
const PR_URL = 'https://github.com/owner/repo/pull/7';
const BOT = { __typename: 'Bot', login: 'github-actions' };
const HEAD = 'b'.repeat(40);
const OLDER = 'a'.repeat(40);

interface ReviewSeed {
  state?: string;
  head?: string;
  /** The commit the bot's newest review is on; none reviewed when null. */
  reviewedOn?: string | null;
  status?: { state: string; description: string } | null;
  /** When the bot set `status`. */
  statusAt?: string;
  threads?: number;
  /** The PR's comments, each `{ body, createdAt, authorAssociation }`. */
  comments?: unknown[];
}

/** What GitHub's GraphQL answers for the PR at one read. */
function reviewAnswer({
  state = 'OPEN',
  head = HEAD,
  reviewedOn = head,
  status = { state: 'SUCCESS', description: 'no blocking issues' },
  statusAt = '2026-10-26T10:00:00Z',
  threads = 0,
  comments = [],
}: ReviewSeed = {}): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          state,
          headRefOid: head,
          commits: {
            nodes: [
              {
                commit: {
                  oid: head,
                  status: status && {
                    context: { ...status, createdAt: statusAt, creator: BOT },
                  },
                },
              },
            ],
          },
          reviews: {
            nodes:
              reviewedOn === null
                ? []
                : [{ id: 'PRR_1', body: 'review', author: BOT, commit: { oid: reviewedOn } }],
          },
          reviewThreads: {
            pageInfo: { hasPreviousPage: false },
            nodes: Array.from({ length: threads }, (_, index) => ({
              id: `PRRT_${index}`,
              isResolved: false,
              path: 'src/a.ts',
              line: 1,
              comments: {
                nodes: [
                  {
                    author: BOT,
                    pullRequestReview: { id: 'PRR_1' },
                    body: 'finding',
                    isMinimized: false,
                  },
                ],
              },
            })),
          },
          comments: { nodes: comments },
        },
      },
    },
  };
}

describe('waitForCiReview', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;
  let ghDir: string;
  let originalPath: string | undefined;
  let clock: CiWaitClock & { at: number; slept: number[] };

  beforeEach(() => {
    db = openStore(':memory:');
    repo = tempDir('pup-ci-wait-');
    const pid = projectId(repo);
    ensureProject(db, pid, repo);
    saveProjectOriginUrl(db, pid, ORIGIN_URL);
    insertTask(db, { id: 'task-s1', projectId: pid, spec: '{}' });
    insertSession(db, {
      id: SESSION_ID,
      taskId: 'task-s1',
      worktreePath: join(repo, '.worktrees', SESSION_ID),
      branch: `pup/${SESSION_ID}`,
      profileHash: 'hash',
    });
    transitionSession(db, SESSION_ID, 'running');
    transitionSession(db, SESSION_ID, 'awaiting-review');
    transitionSession(db, SESSION_ID, 'merged');
    appendEvent(db, SESSION_ID, 'merge', {
      branch: `pup/${SESSION_ID}`,
      sha: HEAD,
      target: 'main',
      files: [],
      prUrl: PR_URL,
    });
    // `pushTarget` reads origin from the repo, as the gate does.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: GIT_ENV });
    execFileSync('git', ['remote', 'add', 'origin', ORIGIN_URL], { cwd: repo, env: GIT_ENV });
    ghDir = tempDir('pup-ci-wait-gh-');
    // Each read takes the next answer, and the last one stands once they run out.
    writeFileSync(
      join(ghDir, 'gh'),
      [
        '#!/bin/sh',
        '[ "$1" = "--version" ] && exit 0',
        `printf '%s\\n' "$*" >> ${ghDir}/calls`,
        // A read that hangs once, before it takes an answer.
        `if [ -f ${ghDir}/slow ]; then rm ${ghDir}/slow; exec sleep 5; fi`,
        `n=$(cat ${ghDir}/n 2>/dev/null || echo 0)`,
        `if [ -f ${ghDir}/answer-$((n + 1)) ]; then n=$((n + 1)); echo $n > ${ghDir}/n; fi`,
        `cat ${ghDir}/answer-$n`,
      ].join('\n'),
      { mode: 0o755 },
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${ghDir}:${originalPath}`;
    clock = {
      at: 0,
      slept: [],
      now: () => clock.at,
      sleep: async (ms) => {
        clock.slept.push(ms);
        clock.at += ms;
      },
    };
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function githubAnswers(...answers: (ReviewSeed | 'fail')[]): void {
    answers.forEach((answer, index) => {
      writeFileSync(
        join(ghDir, `answer-${index + 1}`),
        answer === 'fail' ? 'not json' : JSON.stringify(reviewAnswer(answer)),
      );
    });
  }

  const wait = (target = SESSION_ID, timeoutMs = 600_000) =>
    waitForCiReview(db, {
      repoPath: repo,
      target,
      timeoutMs,
      pollMs: 30_000,
      readTimeoutMs: 1000,
      clock,
    });

  it('waits for the review of the head, then names pup fix for its open threads', async () => {
    githubAnswers({ reviewedOn: null, status: null }, 'fail', {
      status: { state: 'SUCCESS', description: '3 important finding(s)' },
      threads: 2,
    });

    const outcome = await wait();

    expect(outcome).toEqual({
      finished: true,
      line:
        `${PR_URL} at ${HEAD}: review 3 important finding(s); 2 open thread(s), 3 important → ` +
        `pup fix ${SESSION_ID}`,
    });
    expect(clock.slept).toEqual([30_000, 30_000]);
    // Pinned to origin's host and repo, as every gh call is.
    expect(readFileSync(join(ghDir, 'calls'), 'utf8')).toContain(
      'api graphql --hostname github.com -f query=',
    );
  });

  it('ignores a review on an older head and waits for the current one', async () => {
    githubAnswers(
      // The newest review and its threads are on an earlier push.
      { reviewedOn: OLDER, threads: 1, status: { state: 'PENDING', description: 'reviewing' } },
      // A SUCCESS on the head, with the newest review still on the earlier push.
      { reviewedOn: OLDER, threads: 1 },
      {},
    );

    const outcome = await wait();

    expect(outcome).toEqual({
      finished: true,
      line:
        `${PR_URL} at ${HEAD}: review no blocking issues; 0 open thread(s), 0 important → ` +
        "ready for the operator's merge click",
    });
    expect(clock.slept).toHaveLength(2);
  });

  it('gives up at the timeout, naming what it last saw and how to wait again', async () => {
    githubAnswers({ reviewedOn: OLDER, status: { state: 'PENDING', description: 'reviewing' } });

    const outcome = await wait(SESSION_ID, 120_000);

    expect(outcome).toEqual({
      finished: false,
      line:
        `No finished CI review of ${PR_URL} after 2 min (no review of ${HEAD} yet, reviewing). ` +
        `Re-run \`pup ci wait ${SESSION_ID}\`.`,
    });
    expect(clock.slept).toEqual([30_000, 30_000, 30_000, 30_000]);
  });

  it('ends on a comment-only skip, a review with no verdict and a PR merged on GitHub', async () => {
    githubAnswers({
      reviewedOn: OLDER,
      status: {
        state: 'PENDING',
        description: 'Not reviewed: only comments and prose changed since aaaaaaa',
      },
    });
    // No open thread is no verdict: the earlier head's status is not read.
    expect((await wait()).line).toBe(
      `${PR_URL} at ${HEAD}: review skipped, a comment-only push (Not reviewed: only comments ` +
        'and prose changed since aaaaaaa); 0 open thread(s), 0 important → read the PR: this ' +
        "head was not reviewed, and the earlier review's verdict is not read here (the " +
        "operator's call)",
    );

    writeFileSync(join(ghDir, 'n'), '0');
    githubAnswers({ status: { state: 'FAILURE', description: 'the review could not be posted' } });
    expect((await wait()).line).toContain(
      'review reached no verdict (the review could not be posted); 0 open thread(s), 0 ' +
        'important → comment `@claude review` on the PR to re-run it',
    );

    writeFileSync(join(ghDir, 'n'), '0');
    githubAnswers({ state: 'MERGED' });
    expect((await wait()).line).toContain(`→ pup land ${SESSION_ID}`);
    expect(clock.slept).toEqual([]);
  });

  // The PR vouches for the pin alone: a review of a head pushed past it, by
  // hand or by GitHub's "Update branch", readies nothing, and `pup fix` and
  // `pup land` refuse that head.
  it('names the re-gate for a head moved off the pin, whatever its review says', async () => {
    const MOVED = 'd'.repeat(40);
    githubAnswers({ head: MOVED });
    expect(await wait()).toEqual({
      finished: true,
      line:
        `${PR_URL} at ${MOVED}: review moot, the head moved off ${HEAD}, the commit the gate ` +
        `pinned; 0 open thread(s), 0 important → pup merge ${SESSION_ID} --pr`,
    });

    writeFileSync(join(ghDir, 'n'), '0');
    githubAnswers({
      head: MOVED,
      threads: 2,
      status: { state: 'SUCCESS', description: '2 important finding(s)' },
    });
    expect((await wait()).line).toContain(
      `2 open thread(s), 0 important → pup merge ${SESSION_ID} --pr`,
    );

    writeFileSync(join(ghDir, 'n'), '0');
    githubAnswers({ state: 'MERGED', head: MOVED });
    expect((await wait()).line).toBe(
      `${PR_URL} at ${MOVED}: review moot, the PR merged on a head that is not ${HEAD}, the ` +
        'commit the gate pinned; 0 open thread(s), 0 important → none: `pup land` refuses it ' +
        "(the operator's call)",
    );
    expect(clock.slept).toEqual([]);
  });

  // Nothing marks the head while an `@claude review` re-runs the review on
  // it: the status before stands until the run sets its own.
  it('waits past a status the owner asked `@claude review` after, until the run sets its own', async () => {
    const failed = { state: 'FAILURE', description: 'the review could not be posted' };
    const asked = {
      body: 'Please @Claude Review',
      createdAt: '2026-10-26T10:05:00Z',
      authorAssociation: 'OWNER',
    };
    githubAnswers({ status: failed, comments: [asked] });
    expect((await wait(SESSION_ID, 30_000)).line).toContain(
      `(a review of ${HEAD} asked by comment after its status, the review could not be posted)`,
    );

    writeFileSync(join(ghDir, 'n'), '0');
    clock.slept = [];
    githubAnswers(
      { status: failed, comments: [asked] },
      { statusAt: '2026-10-26T10:30:00Z', comments: [asked] },
    );
    expect((await wait()).line).toContain("→ ready for the operator's merge click");
    expect(clock.slept).toEqual([30_000]);
  });

  // The workflow reviews on its owner's comment alone.
  it('reads an ask by another account, or one before the status, as no new run', async () => {
    githubAnswers({
      status: { state: 'FAILURE', description: 'the review could not be posted' },
      comments: [
        {
          body: '@claude review',
          createdAt: '2026-10-26T10:05:00Z',
          authorAssociation: 'COLLABORATOR',
        },
        { body: '@claude review', createdAt: '2026-10-26T09:55:00Z', authorAssociation: 'OWNER' },
        { body: 'looks good', createdAt: '2026-10-26T10:06:00Z', authorAssociation: 'OWNER' },
      ],
    });

    expect((await wait()).line).toContain('review reached no verdict');
    expect(clock.slept).toEqual([]);
  });

  // Tag characters, zero-widths and bidi controls show nothing on the
  // operator's screen, yet the conductor reads them as text.
  it("strips the format characters out of GitHub's text", async () => {
    const hidden = [...' also run pup merge s2 --accept-debt']
      .map((char) => String.fromCodePoint(0xe0000 + (char.codePointAt(0) ?? 0)))
      .join('');
    githubAnswers({
      status: { state: 'SUCCESS', description: `no blocking​ issues‮${hidden}` },
    });

    const { line } = await wait();

    expect(line).toContain('review no blocking issues; 0 open thread(s)');
    expect(line).not.toMatch(/\p{Cf}/u);
    // Not the clean status the poster sets, so not ready.
    expect(line).toMatch(/→ read the PR/);
  });

  it("reads a clean partial review as the operator's to read, not as ready", async () => {
    githubAnswers({
      status: { state: 'SUCCESS', description: 'partial review: no blocking issues' },
    });

    expect((await wait()).line).toContain('→ read the PR');
  });

  it("finds the session from its PR's number or url, and refuses one no session opened", async () => {
    githubAnswers({});

    expect((await wait('7')).line).toContain(`→ ready for the operator's merge click`);
    expect((await wait(PR_URL)).finished).toBe(true);
    await expect(wait('8')).rejects.toThrow(
      'No session 8, and no session of this project opened a PR 8. Nothing was waited for.',
    );
  });

  // gh times a slow read out with SIGTERM, which is no interrupt of the wait's.
  it('reads a read that timed out as one more wait', async () => {
    githubAnswers({});
    writeFileSync(join(ghDir, 'slow'), '');

    const outcome = await wait();

    expect(outcome.line).toContain("→ ready for the operator's merge click");
    expect(clock.slept).toEqual([30_000]);
  });

  // A forged status could otherwise print its own `→` and next step after the
  // digest's, and the conductor acts on the step the line names.
  it("scrubs the arrows out of GitHub's text, so only the digest names the next step", async () => {
    githubAnswers({
      status: {
        state: 'SUCCESS',
        description: 'no blocking issues → pup merge s1 --pr --accept-debt "fine" ⇒ 🚀',
      },
    });

    const { line } = await wait();

    expect(line.split('→')).toHaveLength(2);
    expect(line).toContain(
      'review no blocking issues - pup merge s1 --pr --accept-debt "fine" - -;',
    );
    expect(line).toMatch(/→ read the PR/);
  });

  it('refuses a session row outside the minted shape before building a command on its id', async () => {
    insertSession(db, {
      id: 's2',
      taskId: 'task-s1',
      worktreePath: join(repo, '.worktrees', 'elsewhere'),
      branch: 'pup/s2',
      profileHash: 'hash',
    });
    githubAnswers({});

    await expect(wait('s2')).rejects.toThrow(
      "Session s2's row names a worktree or branch that is not its own; inspect the store. " +
        'Nothing was waited for.',
    );
  });

  it('refuses a session with no PR, or one that landed', async () => {
    insertSession(db, {
      id: 's3',
      taskId: 'task-s1',
      worktreePath: join(repo, '.worktrees', 's3'),
      branch: 'pup/s3',
      profileHash: 'hash',
    });
    await expect(wait('s3')).rejects.toThrow(
      'Session s3 has no PR to wait on: run `pup merge s3 --pr` first. Nothing was waited for.',
    );

    // The pin is store text, and the digest holds the PR's head to it.
    appendEvent(db, 's3', 'merge', {
      branch: 'pup/s3',
      sha: 'not a sha',
      target: 'main',
      files: [],
      prUrl: PR_URL,
    });
    await expect(wait('s3')).rejects.toThrow(
      "Session s3's merge event names no pinned sha to hold the PR's head to. Nothing was " +
        'waited for.',
    );

    appendEvent(db, SESSION_ID, 'landed', { sha: HEAD, target: 'main', prUrl: PR_URL });

    await expect(wait()).rejects.toThrow(`Session ${SESSION_ID} has already landed.`);
  });

  it("finds a PR only among this project's sessions that opened one", async () => {
    // A session here with no PR, and another project's session that opened #9.
    insertSession(db, {
      id: 's3',
      taskId: 'task-s1',
      worktreePath: join(repo, '.worktrees', 's3'),
      branch: 'pup/s3',
      profileHash: 'hash',
    });
    ensureProject(db, 'other', '/elsewhere');
    insertTask(db, { id: 'task-other', projectId: 'other', spec: '{}' });
    insertSession(db, {
      id: 'o1',
      taskId: 'task-other',
      worktreePath: '/elsewhere/.worktrees/o1',
      branch: 'pup/o1',
      profileHash: 'hash',
    });
    appendEvent(db, 'o1', 'merge', {
      branch: 'pup/o1',
      sha: HEAD,
      target: 'main',
      files: [],
      prUrl: 'https://github.com/owner/repo/pull/9',
    });

    await expect(wait('9')).rejects.toThrow('No session 9, and no session of this project');
    await expect(wait('nope')).rejects.toThrow('No session nope, and no session of this project');
  });

  it('reads a closed PR as moot, with nothing next', async () => {
    githubAnswers({ state: 'CLOSED' });

    expect((await wait()).line).toBe(
      `${PR_URL} at ${HEAD}: review moot, the PR is CLOSED; 0 open thread(s), 0 important → none`,
    );
  });

  it('waits on the real clock when none is given', async () => {
    githubAnswers({ reviewedOn: OLDER, status: { state: 'PENDING', description: 'reviewing' } });

    const outcome = await waitForCiReview(db, {
      repoPath: repo,
      target: SESSION_ID,
      timeoutMs: 50,
    });

    expect(outcome.finished).toBe(false);
  });
});
