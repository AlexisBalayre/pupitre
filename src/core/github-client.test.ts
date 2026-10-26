import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isCutOffByNode,
  originRepoSlug,
  readPullRequestReview,
  replyToReviewThread,
} from './github.client.js';

describe('originRepoSlug', () => {
  it('parses scp-style ssh remotes', () => {
    expect(originRepoSlug('git@github.com:owner/repo.git')).toBe('github.com/owner/repo');
  });

  it('parses https remotes with and without .git', () => {
    expect(originRepoSlug('https://github.com/owner/repo.git')).toBe('github.com/owner/repo');
    expect(originRepoSlug('https://ghe.example.com/owner/repo')).toBe('ghe.example.com/owner/repo');
  });

  it('parses ssh:// remotes', () => {
    expect(originRepoSlug('ssh://git@github.com/owner/repo.git')).toBe('github.com/owner/repo');
  });

  it('rejects remotes it cannot pin to a host repo, like local paths', () => {
    expect(() => originRepoSlug('/tmp/some/bare/repo')).toThrow('Cannot derive');
  });
});

describe('readPullRequestReview', () => {
  let ghDir: string;
  let originalPath: string | undefined;
  const HEAD = 'c'.repeat(40);
  const BOT = { __typename: 'Bot', login: 'github-actions' };
  /** The bot's review of the head that opened `opened` threads. */
  const review = (id: string, opened = 1, oid = HEAD, body = 'summary') => ({
    id,
    body,
    author: BOT,
    commit: { oid },
    comments: { totalCount: opened },
  });
  const NEWEST = 'PRR_newest';

  beforeEach(() => {
    ghDir = realpathSync(mkdtempSync(join(tmpdir(), 'pup-review-gh-')));
    originalPath = process.env.PATH;
    process.env.PATH = `${ghDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  /** A gh on PATH that logs its argv one per line and answers with `pullRequest`. */
  function ghAnswers(pullRequest: unknown): void {
    writeFileSync(
      join(ghDir, 'answer.json'),
      JSON.stringify({ data: { repository: { pullRequest } } }),
    );
    writeFileSync(
      join(ghDir, 'gh'),
      `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" | head -1 >> ${ghDir}/argv; done\ncat ${ghDir}/answer.json\n`,
      { mode: 0o755 },
    );
  }

  const read = () =>
    readPullRequestReview(
      ghDir,
      'https://ghe.example.com/owner/repo/pull/12',
      'ghe.example.com/owner/repo',
    );

  const thread = (fields: Record<string, unknown>, comment: Record<string, unknown> = {}) => ({
    id: 'PRRT_1',
    isResolved: false,
    path: 'src/a.ts',
    line: 4,
    originalLine: 2,
    comments: {
      nodes: [
        {
          author: BOT,
          pullRequestReview: { id: NEWEST },
          body: 'finding',
          isMinimized: false,
          ...comment,
        },
      ],
    },
    ...fields,
  });

  it("asks GraphQL on origin's host for the PR by owner, name and number", () => {
    ghAnswers({ state: 'OPEN', headRefOid: HEAD });

    read();

    const argv = readFileSync(join(ghDir, 'argv'), 'utf8').trim().split('\n');
    expect(argv).toEqual([
      'api',
      'graphql',
      '--hostname',
      'ghe.example.com',
      '-f',
      'query=query($owner: String!, $name: String!, $number: Int!) {',
      '-f',
      'owner=owner',
      '-f',
      'name=repo',
      '-F',
      'number=12',
    ]);
  });

  it("reads the bot's newest review, its status on the head and its unresolved threads", () => {
    ghAnswers({
      state: 'OPEN',
      headRefOid: HEAD,
      commits: {
        nodes: [
          {
            commit: {
              oid: HEAD,
              status: {
                context: { state: 'SUCCESS', description: '2 important finding(s)', creator: BOT },
              },
            },
          },
        ],
      },
      reviews: {
        nodes: [
          review('PRR_older', 1, 'd'.repeat(40)),
          review(NEWEST, 5),
          {
            id: 'PRR_user',
            author: { __typename: 'User', login: 'github-actions' },
            commit: { oid: 'e'.repeat(40) },
          },
        ],
      },
      reviewThreads: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          thread({ id: 'PRRT_older' }, { pullRequestReview: { id: 'PRR_older' } }),
          thread({ id: 'PRRT_open' }),
          thread({ id: 'PRRT_moved', path: null, line: null }),
          thread({ id: 'PRRT_resolved', isResolved: true }),
          thread({ id: 'PRRT_human' }, { author: { __typename: 'User', login: 'github-actions' } }),
          thread({ id: 7 }),
        ],
      },
    });

    expect(read()).toEqual({
      state: 'OPEN',
      head: HEAD,
      reviewedHead: HEAD,
      headStatus: { state: 'SUCCESS', description: '2 important finding(s)' },
      isRereviewAsked: false,
      openThreads: [
        {
          id: 'PRRT_open',
          path: 'src/a.ts',
          line: 4,
          body: 'finding',
          isEditedByOther: false,
          isMinimized: false,
        },
        {
          id: 'PRRT_moved',
          path: undefined,
          line: 2,
          body: 'finding',
          isEditedByOther: false,
          isMinimized: false,
        },
      ],
    });
  });

  // Anyone with write access can edit the bot's comment (decision 90).
  it('tells a finding someone other than the bot edited', () => {
    const edited = (editor: unknown, lastEditedAt: unknown = '2026-10-18T09:00:00Z') =>
      thread({ id: `PRRT_${String(lastEditedAt)}` }, { editor, lastEditedAt });
    ghAnswers({
      state: 'OPEN',
      headRefOid: HEAD,
      reviews: { nodes: [review(NEWEST, 5)] },
      reviewThreads: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          edited(null, null),
          edited(BOT),
          edited({ __typename: 'User', login: 'github-actions' }),
          // An editor gone from GitHub reads as nobody, so as not the bot.
          edited(null),
          edited({ __typename: 'User', login: 'alexis' }, null),
        ],
      },
    });

    expect(read().openThreads.map((open) => open.isEditedByOther)).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  // A comment hidden on GitHub is out of the reviewer's view, so it is not
  // relayed as the review; a field outside its shape reads as hidden.
  it('tells a finding hidden on GitHub', () => {
    ghAnswers({
      state: 'OPEN',
      headRefOid: HEAD,
      reviews: { nodes: [review(NEWEST, 5)] },
      reviewThreads: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          thread({ id: 'PRRT_shown' }),
          thread({ id: 'PRRT_hidden' }, { isMinimized: true }),
          thread({ id: 'PRRT_unread' }, { isMinimized: undefined }),
        ],
      },
    });

    expect(read().openThreads.map((open) => open.isMinimized)).toEqual([false, true, true]);
  });

  it('reads no status set by another creator, or on a commit that is not the head', () => {
    const status = (creator: unknown, oid = HEAD) => ({
      state: 'OPEN',
      headRefOid: HEAD,
      commits: {
        nodes: [
          { commit: { oid, status: { context: { state: 'SUCCESS', description: 'x', creator } } } },
        ],
      },
    });

    ghAnswers(status({ __typename: 'User', login: 'github-actions' }));
    expect(read().headStatus).toBeUndefined();

    ghAnswers(status(BOT, 'f'.repeat(40)));
    expect(read().headStatus).toBeUndefined();

    ghAnswers({ state: 'OPEN', headRefOid: HEAD });
    expect(read()).toEqual({
      state: 'OPEN',
      head: HEAD,
      reviewedHead: undefined,
      headStatus: undefined,
      isRereviewAsked: false,
      openThreads: [],
    });
  });

  // The workflow reviews the head again on its owner's `@claude review`, and
  // nothing marks the head meanwhile (decision 90).
  it("tells an `@claude review` the owner asked after the bot's status on the head", () => {
    const asked = (createdAt: unknown, statusAt: unknown = '2026-10-26T10:00:00Z') => ({
      state: 'OPEN',
      headRefOid: HEAD,
      commits: {
        nodes: [
          {
            commit: {
              oid: HEAD,
              status: {
                context: { state: 'FAILURE', description: 'x', createdAt: statusAt, creator: BOT },
              },
            },
          },
        ],
      },
      comments: {
        nodes: [{ body: 'now @CLAUDE REVIEW', createdAt, authorAssociation: 'OWNER' }],
      },
    });

    ghAnswers(asked('2026-10-26T10:05:00Z'));
    expect(read().isRereviewAsked).toBe(true);
    ghAnswers(asked('2026-10-26T09:55:00Z'));
    expect(read().isRereviewAsked).toBe(false);
    // A time outside its shape, on either side, reads as asked: the wait goes on.
    ghAnswers(asked(null));
    expect(read().isRereviewAsked).toBe(true);
    ghAnswers(asked('2026-10-26T09:55:00Z', 'yesterday'));
    expect(read().isRereviewAsked).toBe(true);
    // With no status of the bot's on the head, there is nothing stale to wait past.
    ghAnswers({ ...asked('2026-10-26T10:05:00Z'), commits: { nodes: [] } });
    expect(read().isRereviewAsked).toBe(false);
  });

  // Two runs on one head: the newest run's verdict is the review's (decision 90).
  it('reads only the threads the newest review opened, so a clean newest run reads clean', () => {
    const twoRuns = (newestOpened: string[]) => ({
      state: 'OPEN',
      headRefOid: HEAD,
      reviews: { nodes: [review('PRR_first'), review(NEWEST, newestOpened.length)] },
      reviewThreads: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          thread({ id: 'PRRT_first' }, { pullRequestReview: { id: 'PRR_first' } }),
          ...newestOpened.map((id) => thread({ id })),
        ],
      },
    });

    ghAnswers(twoRuns(['PRRT_again']));
    expect(read().openThreads.map((open) => open.id)).toEqual(['PRRT_again']);

    ghAnswers(twoRuns([]));
    expect(read().openThreads).toEqual([]);
  });

  // The poster's fallback when GitHub refuses its batch review: one bodiless
  // review per finding, then the summary with no thread (decision 90).
  it('reads the threads of a run the poster posted one finding at a time', () => {
    ghAnswers({
      state: 'OPEN',
      headRefOid: HEAD,
      reviews: {
        nodes: [
          review('PRR_before', 1, HEAD),
          review('PRR_one', 1, HEAD, ''),
          review('PRR_two', 1, HEAD, ''),
          review(NEWEST, 0),
        ],
      },
      reviewThreads: {
        pageInfo: { hasPreviousPage: true },
        nodes: [
          thread({ id: 'PRRT_before' }, { pullRequestReview: { id: 'PRR_before' } }),
          thread({ id: 'PRRT_one' }, { pullRequestReview: { id: 'PRR_one' } }),
          thread({ id: 'PRRT_two' }, { pullRequestReview: { id: 'PRR_two' } }),
        ],
      },
    });

    expect(read()).toMatchObject({
      reviewedHead: HEAD,
      openThreads: [{ id: 'PRRT_one' }, { id: 'PRRT_two' }],
    });
  });

  it("refuses a PR whose newest review's threads reach past the newest page", () => {
    ghAnswers({
      state: 'OPEN',
      headRefOid: HEAD,
      reviews: { nodes: [review(NEWEST, 2)] },
      reviewThreads: { pageInfo: { hasPreviousPage: true }, nodes: [thread({ id: 'PRRT_1' })] },
    });

    expect(read).toThrow(
      /more than 100 review threads, and the CI review's newest run opened some of them before the newest 100 one read returns; fix the PR by hand\./,
    );
  });

  // Older threads, resolved or an earlier review's, do not count toward the cap.
  it('reads a PR past the page whose newest review opened only threads on it', () => {
    ghAnswers({
      state: 'OPEN',
      headRefOid: HEAD,
      reviews: { nodes: [review(NEWEST, 2)] },
      reviewThreads: {
        pageInfo: { hasPreviousPage: true },
        nodes: [thread({ id: 'PRRT_1', isResolved: true }), thread({ id: 'PRRT_2' })],
      },
    });

    expect(read().openThreads.map((open) => open.id)).toEqual(['PRRT_2']);
  });

  it('refuses a url that is not a pull request before asking gh', () => {
    ghAnswers({});

    expect(() =>
      readPullRequestReview(
        ghDir,
        'https://github.com/owner/repo/issues/3',
        'github.com/owner/repo',
      ),
    ).toThrow(/Cannot read a review of/);
    expect(existsSync(join(ghDir, 'argv'))).toBe(false);
  });
});

// Node kills a child it cuts off with SIGTERM, which reads as an interrupt
// unless the caller tells the two apart by node's own `code`.
describe('isCutOffByNode', () => {
  const thrown = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error('expected a throw');
  };

  it('reads a child past its buffer or its timeout as cut off', () => {
    const overflow = thrown(() =>
      execFileSync('sh', ['-c', 'yes | head -c 1048576'], { maxBuffer: 16, stdio: 'pipe' }),
    );
    const late = thrown(() => execFileSync('sleep', ['5'], { timeout: 100, stdio: 'pipe' }));

    expect(overflow).toMatchObject({ code: 'ENOBUFS' });
    expect(isCutOffByNode(overflow)).toBe(true);
    expect(late).toMatchObject({ code: 'ETIMEDOUT', signal: 'SIGTERM' });
    expect(isCutOffByNode(late)).toBe(true);
  });

  it('reads an interrupt or a failing exit as no cut-off', () => {
    const interrupted = thrown(() => execFileSync('sh', ['-c', 'kill -INT $$'], { stdio: 'pipe' }));
    const failed = thrown(() => execFileSync('sh', ['-c', 'exit 3'], { stdio: 'pipe' }));

    expect(interrupted).toMatchObject({ signal: 'SIGINT' });
    expect(isCutOffByNode(interrupted)).toBe(false);
    expect(isCutOffByNode(failed)).toBe(false);
    expect(isCutOffByNode(new Error('plain'))).toBe(false);
  });
});

describe('replyToReviewThread', () => {
  it('refuses a repo with no host before asking gh', () => {
    expect(() => replyToReviewThread('/nowhere', '/owner/repo', 'PRRT_1', 'body')).toThrow(
      'Cannot read a GitHub host from /owner/repo.',
    );
  });
});
