import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { originRepoSlug, readPullRequestReview } from './github.client.js';

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
      nodes: [{ author: BOT, originalCommit: { oid: HEAD }, body: 'finding', ...comment }],
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
          { author: BOT, commit: { oid: 'd'.repeat(40) } },
          { author: BOT, commit: { oid: HEAD } },
          {
            author: { __typename: 'User', login: 'github-actions' },
            commit: { oid: 'e'.repeat(40) },
          },
        ],
      },
      reviewThreads: {
        pageInfo: { hasNextPage: false },
        nodes: [
          thread({ id: 'PRRT_open' }),
          thread(
            { id: 'PRRT_moved', path: null, line: null },
            { originalCommit: { oid: 'd'.repeat(40) } },
          ),
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
      openThreads: [
        { id: 'PRRT_open', path: 'src/a.ts', line: 4, raisedOn: HEAD, body: 'finding' },
        { id: 'PRRT_moved', path: undefined, line: 2, raisedOn: 'd'.repeat(40), body: 'finding' },
      ],
    });
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
      openThreads: [],
    });
  });

  it('refuses a PR with more threads than one read returns', () => {
    ghAnswers({ state: 'OPEN', reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] } });

    expect(read).toThrow(/more than 100 review threads/);
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
