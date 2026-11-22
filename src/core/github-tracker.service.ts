import { execFileSync } from 'node:child_process';
import { TrackerUnavailableError } from './errors/tracker.errors.js';
import { pinnedGitEnv } from './git-diff.client.js';
import type { GhRunner, Tracker, TrackerIssue } from './types/tracker.types.js';

// GitHub Issues behind the tracker interface of decision 176. Every gh call is
// an argv array pinned to one repo; issue text comes back as data fields only.
// An author can edit their issue without write access and the edit leaves no
// labeled event, so a title or body changed since the label is not approved.

const READY_LABEL = 'ready';
const LAST_EDITED_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { lastEditedAt } }
}`;
/** `permission` of GitHub's collaborator endpoint: maintain reads as write, triage as read. */
const WRITE_PERMISSIONS = new Set(['admin', 'write']);
const ISSUE_LIST_LIMIT = 500;
const GH_COMMAND_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 64 * 1024 * 1024;
/** `HOST/OWNER/REPO`, as `originRepoSlug` derives it. */
const REPO_SLUG = /^([A-Za-z0-9.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
/** A user login; a bot's `name[bot]` fails it, and no bot has write access of its own. */
const USER_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const ISSUE_NUMBER = /^[1-9][0-9]*$/;
const RATE_LIMIT = /rate limit/i;

function runGh(args: readonly string[], input?: string): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    timeout: GH_COMMAND_TIMEOUT_MS,
    maxBuffer: GH_MAX_BUFFER,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: pinnedGitEnv(),
  });
}

/** The tracker for `repo` (`HOST/OWNER/REPO`); `run` stands in for gh in tests. */
export function githubTracker(repo: string, run: GhRunner = runGh): Tracker {
  const match = REPO_SLUG.exec(repo);
  const [, host, owner, name] = match ?? [];
  if (!host || !owner || !name || [owner, name].some((part) => /^\.+$/.test(part))) {
    throw new Error(`Not a HOST/OWNER/REPO GitHub repo: '${repo}'.`);
  }
  const apiPath = `repos/${owner}/${name}`;

  const gh = (args: readonly string[], input?: string): string => {
    try {
      return run(args, input);
    } catch (error) {
      throw unavailable(args, error);
    }
  };

  /**
   * Who last applied the ready label to issue `number`, and when in epoch ms;
   * none if nobody did or the title was renamed after.
   */
  const readyApproval = (number: number): { login: string; at: number } | undefined => {
    const select = `.[] | select((.event == "labeled" and .label.name == ${JSON.stringify(READY_LABEL)} and .actor != null) or .event == "renamed") | [.event, .created_at, (.actor.login // "")] | @tsv`;
    const events = gh([
      'api',
      `${apiPath}/issues/${number}/events`,
      '--hostname',
      host,
      '--paginate',
      '--jq',
      select,
    ]);
    let approval: { login: string; at: number } | undefined;
    for (const line of events.split('\n')) {
      const [event, createdAt = '', login = ''] = line.split('\t');
      if (event === 'labeled') approval = { login, at: Date.parse(createdAt) };
      if (event === 'renamed') approval = undefined;
    }
    return approval;
  };

  /** Whether issue `number`'s body has gone unedited since `since`, in epoch ms. */
  const unchangedSince = (number: number, since: number): boolean => {
    const args = [
      'api',
      'graphql',
      '--hostname',
      host,
      '-f',
      `query=${LAST_EDITED_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${number}`,
    ];
    const answer = parseJson(args, gh(args)) as {
      data?: { repository?: { issue?: { lastEditedAt?: unknown } | null } | null };
    } | null;
    const editedAt = answer?.data?.repository?.issue?.lastEditedAt;
    if (editedAt === null) return true;
    if (typeof editedAt !== 'string') {
      throw new TrackerUnavailableError(
        `\`gh api graphql\` did not answer when issue ${number} was last edited.`,
      );
    }
    return Date.parse(editedAt) < since;
  };

  const writers = new Map<string, boolean>();
  const hasWriteAccess = (login: string): boolean => {
    if (!USER_LOGIN.test(login)) return false;
    let allowed = writers.get(login);
    if (allowed === undefined) {
      const permission = gh([
        'api',
        `${apiPath}/collaborators/${login}/permission`,
        '--hostname',
        host,
        '--jq',
        '.permission',
      ]).trim();
      allowed = WRITE_PERMISSIONS.has(permission);
      writers.set(login, allowed);
    }
    return allowed;
  };

  return {
    listReady() {
      writers.clear();
      const args = [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--label',
        READY_LABEL,
        '--limit',
        String(ISSUE_LIST_LIMIT),
        '--json',
        'number,url,title,body,labels',
      ];
      const issues = parseIssues(args, gh(args));
      return issues
        .filter(({ number }) => {
          const approval = readyApproval(number);
          return (
            approval !== undefined &&
            hasWriteAccess(approval.login) &&
            unchangedSince(number, approval.at)
          );
        })
        .map(({ issue }) => issue);
    },

    comment(issueId, body) {
      gh(['issue', 'comment', issueNumber(issueId), '--repo', repo, '--body-file', '-'], body);
    },

    removeLabel(issueId, label) {
      gh(['issue', 'edit', issueNumber(issueId), '--repo', repo, '--remove-label', label]);
    },
  };
}

function issueNumber(issueId: string): string {
  if (!ISSUE_NUMBER.test(issueId)) throw new Error(`Not a GitHub issue number: '${issueId}'.`);
  return issueId;
}

/** gh's issue list as tracker issues, each beside its number; any other shape is a refusal. */
function parseIssues(
  args: readonly string[],
  output: string,
): { number: number; issue: TrackerIssue }[] {
  const parsed = parseJson(args, output);
  if (!Array.isArray(parsed)) {
    throw new TrackerUnavailableError(`\`gh ${args[0]} ${args[1]}\` did not answer a list.`);
  }
  return parsed.map((entry: unknown) => {
    const { number, url, title, body, labels } = (entry ?? {}) as Record<string, unknown>;
    if (
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      typeof url !== 'string' ||
      typeof title !== 'string' ||
      typeof body !== 'string' ||
      !Array.isArray(labels)
    ) {
      throw new TrackerUnavailableError(
        `\`gh ${args[0]} ${args[1]}\` answered an issue without its fields.`,
      );
    }
    const names = labels
      .map((label: unknown) => (label as { name?: unknown } | null)?.name)
      .filter((label): label is string => typeof label === 'string');
    return { number, issue: { id: String(number), url, title, body, labels: names } };
  });
}

/** The output of gh `args` as JSON; output that is not JSON is a refusal. */
function parseJson(args: readonly string[], output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new TrackerUnavailableError(`Cannot parse \`gh ${args[0]} ${args[1]}\` output as JSON.`);
  }
}

/** One refusal for any gh failure, naming a rate limit as such. */
function unavailable(args: readonly string[], error: unknown): TrackerUnavailableError {
  const command = `gh ${args[0]} ${args[1]}`;
  const stderr = String((error as { stderr?: unknown } | null)?.stderr ?? '').trim();
  if (RATE_LIMIT.test(stderr)) {
    return new TrackerUnavailableError(
      `GitHub rate limited \`${command}\`; try again once the limit resets.`,
      true,
    );
  }
  const reason = stderr || (error instanceof Error ? error.message : String(error));
  return new TrackerUnavailableError(`\`${command}\` failed: ${reason}`);
}
