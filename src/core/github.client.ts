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

/** Fail before any work starts, not partway through; `command` names the caller in the refusal. */
export function assertGhAvailable(command: string): void {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore', timeout: GH_PROBE_TIMEOUT_MS });
  } catch {
    throw new Error(`${command} needs the \`gh\` CLI on PATH, logged in to GitHub.`);
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

function ghJson(repoPath: string, args: string[], timeout = GH_COMMAND_TIMEOUT_MS): unknown {
  const output = execFileSync('gh', args, {
    cwd: repoPath,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: scrubbedGitEnv(),
  });
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Cannot parse \`gh ${args[1]}\` output as JSON:\n${output.trim()}`);
  }
}

/** `gh pr view` of the PR at `url`, pinned to `repo`, as the fields asked for. */
function viewPullRequest(
  repoPath: string,
  url: string,
  repo: string,
  fields: string[],
): Record<string, unknown> {
  return objectFields(
    ghJson(repoPath, ['pr', 'view', url, '--repo', repo, '--json', fields.join(',')]),
  );
}

/** gh's JSON as an object; anything else has no fields, so each reads as absent. */
function objectFields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
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

/**
 * Refuse unless the PR at `url` has `sha` as its head, read back from GitHub
 * after the PR was created or adopted. The body pupitre wrote vouches for the
 * commit the gate measured and pushed and for nothing else, and a session with
 * the operator's ambient gh login can push its branch between pup's push and
 * the PR call. This only answers for the moment it reads: GitHub can still
 * move the head later, and the body says which sha it describes (decision 82).
 */
export function assertPullRequestHead(
  repoPath: string,
  url: string,
  repo: string,
  sha: string,
): void {
  const head = viewPullRequest(repoPath, url, repo, ['headRefOid']).headRefOid;
  if (head !== sha) {
    throw new Error(
      `PR ${url} has its head at ${typeof head === 'string' ? head : 'an unreadable commit'}, ` +
        `not at ${sha}, the commit the gate measured and pushed; its description vouches for ` +
        `${sha} only. The session is not merged. Find out who pushed the branch, close or ` +
        'fix the PR, then re-run.',
    );
  }
}

/**
 * What GitHub says became of the PR at `url`: its state (`OPEN`, `CLOSED`,
 * `MERGED`), its head, its base branch and, once merged, the commit the merge
 * made on that base. Pinned to `repo` like every other call here. A field
 * outside its shape reads as absent, so the caller refuses rather than
 * trusting it.
 */
export function readPullRequestLanding(
  repoPath: string,
  url: string,
  repo: string,
): {
  state: string | undefined;
  head: string | undefined;
  base: string | undefined;
  mergeCommit: string | undefined;
} {
  const fields = viewPullRequest(repoPath, url, repo, [
    'state',
    'headRefOid',
    'baseRefName',
    'mergeCommit',
  ]);
  const commit = objectFields(fields.mergeCommit).oid;
  return {
    state: typeof fields.state === 'string' ? fields.state : undefined,
    head: typeof fields.headRefOid === 'string' ? fields.headRefOid : undefined,
    base: typeof fields.baseRefName === 'string' ? fields.baseRefName : undefined,
    mergeCommit: typeof commit === 'string' ? commit : undefined,
  };
}

/**
 * The claude-review workflow's poster writes with the job's own token, so
 * GitHub names the Actions bot as the author of its reviews and threads
 * (`tools/review/src/post-review.script.ts`); GraphQL drops the `[bot]`. The
 * login vouches that no user wrote the text, not that the CI review did: every
 * workflow writes as this bot (decision 90).
 */
const REVIEW_BOT_LOGIN = 'github-actions';
/** The commit status the poster pins to the head it reviewed, its verdict in a line. */
const REVIEW_STATUS_CONTEXT = 'claude-review';
/**
 * GraphQL's page cap: the newest reviews and threads are read, and a PR whose
 * newest review run's threads reach past the page is refused rather than half read.
 */
const REVIEW_PAGE = 100;

const PULL_REQUEST_REVIEW_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            oid
            status {
              context(name: "${REVIEW_STATUS_CONTEXT}") {
                state
                description
                creator { __typename login }
              }
            }
          }
        }
      }
      reviews(last: ${REVIEW_PAGE}) {
        nodes { id body author { __typename login } commit { oid } comments { totalCount } }
      }
      reviewThreads(last: ${REVIEW_PAGE}) {
        pageInfo { hasPreviousPage }
        nodes {
          id
          isResolved
          path
          line
          originalLine
          comments(first: 1) {
            nodes {
              author { __typename login }
              pullRequestReview { id }
              body
              isMinimized
              lastEditedAt
              editor { __typename login }
            }
          }
        }
      }
    }
  }
}`;

/** One unresolved thread the review bot opened: its first comment is the finding. */
export interface ReviewThread {
  id: string;
  path: string | undefined;
  /** The line on the head, or the one it was left on once the code moved under it. */
  line: number | undefined;
  body: string;
  /**
   * Someone other than the bot edited the finding after it was posted, as
   * anyone with write access can: the body is no longer the bot's text.
   */
  isEditedByOther: boolean;
  /**
   * Someone hid the finding on GitHub, as an injection attempt is hidden. True
   * for anything GitHub answered but a plain `false`, so a field outside its
   * shape never reads as shown.
   */
  isMinimized: boolean;
}

export interface PullRequestReview {
  state: string | undefined;
  head: string | undefined;
  /** The commit the bot's newest review is on; undefined when it has not reviewed. */
  reviewedHead: string | undefined;
  /** The bot's `claude-review` status on the head: its verdict, or why it reached none. */
  headStatus: { state: string; description: string } | undefined;
  /** The unresolved threads the bot's newest review run opened, in GitHub's order. */
  openThreads: ReviewThread[];
}

function isReviewBot(author: unknown): boolean {
  const fields = objectFields(author);
  return fields.__typename === 'Bot' && fields.login === REVIEW_BOT_LOGIN;
}

function nodesOf(connection: unknown): Record<string, unknown>[] {
  const nodes = objectFields(connection).nodes;
  return Array.isArray(nodes) ? nodes.map(objectFields) : [];
}

/**
 * What the CI review said on the PR at `url` (decision 90): its state and
 * head, the commit the review bot last reviewed, the status it pinned to the
 * head, and the threads that newest review run opened that nobody resolved. One
 * GraphQL read, so all of it describes the same moment, pinned to `repo`'s
 * host and name like every other call here. Every string in it is GitHub's
 * copy of text a session's code shaped — a path, a finding quoting that code —
 * so it is data for the caller to scrub, and a field outside its shape reads
 * as absent.
 */
export function readPullRequestReview(
  repoPath: string,
  url: string,
  repo: string,
  timeoutMs?: number,
): PullRequestReview {
  const pr = queryPullRequest(repoPath, url, repo, PULL_REQUEST_REVIEW_QUERY, timeoutMs);
  const run = newestReviewRun(pr.reviews);
  const reviewedHead = objectFields(run[0]?.commit).oid;
  const head = typeof pr.headRefOid === 'string' ? pr.headRefOid : undefined;
  // Two review runs on one head each open their threads: only the newest's
  // are the review's verdict, so a clean newest run reads clean.
  const runIds = new Set<unknown>(
    run.map((review) => review.id).filter((id) => typeof id === 'string'),
  );
  const threads = objectFields(pr.reviewThreads);
  const newest = nodesOf(threads).filter((thread) =>
    runIds.has(objectFields(nodesOf(thread.comments)[0]?.pullRequestReview).id),
  );
  const opened = run.reduce((sum, review) => {
    const count = objectFields(review.comments).totalCount;
    return sum + (Number.isSafeInteger(count) ? (count as number) : Number.NaN);
  }, 0);
  // Threads come oldest first, so the unread ones are older: they matter only
  // when the newest run opened more than the page holds of its own.
  if (
    objectFields(threads.pageInfo).hasPreviousPage === true &&
    run.length > 0 &&
    newest.length !== opened
  ) {
    throw new Error(
      `${url} has more than ${REVIEW_PAGE} review threads, and the CI review's newest run ` +
        `opened some of them before the newest ${REVIEW_PAGE} one read returns; fix the PR by ` +
        'hand.',
    );
  }
  return {
    state: typeof pr.state === 'string' ? pr.state : undefined,
    head,
    reviewedHead: typeof reviewedHead === 'string' ? reviewedHead : undefined,
    headStatus: reviewStatusOn(pr.commits, head),
    openThreads: newest.flatMap((thread): ReviewThread[] => {
      const [finding] = nodesOf(thread.comments);
      if (thread.isResolved !== false || typeof thread.id !== 'string') return [];
      if (!finding || !isReviewBot(finding.author)) return [];
      const line = [thread.line, thread.originalLine].find(Number.isSafeInteger);
      // An edit names its editor; one gone from GitHub reads as nobody, so as not the bot.
      const isEdited = [finding.lastEditedAt, finding.editor].some(
        (field) => field !== undefined && field !== null,
      );
      return [
        {
          id: thread.id,
          path: typeof thread.path === 'string' ? thread.path : undefined,
          line: line as number | undefined,
          body: typeof finding.body === 'string' ? finding.body : '',
          isEditedByOther: isEdited && !isReviewBot(finding.editor),
          isMinimized: finding.isMinimized !== false,
        },
      ];
    }),
  };
}

/**
 * The pull request at `url` as `query` reads it, asked with its owner, name
 * and number and pinned to `repo`'s host. Refused when the url is not one of
 * `repo`'s pull requests by shape.
 */
function queryPullRequest(
  repoPath: string,
  url: string,
  repo: string,
  query: string,
  timeoutMs?: number,
): Record<string, unknown> {
  const [host, owner, name] = repo.split('/');
  const number = /\/pull\/(\d+)$/.exec(url)?.[1];
  if (!host || !owner || !name || number === undefined) {
    throw new Error(`Cannot read a review of ${url} as a pull request of ${repo}.`);
  }
  const parsed = ghJson(repoPath, graphqlArgs(host, query, { owner, name }, { number }), timeoutMs);
  return objectFields(objectFields(objectFields(objectFields(parsed).data).repository).pullRequest);
}

/** `gh api graphql` on `host`: `fields` go raw (`-f`), so no value is read as a file; `typed` as `-F`. */
function graphqlArgs(
  host: string,
  query: string,
  fields: Record<string, string>,
  typed: Record<string, string> = {},
): string[] {
  return [
    'api',
    'graphql',
    '--hostname',
    host,
    '-f',
    `query=${query}`,
    ...Object.entries(fields).flatMap(([key, value]) => ['-f', `${key}=${value}`]),
    ...Object.entries(typed).flatMap(([key, value]) => ['-F', `${key}=${value}`]),
  ];
}

const FIX_ROUND_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(last: ${REVIEW_PAGE}) {
        nodes {
          id
          isResolved
          path
          finding: comments(first: 1) { nodes { author { __typename login } } }
          replies: comments(last: ${REVIEW_PAGE}) { nodes { body viewerDidAuthor } }
        }
      }
      comments(last: ${REVIEW_PAGE}) { nodes { body viewerDidAuthor } }
    }
  }
}`;

/** A review thread on the PR as a fix round's answers read it. */
export interface AnsweredThread {
  id: string;
  isResolved: boolean;
  /** Its first comment, the finding, is the review bot's. */
  isBots: boolean;
  /** The file the finding is on, as GitHub reports it. */
  path?: string;
  /** The bodies of its comments that gh's own login wrote, newest last. */
  ownReplies: string[];
}

/**
 * The PR's newest review threads and the comments on it that gh's login wrote
 * (`viewerDidAuthor`), for the replies a fix round posts (decision 90): what
 * is already answered, so a second run for the same head posts nothing again.
 */
export function readThreadAnswers(
  repoPath: string,
  url: string,
  repo: string,
  timeoutMs?: number,
): { threads: AnsweredThread[]; ownComments: string[] } {
  const pr = queryPullRequest(repoPath, url, repo, FIX_ROUND_THREADS_QUERY, timeoutMs);
  const ownBodies = (connection: unknown): string[] =>
    nodesOf(connection).flatMap((comment) =>
      comment.viewerDidAuthor === true && typeof comment.body === 'string' ? [comment.body] : [],
    );
  return {
    threads: nodesOf(pr.reviewThreads).flatMap((thread): AnsweredThread[] =>
      typeof thread.id === 'string'
        ? [
            {
              id: thread.id,
              isResolved: thread.isResolved === true,
              isBots: isReviewBot(nodesOf(thread.finding)[0]?.author),
              ...(typeof thread.path === 'string' ? { path: thread.path } : {}),
              ownReplies: ownBodies(thread.replies),
            },
          ]
        : [],
    ),
    ownComments: ownBodies(pr.comments),
  };
}

const THREAD_REPLY_MUTATION = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) {
    comment { id }
  }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } }
}`;

/** Reply `body` on review thread `threadId` of `repo` (its `host/owner/name`), as gh's login. */
export function replyToReviewThread(
  repoPath: string,
  repo: string,
  threadId: string,
  body: string,
  timeoutMs?: number,
): void {
  ghJson(
    repoPath,
    graphqlArgs(hostOf(repo), THREAD_REPLY_MUTATION, { thread: threadId, body }),
    timeoutMs,
  );
}

/** Resolve review thread `threadId` of `repo`, as gh's login. */
export function resolveReviewThread(
  repoPath: string,
  repo: string,
  threadId: string,
  timeoutMs?: number,
): void {
  ghJson(
    repoPath,
    graphqlArgs(hostOf(repo), RESOLVE_THREAD_MUTATION, { thread: threadId }),
    timeoutMs,
  );
}

/** Comment `body` on the PR at `url`, pinned to `repo`; the body over stdin, as a PR's is. */
export function commentOnPullRequest(
  repoPath: string,
  url: string,
  repo: string,
  body: string,
  timeoutMs = GH_COMMAND_TIMEOUT_MS,
): void {
  execFileSync('gh', ['pr', 'comment', url, '--repo', repo, '--body-file', '-'], {
    cwd: repoPath,
    encoding: 'utf8',
    input: body,
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: scrubbedGitEnv(),
  });
}

/**
 * A gh call that ran past its timeout. Node kills it with SIGTERM, which
 * `rethrowIfKilled` reads as an interrupt; this is the caller's own budget
 * running out, which the caller answers rather than rethrows.
 */
export function isGhTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code === 'ETIMEDOUT'
    : false;
}

function hostOf(repo: string): string {
  const [host] = repo.split('/');
  if (!host) throw new Error(`Cannot read a GitHub host from ${repo}.`);
  return host;
}

/**
 * The bot's newest review run, newest first: its newest review, with the
 * bodiless bot reviews on the same commit just before it. When its batch
 * review is refused, the poster posts each finding as a comment of its own,
 * which GitHub wraps in a one-comment review with no body, then the summary
 * as a review with no thread (`tools/review/src/post-review.script.ts`). A bot
 * review with a body, or on another commit, is the run before.
 */
function newestReviewRun(reviews: unknown): Record<string, unknown>[] {
  const bot = nodesOf(reviews).filter((review) => isReviewBot(review.author));
  const newest = bot.at(-1);
  if (newest === undefined) return [];
  const commit = objectFields(newest.commit).oid;
  const run = [newest];
  for (const review of bot.slice(0, -1).reverse()) {
    if (review.body !== '' || objectFields(review.commit).oid !== commit) break;
    run.push(review);
  }
  return run;
}

/**
 * The review bot's `claude-review` status on the PR's last commit, read only
 * when that commit is the head the PR reports: anyone who can push may set a
 * status, so another creator's reads as none. A clean one is still no proof
 * (decision 90).
 */
function reviewStatusOn(
  commits: unknown,
  head: string | undefined,
): PullRequestReview['headStatus'] {
  const commit = objectFields(nodesOf(commits).at(-1)?.commit);
  if (head === undefined || commit.oid !== head) return undefined;
  const status = objectFields(objectFields(commit.status).context);
  if (!isReviewBot(status.creator)) return undefined;
  const { state, description } = status;
  return typeof state === 'string'
    ? { state, description: typeof description === 'string' ? description : '' }
    : undefined;
}
