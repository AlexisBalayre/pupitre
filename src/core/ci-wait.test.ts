import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  threads?: number;
}

/** What GitHub's GraphQL answers for the PR at one read. */
function reviewAnswer({
  state = 'OPEN',
  head = HEAD,
  reviewedOn = head,
  status = { state: 'SUCCESS', description: 'no blocking issues' },
  threads = 0,
}: ReviewSeed = {}): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          state,
          headRefOid: head,
          commits: {
            nodes: [
              { commit: { oid: head, status: status && { context: { ...status, creator: BOT } } } },
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
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pup-ci-wait-')));
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
    ghDir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-ci-wait-gh-')));
    // Each read takes the next answer, and the last one stands once they run out.
    writeFileSync(
      join(ghDir, 'gh'),
      [
        '#!/bin/sh',
        '[ "$1" = "--version" ] && exit 0',
        `printf '%s\\n' "$*" >> ${ghDir}/calls`,
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
    waitForCiReview(db, { repoPath: repo, target, timeoutMs, pollMs: 30_000, clock });

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
    expect((await wait()).line).toBe(
      `${PR_URL} at ${HEAD}: review skipped, a comment-only push (Not reviewed: only comments ` +
        'and prose changed since aaaaaaa); 0 open thread(s), 0 important → ready for the ' +
        "operator's merge click",
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

  it('refuses a session with no PR, or one that landed', async () => {
    appendEvent(db, SESSION_ID, 'landed', { sha: HEAD, target: 'main', prUrl: PR_URL });

    await expect(wait()).rejects.toThrow(`Session ${SESSION_ID} has already landed.`);
  });
});
