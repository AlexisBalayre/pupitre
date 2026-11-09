import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/temp-dir.mock.js';
import {
  commentOnPullRequest,
  isCutOffByNode,
  originRepoSlug,
  readPullRequestReview,
  replyToReviewThread,
} from './github.client.js';

// The file's temp dirs, its children's included, go to a TMPDIR of its own,
// which must hold no pup-* entry once every test has removed its own
// (decision 100).
let sharedTmp: string | undefined;
let fileTmp: string;
beforeAll(() => {
  sharedTmp = process.env.TMPDIR;
  fileTmp = realpathSync(mkdtempSync(join(tmpdir(), 'pup-github-client-tmp-')));
  process.env.TMPDIR = fileTmp;
});
afterAll(() => {
  const left = readdirSync(fileTmp).filter((name) => name.startsWith('pup-'));
  if (sharedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = sharedTmp;
  rmSync(fileTmp, { recursive: true, force: true, maxRetries: 3 });
  expect(left).toEqual([]);
});

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
  /** The bot's review of `oid`, the head unless named. */
  const review = (oid = HEAD) => ({ author: BOT, commit: { oid } });

  beforeEach(() => {
    ghDir = tempDir('pup-review-gh-');
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
    isOutdated: false,
    path: 'src/a.ts',
    line: 4,
    originalLine: 2,
    comments: {
      nodes: [
        {
          author: BOT,
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
          review('d'.repeat(40)),
          review(),
          {
            author: { __typename: 'User', login: 'github-actions' },
            commit: { oid: 'e'.repeat(40) },
          },
        ],
      },
      reviewThreads: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          thread({ id: 'PRRT_open' }),
          thread({ id: 'PRRT_moved', path: null, line: null }),
          thread({ id: 'PRRT_resolved', isResolved: true }),
          thread({ id: 'PRRT_outdated', isOutdated: true }),
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
          isAnswered: false,
        },
        {
          id: 'PRRT_moved',
          path: undefined,
          line: 2,
          body: 'finding',
          isEditedByOther: false,
          isMinimized: false,
          isAnswered: false,
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
      reviews: { nodes: [review()] },
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
      reviews: { nodes: [review()] },
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

  // A fix round replies on each thread it relays and leaves the ones it does not
  // resolve open: only its own marked reply, still the last word, answers one.
  it("tells a thread whose last comment is a fix round's own reply", () => {
    const MARKED = `Declined: a false positive.\n\n<!-- pup fix-round ${'d'.repeat(40)} -->`;
    const last = (comment: unknown) => ({ nodes: [comment] });
    ghAnswers({
      state: 'OPEN',
      headRefOid: HEAD,
      reviews: { nodes: [review()] },
      reviewThreads: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          thread({
            id: 'PRRT_answered',
            lastComment: last({ body: MARKED, viewerDidAuthor: true }),
          }),
          // Someone else quoting the marker answers nothing.
          thread({
            id: 'PRRT_quoted',
            lastComment: last({ body: MARKED, viewerDidAuthor: false }),
          }),
          // pup's own hand reply, unmarked, is not a round's.
          thread({
            id: 'PRRT_own',
            lastComment: last({ body: 'Looking.', viewerDidAuthor: true }),
          }),
          thread({ id: 'PRRT_unread', lastComment: last({ body: MARKED }) }),
          thread({ id: 'PRRT_bare' }),
        ],
      },
    });

    expect(read().openThreads.map((open) => open.isAnswered)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
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
    // A full page of comments, none from before the status, may hide an ask
    // on the page before it; one from before shows the whole span was read.
    const fullPage = (createdAt: string[]) => ({
      ...asked('2026-10-26T09:55:00Z'),
      comments: {
        pageInfo: { hasPreviousPage: true },
        nodes: createdAt.map((at) => ({ body: 'noise', createdAt: at, authorAssociation: 'NONE' })),
      },
    });
    ghAnswers(fullPage(['2026-10-26T10:01:00Z', '2026-10-26T10:02:00Z']));
    expect(read().isRereviewAsked).toBe(true);
    ghAnswers(fullPage(['2026-10-26T09:59:00Z', '2026-10-26T10:02:00Z']));
    expect(read().isRereviewAsked).toBe(false);
  });

  // On #284, a run's clean status hid a thread an earlier run left open on the
  // same head: every open thread counts until it is resolved or outdated.
  it('reads a thread an earlier review left open, and none a push outdated', () => {
    const twoRuns = (isOutdated: unknown) => ({
      state: 'OPEN',
      headRefOid: HEAD,
      reviews: { nodes: [review('d'.repeat(40)), review(), review()] },
      reviewThreads: {
        pageInfo: { hasPreviousPage: false },
        nodes: [thread({ id: 'PRRT_first', isOutdated })],
      },
    });

    ghAnswers(twoRuns(false));
    expect(read().openThreads.map((open) => open.id)).toEqual(['PRRT_first']);
    // Only a plain `true` outdates a thread: a field outside its shape stays open.
    ghAnswers(twoRuns(null));
    expect(read().openThreads.map((open) => open.id)).toEqual(['PRRT_first']);

    ghAnswers(twoRuns(true));
    expect(read().openThreads).toEqual([]);
  });

  // An open thread may hide on the page before the read, whatever is on it.
  it('refuses a PR whose threads reach past the newest page', () => {
    ghAnswers({
      state: 'OPEN',
      headRefOid: HEAD,
      reviews: { nodes: [review()] },
      reviewThreads: {
        pageInfo: { hasPreviousPage: true },
        nodes: [thread({ id: 'PRRT_1', isResolved: true })],
      },
    });

    expect(read).toThrow(
      /more than 100 review threads, and an open one may be among those before the newest 100 one read returns; fix the PR by hand\./,
    );
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

// gh runs git with the main checkout as its cwd, and a session can write that
// checkout's config: a `core.fsmonitor` there would run on gh's first index
// read unless gh's git takes pup's pins (decision 89).
describe('the git gh runs', () => {
  let originalPath: string | undefined;
  beforeEach(() => {
    originalPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  const plainEnv: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };

  /** A repo whose config arms a `core.fsmonitor` that logs to `fired`, and a gh that runs `git status` in it. */
  function armedCheckout(): { repo: string; fired: string } {
    const repo = tempDir('pup-gh-git-');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: plainEnv });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
    const fired = join(repo, '.git', 'fired');
    const monitor = join(repo, '.git', 'planted-fsmonitor');
    writeFileSync(monitor, `#!/bin/sh\necho fsmonitor >> ${fired}\nexit 1\n`, { mode: 0o755 });
    git('config', 'core.fsmonitor', monitor);
    const ghDir = join(repo, '.git', 'fake-gh');
    mkdirSync(ghDir);
    writeFileSync(join(ghDir, 'gh'), '#!/bin/sh\ncat > /dev/null\ngit status > /dev/null\n', {
      mode: 0o755,
    });
    process.env.PATH = `${ghDir}:${originalPath}`;
    return { repo, fired };
  }

  // The control: the planted monitor is live for a git with the plain environment.
  it('runs in a checkout where a plain git status fires the planted fsmonitor', () => {
    const { repo, fired } = armedCheckout();
    execFileSync('git', ['status'], { cwd: repo, env: plainEnv, stdio: 'ignore' });

    expect(readFileSync(fired, 'utf8')).toContain('fsmonitor');
  });

  it("does not run the checkout's core.fsmonitor on gh's git", () => {
    const { repo, fired } = armedCheckout();

    commentOnPullRequest(repo, 'https://github.com/o/r/pull/1', 'github.com/o/r', 'body');

    expect(existsSync(fired)).toBe(false);
  });
});
