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
import type { Database } from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../claude/session-runtime.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude/session-runtime.service.js')>()),
  kickoff: vi.fn(() => true),
  killSession: vi.fn(),
  launchSession: vi.fn(() => ({ sessionId: 's1', paneId: '%9' })),
  steerPane: vi.fn(),
}));

// The code graph is a property of the test, not of the machine (decision 51).
vi.mock('./codegraph.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codegraph.client.js')>()),
  codegraphBinary: vi.fn(() => undefined),
  prepareGraph: vi.fn((binary: string | undefined) => binary !== undefined),
}));

// Without this, the gate after the fix round would spawn a real `claude -p` call.
vi.mock('../claude/utility.service.js', () => ({
  runUtility: vi.fn(() => ({ ok: false, output: 'mocked out in tests' })),
}));

import {
  BOT,
  BRANCH,
  commitIn,
  failingAdapter,
  GIT_ENV,
  ORIGIN_URL,
  OTHER_SHA,
  PR_URL,
  passingAdapter,
  SESSION_ID,
  sh,
  type ThreadSeed,
} from '@test/helpers/fix-round.mock.js';
import { tempDir } from '@test/helpers/temp-dir.mock.js';
import type { Adapter } from '../adapters/types/adapter.types.js';
import { kickoff } from '../claude/session-runtime.service.js';
import { openStore } from './db.client.js';
import { DEFAULT_BASE_PROFILE } from './default-profile.constants.js';
import { answerFixRoundThreads, ciReviewLookup, startFixRound } from './fix-round.service.js';
import { landSession } from './land.service.js';
import { runMergeGate } from './merge-gate.service.js';
import { projectId, projectPaths } from './paths.utils.js';
import { endSandboxRun, TOOLCHAIN_CACHE_DIRNAME } from './sandbox.utils.js';
import {
  appendEvent,
  ensureProject,
  getSession,
  insertSession,
  insertTask,
  listEvents,
  saveProjectOriginUrl,
  transitionSession,
} from './session.repository.js';
import { markSessionDone } from './session-lifecycle.service.js';

// The file's temp dirs, its children's included, go to a TMPDIR of its own,
// which must hold no pup-* entry once every test has removed its own
// (decision 100). The gate's toolchain cache stays, by design, but empty.
let sharedTmp: string | undefined;
let fileTmp: string;
beforeAll(() => {
  sharedTmp = process.env.TMPDIR;
  fileTmp = realpathSync(mkdtempSync(join(tmpdir(), 'pup-fix-round-tmp-')));
  process.env.TMPDIR = fileTmp;
});
afterAll(async () => {
  const leftover = () =>
    readdirSync(fileTmp).flatMap((name) => {
      if (name === TOOLCHAIN_CACHE_DIRNAME) {
        return readdirSync(join(fileTmp, name)).map((cache) => join(name, cache));
      }
      return name.startsWith('pup-') ? [name] : [];
    });
  // A shard whose last child ran outside a gate has no gate left to end the sandbox run.
  endSandboxRun();
  const left = leftover();
  if (sharedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = sharedTmp;
  rmSync(fileTmp, { recursive: true, force: true, maxRetries: 3 });
  expect(left).toEqual([]);
});

// Real git repos, a bare origin and a gh on PATH that answers from files.
describe('startFixRound', { timeout: 90_000 }, () => {
  let db: Database;
  let repo: string;
  let origin: string;
  let worktree: string;
  let stateBase: string;
  /** The commit the first gate pinned and pushed. */
  let pinned: string;
  let ghDir: string;
  let claudeUserDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openStore(':memory:');
    repo = tempDir('pup-fix-repo-');
    sh(repo, 'git', 'init', '-q', '-b', 'main');
    commitIn(repo, 'src/app.ts', 'export const app = 1;\n');
    // GitHub-shaped origin, rewritten by the operator's global config into a
    // local bare repo so every push and fetch stays offline.
    const host = tempDir('pup-fix-origin-');
    origin = join(host, 'owner', 'repo.git');
    mkdirSync(origin, { recursive: true });
    sh(origin, 'git', 'init', '-q', '--bare', '-b', 'main');
    sh(repo, 'git', 'remote', 'add', 'origin', ORIGIN_URL);
    sh(repo, 'git', 'push', '-q', origin, 'main');
    const globalConfig = join(host, 'gitconfig');
    writeFileSync(globalConfig, `[url "${host}/"]\n\tinsteadOf = git@github.com:\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);

    const pid = projectId(repo);
    ensureProject(db, pid, repo);
    saveProjectOriginUrl(db, pid, ORIGIN_URL);
    insertTask(db, {
      id: 'task-s1',
      projectId: pid,
      spec: JSON.stringify({ id: 'task-s1', goal: 'g', scopeIn: ['src/**'], acceptance: ['a'] }),
    });
    worktree = join(repo, '.worktrees', SESSION_ID);
    sh(repo, 'git', 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'HEAD');
    pinned = commitIn(worktree, 'src/feature.ts', 'export const feature = 1;\n');
    insertSession(db, {
      id: SESSION_ID,
      taskId: 'task-s1',
      worktreePath: worktree,
      branch: BRANCH,
      profileHash: 'hash',
      tmuxTarget: '%4',
    });
    transitionSession(db, SESSION_ID, 'running');
    transitionSession(db, SESSION_ID, 'awaiting-review');

    // projectPaths defaults to ~/.pupitre; tests must never write there.
    stateBase = tempDir('pup-fix-state-');
    const compiled = projectPaths(repo, stateBase).compiledDir(SESSION_ID);
    mkdirSync(compiled, { recursive: true });
    writeFileSync(join(compiled, 'context.md'), '# task context\n');
    writeFileSync(join(compiled, 'settings.json'), '{}');

    claudeUserDir = tempDir('pup-fix-claude-');
    ghDir = tempDir('pup-fix-gh-');
    writeFileSync(
      join(ghDir, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${ghDir}/calls`,
        '[ "$1" = "--version" ] && exit 0',
        'if [ "$1" = "api" ]; then',
        '  case "$*" in',
        // One line per mutation, so a test counts the replies and resolves.
        `    *mutation*) printf '%s' "$*" | tr '\\n' ' ' >> ${ghDir}/mutations; printf '\\n' >> ${ghDir}/mutations; echo '{"data":{}}'; exit 0;;`,
        `    *replies:*) [ -f ${ghDir}/answers-fail ] && exit 1; [ -f ${ghDir}/answers-slow ] && exec sleep 5; cat ${ghDir}/answers.json 2>/dev/null || echo '{}'; exit 0;;`,
        '  esac',
        `  cat ${ghDir}/review.json; exit 0`,
        'fi',
        `if [ "$2" = "list" ]; then echo '${JSON.stringify([{ url: PR_URL, baseRefName: 'main', isCrossRepository: false }])}'; exit 0; fi`,
        'if [ "$2" = "view" ]; then',
        `  if [ -f ${ghDir}/view.json ]; then cat ${ghDir}/view.json; exit 0; fi`,
        `  head=$(git --git-dir=${origin} rev-parse refs/heads/${BRANCH})`,
        `  printf '{"headRefOid":"%s","state":"OPEN","baseRefName":"main"}\\n' "$head"; exit 0`,
        'fi',
        `[ "$2" = "comment" ] && { cat >> ${ghDir}/comments; printf '\\n--\\n' >> ${ghDir}/comments; exit 0; }`,
        'cat >/dev/null',
        'echo "$@"',
      ].join('\n'),
      { mode: 0o755 },
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${ghDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.unstubAllEnvs();
  });

  const ghFile = (name: string): string[] =>
    existsSync(join(ghDir, name))
      ? readFileSync(join(ghDir, name), 'utf8').split('\n').filter(Boolean)
      : [];
  const ghCalls = (): string[] =>
    existsSync(join(ghDir, 'calls'))
      ? readFileSync(join(ghDir, 'calls'), 'utf8').split('\n').filter(Boolean)
      : [];

  /** What GitHub's GraphQL answers for the PR: the review state `pup fix` reads. */
  function reviewOnGitHub({
    state = 'OPEN',
    head = pinned,
    reviewedOn = head as string | null,
    status = { state: 'SUCCESS', description: '1 important finding(s)' } as {
      state: string;
      description: string;
    } | null,
    threads = [] as ThreadSeed[],
    /** Threads older than the page read. */
    unread = 0,
  } = {}): void {
    const answer = {
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
                    status: status && { context: { ...status, creator: BOT } },
                  },
                },
              ],
            },
            reviews: {
              nodes: [
                { author: { __typename: 'User', login: 'alexis' }, commit: { oid: head } },
                ...(reviewedOn === null
                  ? []
                  : [
                      { id: 'PRR_earlier', author: BOT, commit: { oid: OTHER_SHA } },
                      { id: 'PRR_newest', author: BOT, commit: { oid: reviewedOn } },
                    ]),
              ],
            },
            reviewThreads: {
              pageInfo: { hasPreviousPage: unread > 0 },
              nodes: threads.map((thread) => ({
                id: thread.id,
                isResolved: thread.isResolved ?? false,
                path: thread.path === undefined ? 'src/feature.ts' : thread.path,
                line: thread.line === undefined ? 1 : thread.line,
                originalLine: thread.originalLine ?? 1,
                comments: {
                  nodes: [
                    {
                      author: thread.author ?? BOT,
                      body: thread.body,
                      lastEditedAt: thread.editor === undefined ? null : '2026-10-18T09:00:00Z',
                      editor: thread.editor ?? null,
                      isMinimized: thread.isMinimized ?? false,
                    },
                  ],
                },
              })),
            },
          },
        },
      },
    };
    writeFileSync(join(ghDir, 'review.json'), JSON.stringify(answer));
  }

  /**
   * What the gate's `--pr` merge leaves, seeded: merged, the PR and the pin on
   * the event, and the worktree gone with the teardown (the branch kept).
   */
  function _seedPrMerge(event: Record<string, unknown> = {}): void {
    sh(repo, 'git', 'worktree', 'remove', '--force', worktree);
    transitionSession(db, SESSION_ID, 'merged');
    appendEvent(db, SESSION_ID, 'merge', {
      branch: BRANCH,
      sha: pinned,
      target: 'main',
      files: ['src/feature.ts'],
      prUrl: PR_URL,
      ...event,
    });
  }

  /** The real `--pr` gate, adopting PR #7: the worktree and the local branch go with it. */
  async function gateWithPr(): Promise<void> {
    const outcome = await runMergeGate(db, {
      repoPath: repo,
      sessionId: SESSION_ID,
      adapters: [passingAdapter],
      openPr: true,
    });
    expect(outcome).toMatchObject({ status: 'merged', prUrl: PR_URL, prWasAdopted: true });
  }

  /** GitHub merging PR #7 at `head` onto origin's main, as `pup land` then reads it. */
  function _mergeOnGitHub(head: string): string {
    const base = sh(origin, 'git', 'rev-parse', 'main');
    const mergeCommit = sh(
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
    sh(origin, 'git', 'update-ref', 'refs/heads/main', mergeCommit);
    writeFileSync(
      join(ghDir, 'view.json'),
      JSON.stringify({
        state: 'MERGED',
        baseRefName: 'main',
        headRefOid: head,
        mergeCommit: { oid: mergeCommit },
      }),
    );
    return mergeCommit;
  }

  const _land = () =>
    landSession(db, { repoPath: repo, sessionId: SESSION_ID, adapters: [passingAdapter] });

  const fix = (override = {}, overrideVia: 'operator' | 'conductor' = 'operator') =>
    startFixRound(db, {
      repoPath: repo,
      sessionId: SESSION_ID,
      override,
      overrideVia,
      pathsBase: stateBase,
      base: DEFAULT_BASE_PROFILE,
      windowEnv: { vars: {}, configDir: claudeUserDir },
    });
  const _payloads = (type: string) =>
    listEvents(db, SESSION_ID)
      .filter((row) => row.type === type)
      .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
  const _prompt = (): string => vi.mocked(kickoff).mock.calls.at(-1)?.[1] ?? '';
  /** A window recorded on `rung` of the standard ladder, as a launch records it. */
  const _routeAt = (rung: number) => ({
    tier: 'standard' as const,
    rung,
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    override: false,
  });
  /**
   * A round before this one that opened its window and was gated again: on an
   * older head, so the review's threads now carry ids it never saw.
   */
  const _seedFinishedRound = () => {
    appendEvent(db, SESSION_ID, 'fix_round', {
      prUrl: PR_URL,
      head: '1'.repeat(40),
      threads: ['PRRT_round1'],
      rejectBase: 0,
    });
    appendEvent(db, SESSION_ID, 'respawn', { delivered: true });
    appendEvent(db, SESSION_ID, 'merge', {
      branch: BRANCH,
      sha: pinned,
      target: 'main',
      files: ['src/feature.ts'],
      prUrl: PR_URL,
    });
  };

  describe("the round's answers on GitHub", () => {
    const ROUND_THREADS: ThreadSeed[] = [
      { id: 'PRRT_fixed', body: 'The loop never ends.' },
      { id: 'PRRT_declined', body: 'Missing await.' },
      { id: 'PRRT_silent', body: 'Unchecked index.' },
      { id: 'PRRT_human', body: 'Not the bot.' },
    ];
    /** The file each finding is on: only `PRRT_fixed`'s is one the round's commit changes. */
    const PATHS: Record<string, string> = {
      PRRT_fixed: 'src/fix.ts',
      PRRT_declined: 'src/await.ts',
      PRRT_silent: 'src/index.ts',
      PRRT_human: 'src/human.ts',
    };

    /**
     * What the threads read answers: every round thread unresolved and the
     * bot's, but `PRRT_human`, on its file in `paths`, with the replies and PR
     * comments gh's login wrote.
     */
    function answersOnGitHub({
      replies = {} as Record<string, string[]>,
      resolved = [] as string[],
      comments = [] as string[],
      paths = PATHS,
    } = {}): void {
      const own = (bodies: string[]) => ({
        nodes: [
          { body: 'someone else', viewerDidAuthor: false },
          ...bodies.map((body) => ({ body, viewerDidAuthor: true })),
        ],
      });
      const answer = {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: ROUND_THREADS.map(({ id }) => ({
                  id,
                  isResolved: resolved.includes(id),
                  path: paths[id],
                  finding: {
                    nodes: [
                      { author: id === 'PRRT_human' ? { __typename: 'User', login: 'a' } : BOT },
                    ],
                  },
                  replies: own(replies[id] ?? []),
                })),
              },
              comments: own(comments),
            },
          },
        },
      };
      writeFileSync(join(ghDir, 'answers.json'), JSON.stringify(answer));
    }

    const replies = () => ghFile('mutations').filter((m) => m.includes('ReviewThreadReply'));
    const resolves = () => ghFile('mutations').filter((m) => m.includes('resolveReviewThread'));
    const comments = () =>
      existsSync(join(ghDir, 'comments'))
        ? readFileSync(join(ghDir, 'comments'), 'utf8').split('\n--\n').filter(Boolean)
        : [];

    /** The target as a direct call names it: main, which has not moved. */
    const mainSha = () => sh(repo, 'git', 'rev-parse', 'main');

    /**
     * A round on the four threads, its worker done with `summary`, gated
     * again; `meanwhile` runs while the worker works. Each of `rejected` is a
     * summary the worker gave first, on a run the round's checks rejected,
     * after which `afterRejected` runs. `adapter` runs the passing gate's checks.
     */
    async function gateTheRound(
      summary: string,
      {
        meanwhile,
        rejected = [],
        afterRejected,
        paths,
        adapter = passingAdapter,
      }: {
        meanwhile?: () => void;
        rejected?: string[];
        afterRejected?: () => void;
        paths?: Record<string, string>;
        adapter?: Adapter;
      } = {},
    ): Promise<string> {
      await gateWithPr();
      reviewOnGitHub({ threads: ROUND_THREADS.filter(({ id }) => id !== 'PRRT_human') });
      await fix();
      meanwhile?.();
      // The round named `PRRT_human` too, as a store edit could have.
      db.prepare(
        "UPDATE events SET payload = json_set(payload, '$.threads[3]', 'PRRT_human') WHERE type = 'fix_round'",
      ).run();
      const fixed = commitIn(worktree, 'src/fix.ts', 'export const fix = 1;\n');
      answersOnGitHub({ paths });
      const gate = (adapter: Adapter) =>
        runMergeGate(db, {
          repoPath: repo,
          sessionId: SESSION_ID,
          adapters: [adapter],
          openPr: true,
        });
      for (const said of rejected) {
        markSessionDone(db, SESSION_ID, said);
        expect(await gate(failingAdapter)).toMatchObject({ status: 'rejected' });
        afterRejected?.();
      }
      markSessionDone(db, SESSION_ID, summary);
      expect(await gate(adapter)).toMatchObject({ status: 'merged', prUrl: PR_URL });
      return fixed;
    }

    const SUMMARY =
      'PRRT_fixed fixed: bounded the loop by `n`; PRRT_declined declined: @someone the ' +
      'call is sync';

    it('replies on each thread the round named, resolving the fixed ones only', async () => {
      const fixed = await gateTheRound(SUMMARY);
      const marker = `<!-- pup fix-round ${fixed} -->`;

      expect(replies()).toHaveLength(3);
      const [first, second, third] = replies();
      // The worker's words go in a code span: no markdown, no link, no mention.
      expect(first).toContain(
        `-f thread=PRRT_fixed -f body=Addressed in ${fixed}: \`\` bounded the loop by \`n\` \`\`  ${marker}`,
      );
      expect(second).toContain(
        `-f thread=PRRT_declined -f body=Declined in the fix round gated at ${fixed}: ` +
          `\` @someone the call is sync \`. Left open for the operator.  ${marker}`,
      );
      expect(third).toContain(
        `-f thread=PRRT_silent -f body=The fix round gated at ${fixed} gave no answer for this ` +
          'thread; left open for the operator.',
      );
      // A thread whose finding is not the bot's is never answered.
      expect(ghFile('mutations').join('\n')).not.toContain('PRRT_human');
      expect(resolves()).toHaveLength(1);
      expect(resolves()[0]).toMatch(/-f thread=PRRT_fixed\s*$/);
      // Pinned to origin's host, as every gh call is.
      expect(replies().every((m) => m.startsWith('api graphql --hostname github.com '))).toBe(true);
      expect(comments()).toEqual([
        `CI fix round gated at ${fixed}: 1 thread(s) addressed and resolved, 0 answered fixed ` +
          'that pup could not verify, 1 declined and 1 unanswered, left open for the ' +
          `operator.\n\n@claude review\n\n${marker}`,
      ]);
      expect(ghCalls()).toContain(
        `pr comment ${PR_URL} --repo github.com/owner/repo --body-file -`,
      );
    });

    it('posts nothing again when it runs a second time for the same head', async () => {
      const fixed = await gateTheRound(SUMMARY);
      const marker = `<!-- pup fix-round ${fixed} -->`;
      // GitHub as the first run left it, but for the reply to PRRT_silent,
      // which that run never got to.
      answersOnGitHub({
        replies: { PRRT_fixed: [`Addressed in ${fixed}\n\n${marker}`], PRRT_declined: [marker] },
        resolved: ['PRRT_fixed'],
        comments: [marker],
      });

      const answers = answerFixRoundThreads(
        db,
        repo,
        SESSION_ID,
        'github.com/owner/repo',
        mainSha(),
      );

      expect(answers).toEqual({
        prUrl: PR_URL,
        sha: fixed,
        addressed: 1,
        unverified: 0,
        declined: 1,
        unanswered: 1,
      });
      expect(replies()).toHaveLength(4);
      expect(replies()[3]).toContain('-f thread=PRRT_silent');
      expect(resolves()).toHaveLength(1);
      expect(comments()).toHaveLength(1);

      answersOnGitHub({
        replies: {
          PRRT_fixed: [marker],
          PRRT_declined: [marker],
          PRRT_silent: [marker],
        },
        resolved: ['PRRT_fixed'],
        comments: [marker],
      });
      answerFixRoundThreads(db, repo, SESSION_ID, 'github.com/owner/repo', mainSha());

      expect(replies()).toHaveLength(4);
      expect(resolves()).toHaveLength(1);
      expect(comments()).toHaveLength(1);

      // A target that is no sha, or one git does not hold, proves no fix.
      for (const target of ['not a sha', 'c'.repeat(40)]) {
        expect(
          answerFixRoundThreads(db, repo, SESSION_ID, 'github.com/owner/repo', target),
        ).toMatchObject({ addressed: 0, unverified: 1 });
      }
      expect(resolves()).toHaveLength(1);
    });

    it('answers again a thread the operator replied on after its marker, at the same head', async () => {
      const fixed = await gateTheRound(SUMMARY);
      const marker = `<!-- pup fix-round ${fixed} -->`;
      answersOnGitHub({
        replies: {
          PRRT_fixed: [marker],
          PRRT_declined: [marker, 'still wrong, look again'],
          PRRT_silent: [marker],
        },
        resolved: ['PRRT_fixed'],
        comments: [marker],
      });
      const before = replies().length;

      answerFixRoundThreads(db, repo, SESSION_ID, 'github.com/owner/repo', mainSha());

      expect(replies()).toHaveLength(before + 1);
      expect(replies().at(-1)).toContain('-f thread=PRRT_declined');
    });

    // The worker's word alone resolves nothing under the operator's login: the
    // round's commits must change the file the finding is on.
    it('leaves open a thread answered fixed whose file the round never changed', async () => {
      const fixed = await gateTheRound(`${SUMMARY}; PRRT_silent fixed: checked the bound`);

      const silent = replies().find((m) => m.includes('-f thread=PRRT_silent'));
      expect(silent).toContain(
        `-f body=Answered fixed in the round gated at ${fixed}, but pup cannot show the ` +
          'round changed the content of ` src/index.ts `: ` checked the bound `. Left open ' +
          'for the operator.',
      );
      expect(resolves()).toHaveLength(1);
      expect(resolves()[0]).toMatch(/-f thread=PRRT_fixed\s*$/);
      expect(comments()[0]).toContain(
        '1 thread(s) addressed and resolved, 1 answered fixed that pup could not verify, ' +
          '1 declined and 0 unanswered, left open for the operator.',
      );
    });

    // The gate's fresh-base takes main in before the pin, so a diff from the
    // round's start to the pin would count main's files as the round's, and
    // the round's commits would count main's change the worker cherry-picked.
    it('leaves open a thread on a file only the target changed, though the worker took the change in', async () => {
      const fixed = await gateTheRound(`${SUMMARY}; PRRT_silent fixed: checked the bound`, {
        meanwhile: () => {
          mkdirSync(join(repo, 'src'), { recursive: true });
          writeFileSync(join(repo, 'src', 'index.ts'), 'export const index = 2;\n');
          sh(repo, 'git', 'add', 'src/index.ts');
          sh(
            repo,
            'git',
            '-c',
            'user.email=m@test',
            '-c',
            'user.name=main',
            'commit',
            '-q',
            '-m',
            'main moves',
          );
          sh(
            worktree,
            'git',
            '-c',
            'user.email=f@test',
            '-c',
            'user.name=fix',
            'cherry-pick',
            'main',
          );
        },
      });
      const pinned = sh(origin, 'git', 'rev-parse', BRANCH);

      // The gate merged the moved main into the round's branch.
      expect(pinned).not.toBe(fixed);
      expect(replies().find((m) => m.includes('-f thread=PRRT_silent'))).toContain(
        `Answered fixed in the round gated at ${pinned}, but pup cannot show the round changed ` +
          'the content of ` src/index.ts `',
      );
      expect(resolves()).toHaveLength(1);
      expect(resolves()[0]).toMatch(/-f thread=PRRT_fixed\s*$/);
    });

    // A rebase or an amend carries the PR's commits from before the round under
    // new shas, in neither the round's start nor main: their files are no
    // proof of a fix, while the round's own change still is.
    it('counts only what the round changed on a branch rewritten since it started', async () => {
      // On the file of the PR's commit from before the round.
      const paths = { ...PATHS, PRRT_silent: 'src/feature.ts' };
      const fixed = await gateTheRound(`${SUMMARY}; PRRT_silent fixed: checked the bound`, {
        paths,
      });
      const commitTree = (tree: string, parent: string, message: string) =>
        sh(
          repo,
          'git',
          '-c',
          'user.email=f@test',
          '-c',
          'user.name=fix',
          'commit-tree',
          tree,
          '-p',
          parent,
          '-m',
          message,
        );
      const amended = commitTree(`${pinned}^{tree}`, 'main', 'feature, amended');
      const rewritten = commitTree(`${fixed}^{tree}`, amended, 'src/fix.ts');
      db.prepare(
        "UPDATE events SET payload = json_set(payload, '$.sha', ?) WHERE id = (SELECT max(id) FROM events WHERE type = 'merge')",
      ).run(rewritten);
      answersOnGitHub({ paths });
      const resolved = resolves().length;

      const answers = answerFixRoundThreads(
        db,
        repo,
        SESSION_ID,
        'github.com/owner/repo',
        mainSha(),
      );

      expect(answers).toMatchObject({ addressed: 1, unverified: 1, declined: 1, unanswered: 0 });
      expect(resolves().slice(resolved)).toEqual([
        expect.stringMatching(/-f thread=PRRT_fixed\s*$/),
      ]);
      expect(
        replies()
          .filter((m) => m.includes('-f thread=PRRT_silent'))
          .at(-1),
      ).toContain(
        `Answered fixed in the round gated at ${rewritten}, but pup cannot show the round changed ` +
          'the content of ` src/feature.ts `',
      );
    });

    // The summary after a rejected run need not name a thread again, so an
    // earlier `fixed` stands: only what the round changed in the end, not a
    // commit in its history, makes it a fix.
    it('leaves open a thread whose fix a later run of the round reverted', async () => {
      await gateTheRound('fixed the failing check by dropping the bound', {
        rejected: [SUMMARY],
        afterRejected: () =>
          sh(
            worktree,
            'git',
            '-c',
            'user.email=f@test',
            '-c',
            'user.name=fix',
            'revert',
            '--no-edit',
            'HEAD',
          ),
      });
      const pinned = sh(origin, 'git', 'rev-parse', BRANCH);

      expect(resolves()).toEqual([]);
      expect(replies().find((m) => m.includes('-f thread=PRRT_fixed'))).toContain(
        `Answered fixed in the round gated at ${pinned}, but pup cannot show the round changed ` +
          'the content of ` src/fix.ts `',
      );
    });

    // Each summary is read on its own, and an answer within one never runs
    // across a line: an id at the end of one line is not the verdict below it.
    it('reads no answer across a line break, within a summary or between two', async () => {
      await gateTheRound(
        'touched PRRT_fixed\nfixed: bounded the loop; PRRT_declined declined: the call is ' +
          'sync; left PRRT_silent',
        { rejected: ['fixed: the check waits for its child'] },
      );

      expect(resolves()).toEqual([]);
      expect(comments()[0]).toContain(
        '0 thread(s) addressed and resolved, 0 answered fixed that pup could not verify, ' +
          '1 declined and 2 unanswered',
      );
    });

    // A run the round's checks rejected asks only for the failures fixed, so
    // the summary after it may answer no thread: each keeps its newest answer.
    it('reads the answers from every summary of the round, the newest first', async () => {
      const fixed = await gateTheRound(
        'fixed the failing check; PRRT_silent declined: the bound is checked upstream',
        { rejected: [`${SUMMARY}; PRRT_silent fixed: checked the bound`] },
      );

      expect(resolves()).toHaveLength(1);
      expect(resolves()[0]).toMatch(/-f thread=PRRT_fixed\s*$/);
      expect(replies().find((m) => m.includes('-f thread=PRRT_fixed'))).toContain(
        `Addressed in ${fixed}: \`\` bounded the loop by \`n\` \`\``,
      );
      expect(replies().find((m) => m.includes('-f thread=PRRT_silent'))).toContain(
        `Declined in the fix round gated at ${fixed}: \` the bound is checked upstream \``,
      );
      expect(comments()[0]).toContain(
        '1 thread(s) addressed and resolved, 0 answered fixed that pup could not verify, ' +
          '2 declined and 0 unanswered',
      );
    });

    // The newest summary naming a thread answers for it, by its last mention
    // there: a mention the format does not parse is no answer, and never lets
    // an older `fixed` stand.
    it('takes the newest summary naming a thread, by its last mention there', async () => {
      await gateTheRound(
        'fixed the failing check; `PRRT_fixed` declined: the bound broke it; PRRT_declined ' +
          'fixed: made it async; PRRT_declined declined: the call is sync after all',
        { rejected: [`${SUMMARY}; PRRT_silent fixed: checked the bound`] },
      );

      expect(resolves()).toEqual([]);
      expect(replies().find((m) => m.includes('-f thread=PRRT_declined'))).toContain(
        '` the call is sync after all `',
      );
      expect(comments()[0]).toContain(
        '0 thread(s) addressed and resolved, 1 answered fixed that pup could not verify, ' +
          '1 declined and 1 unanswered',
      );
    });

    // A reviewer flags one cause in several places, so a reason cites other
    // threads, or its own: an id inside a reason answers nothing, even with a
    // verdict word after it, and cancels no answer of its summary. Mid-clause,
    // only the colon form answers, so an answer after prose still reads.
    it('reads an id cited inside a reason as no answer, and as no cancel within its summary', async () => {
      const fixed = await gateTheRound(
        'Answered all three. PRRT_fixed fixed: bounded the loop, the bound PRRT_fixed asked ' +
          'for; PRRT_declined declined: not a bug, as PRRT_fixed fixed it upstream; ' +
          'PRRT_silent declined: same reasoning as PRRT_declined addressed upstream',
      );

      expect(resolves()).toHaveLength(1);
      expect(resolves()[0]).toMatch(/-f thread=PRRT_fixed\s*$/);
      expect(replies().find((m) => m.includes('-f thread=PRRT_fixed'))).toContain(
        `Addressed in ${fixed}: \` bounded the loop, the bound PRRT_fixed asked for \``,
      );
      expect(replies().find((m) => m.includes('-f thread=PRRT_declined'))).toContain(
        '` not a bug, as PRRT_fixed fixed it upstream `',
      );
      expect(comments()[0]).toContain(
        '1 thread(s) addressed and resolved, 0 answered fixed that pup could not verify, ' +
          '2 declined and 0 unanswered',
      );
    });

    // A later summary that names a thread only inside a reason is still a
    // later word on it: the older `fixed` does not stand past it.
    it('lets no older answer stand past a later summary citing its thread', async () => {
      await gateTheRound('reverted the bound added for PRRT_fixed, it broke the build', {
        rejected: [SUMMARY],
      });

      expect(resolves()).toEqual([]);
      expect(comments()[0]).toContain(
        '0 thread(s) addressed and resolved, 0 answered fixed that pup could not verify, ' +
          '1 declined and 2 unanswered',
      );
    });

    // The gate reads the summaries under the merge lock, and they are session
    // text: a megabyte of mentions costs one pass, not one per mention.
    it('reads a summary of many mentions in one pass', async () => {
      await gateTheRound(
        `PRRT_declined declined: the call is sync; ${'a PRRT_fixed PRRT_silent '.repeat(40_000)}`,
      );
      const started = Date.now();

      const answers = answerFixRoundThreads(
        db,
        repo,
        SESSION_ID,
        'github.com/owner/repo',
        mainSha(),
      );

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(answers).toMatchObject({ addressed: 0, unverified: 0, declined: 1, unanswered: 2 });
    });

    // An armed driver is the operator's alarm (decision 50), never read as no
    // change: one armed while the stages ran stops the answers before any
    // post, and the gate's warning carries the alarm whole, past the cap.
    it('answers nothing past a driver armed while the gate ran, and says so whole', async () => {
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
      await gateTheRound(SUMMARY, {
        adapter: {
          ...passingAdapter,
          gateCommands: (repoPath) => {
            writeFileSync(join(repoPath, '.git', 'info', 'attributes'), '* merge=pwn\n');
            return passingAdapter.gateCommands(repoPath);
          },
        },
      });

      expect(ghFile('mutations')).toEqual([]);
      expect(comments()).toEqual([]);
      const said = warn.mock.calls.flat().join(' ');
      expect(said).toContain("Answered none of the fix round's threads. Refusing to run git in");
      expect(said).toContain('treat a session that wrote them as compromised.');
      warn.mockRestore();
    });

    // The gate answers under the merge lock: a GitHub that hangs costs the
    // answers' budget, and its timeout is no interrupt to rethrow.
    it('gives up within its time budget on a GitHub that does not answer', async () => {
      await gateTheRound(SUMMARY);
      const posted = ghFile('mutations').length;
      writeFileSync(join(ghDir, 'answers-slow'), '');

      const started = Date.now();
      let error: unknown;
      try {
        answerFixRoundThreads(db, repo, SESSION_ID, 'github.com/owner/repo', mainSha(), 1000);
      } catch (thrown) {
        error = thrown;
      }

      expect(Date.now() - started).toBeLessThan(4000);
      expect(() =>
        answerFixRoundThreads(db, repo, SESSION_ID, 'github.com/owner/repo', mainSha(), 0),
      ).toThrow("GitHub took longer than the 0 s the round's answers may hold the merge lock");
      expect((error as Error).message).toBe(
        "GitHub took longer than the 1 s the round's answers may hold the merge lock",
      );
      expect(error).not.toHaveProperty('signal');
      expect(ghFile('mutations')).toHaveLength(posted);
    });

    it('answers nothing for a merge that ended no round, and a failing gh costs only the replies', async () => {
      await gateWithPr();
      expect(
        answerFixRoundThreads(db, repo, SESSION_ID, 'github.com/owner/repo', 'a'.repeat(40)),
      ).toBeUndefined();

      reviewOnGitHub({ threads: ROUND_THREADS.slice(0, 1) });
      await fix();
      commitIn(worktree, 'src/fix.ts', 'export const fix = 1;\n');
      markSessionDone(db, SESSION_ID, 'PRRT_fixed fixed: done');
      writeFileSync(join(ghDir, 'answers-fail'), '');
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

      const outcome = await runMergeGate(db, {
        repoPath: repo,
        sessionId: SESSION_ID,
        adapters: [passingAdapter],
        openPr: true,
      });

      expect(outcome).toMatchObject({ status: 'merged', prUrl: PR_URL });
      expect(getSession(db, SESSION_ID)?.state).toBe('merged');
      expect(warn.mock.calls.flat().join(' ')).toContain(
        "Could not answer the fix round's threads on GitHub",
      );
      expect(ghFile('mutations')).toEqual([]);
      warn.mockRestore();

      // A merge whose pin is no sha ends no round it could answer for.
      db.prepare(
        "UPDATE events SET payload = json_set(payload, '$.sha', 'bad') WHERE type = 'merge'",
      ).run();
      expect(
        answerFixRoundThreads(db, repo, SESSION_ID, 'github.com/owner/repo', 'a'.repeat(40)),
      ).toBeUndefined();
    });
  });
});

describe('ciReviewLookup', { timeout: 20_000 }, () => {
  let db: Database;
  let repo: string;
  let ghDir: string;
  let originalPath: string | undefined;
  const HEAD = 'b'.repeat(40);

  beforeEach(() => {
    db = openStore(':memory:');
    repo = tempDir('pup-fix-lookup-');
    const pid = projectId(repo);
    ensureProject(db, pid, repo);
    saveProjectOriginUrl(db, pid, ORIGIN_URL);
    insertTask(db, { id: 'task-s1', projectId: pid, spec: '{}' });
    insertSession(db, {
      id: SESSION_ID,
      taskId: 'task-s1',
      worktreePath: join(repo, '.worktrees', SESSION_ID),
      branch: BRANCH,
      profileHash: 'hash',
    });
    transitionSession(db, SESSION_ID, 'running');
    transitionSession(db, SESSION_ID, 'awaiting-review');
    transitionSession(db, SESSION_ID, 'merged');
    appendEvent(db, SESSION_ID, 'merge', {
      branch: BRANCH,
      sha: HEAD,
      target: 'main',
      files: [],
      prUrl: PR_URL,
    });
    // `pushTarget` reads origin from the repo, as the gate does.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: GIT_ENV });
    execFileSync('git', ['remote', 'add', 'origin', ORIGIN_URL], { cwd: repo, env: GIT_ENV });
    ghDir = tempDir('pup-fix-lookup-gh-');
    originalPath = process.env.PATH;
    process.env.PATH = `${ghDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function ghAnswers(script: string): void {
    writeFileSync(join(ghDir, 'gh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  function reviewWith(
    threads: number,
    description = 'no blocking issues',
    state = 'SUCCESS',
  ): void {
    const answer = {
      data: {
        repository: {
          pullRequest: {
            state: 'OPEN',
            headRefOid: HEAD,
            commits: {
              nodes: [
                {
                  commit: {
                    oid: HEAD,
                    status: { context: { state, description, creator: BOT } },
                  },
                },
              ],
            },
            reviews: { nodes: [{ id: 'PRR_1', author: BOT, commit: { oid: HEAD } }] },
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
    ghAnswers(`echo '${JSON.stringify(answer)}'`);
  }

  const lookup = () => ciReviewLookup(db, repo)({ id: SESSION_ID });

  it('counts the open threads the review opened on the head', () => {
    reviewWith(2, '2 important finding(s)');

    expect(lookup()).toEqual({ openThreads: 2 });
  });

  it('answers zero for a head the review found clean', () => {
    reviewWith(0);

    expect(lookup()).toEqual({ openThreads: 0 });
  });

  it('has no answer for a review that is no clean verdict, a failing gh, or a session not merged', () => {
    reviewWith(0, 'partial review: no blocking issues');
    expect(lookup()).toBeUndefined();

    reviewWith(2, 'reviewing', 'PENDING');
    expect(lookup()).toBeUndefined();

    ghAnswers('exit 1');
    expect(lookup()).toBeUndefined();

    reviewWith(1);
    db.prepare("UPDATE sessions SET state = 'running' WHERE id = ?").run(SESSION_ID);
    expect(lookup()).toBeUndefined();
  });
});
