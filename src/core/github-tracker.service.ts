import { execFileSync } from 'node:child_process';
import { TrackerUnavailableError } from './errors/tracker.errors.js';
import { pinnedGitEnv } from './git-diff.client.js';
import type { GhRunner, Tracker, TrackerIssue } from './types/tracker.types.js';

// GitHub Issues behind the tracker interface of decision 176. Every gh call is
// an argv array pinned to one repo; issue text comes back as data fields only.
// An author can edit their issue without write access and the edit leaves no
// labeled event, so a title or body changed since the label is not approved.
// The issue list only names candidates: each issue's text and the evidence
// that approves it come from one answer, so the text returned is the text checked.

const READY_LABEL = 'ready';
/**
 * One issue with its latest label and rename events. A ready label applied
 * before the last 100 of them falls out of that tail and leaves the issue out.
 */
const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      url title body state lastEditedAt
      labels(first: 100) { nodes { name } }
      timelineItems(itemTypes: [LABELED_EVENT, RENAMED_TITLE_EVENT], last: 100) {
        nodes {
          __typename
          ... on LabeledEvent { createdAt label { name } actor { __typename login } }
          ... on RenamedTitleEvent { createdAt }
        }
      }
    }
  }
}`;
/** `permission` of GitHub's collaborator endpoint: maintain reads as write, triage as read. */
const WRITE_PERMISSIONS = new Set(['admin', 'write']);
const ISSUE_LIST_LIMIT = 500;
const GH_COMMAND_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 64 * 1024 * 1024;
/** `HOST/OWNER/REPO`, as `originRepoSlug` derives it. */
const REPO_SLUG = /^([A-Za-z0-9.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
/** A user login, safe to put in an API path. */
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
   * Issue `number` and the login that approved it, if one answer shows it open
   * and labelled ready, a user's latest application of the label coming after
   * its last rename and its last edit.
   */
  const approvedIssue = (number: number): { issue: TrackerIssue; labeller: string } | undefined => {
    const args = [
      'api',
      'graphql',
      '--hostname',
      host,
      '-f',
      `query=${ISSUE_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${number}`,
    ];
    const { issue, open, editedAt, timeline } = parseIssueAnswer(args, number, gh(args));
    const approval = readyApproval(timeline);
    if (!open || !issue.labels.includes(READY_LABEL) || !approval) return undefined;
    const unedited = editedAt === null || Date.parse(editedAt) < approval.at;
    return unedited ? { issue, labeller: approval.login } : undefined;
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
        'number',
      ];
      return parseNumbers(args, gh(args)).flatMap((number) => {
        const approved = approvedIssue(number);
        return approved && hasWriteAccess(approved.labeller) ? [approved.issue] : [];
      });
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

/**
 * Who last applied the ready label in `timeline`, oldest event first, and when
 * in epoch ms; none if a rename followed it or no user applied it.
 */
function readyApproval(timeline: readonly unknown[]): { login: string; at: number } | undefined {
  let approval: { login: string; at: number } | undefined;
  for (const node of timeline) {
    const { __typename: event, createdAt, label, actor } = (node ?? {}) as Record<string, unknown>;
    if (event === 'RenamedTitleEvent') approval = undefined;
    if (event === 'LabeledEvent' && (label as { name?: unknown } | null)?.name === READY_LABEL) {
      const { __typename: kind, login } = (actor ?? {}) as Record<string, unknown>;
      const at = Date.parse(String(createdAt));
      approval =
        kind === 'User' && typeof login === 'string' && Number.isFinite(at)
          ? { login, at }
          : undefined;
    }
  }
  return approval;
}

/** The issue numbers in gh's issue list; any other shape is a refusal. */
function parseNumbers(args: readonly string[], output: string): number[] {
  const parsed = parseJson(args, output);
  if (!Array.isArray(parsed)) {
    throw new TrackerUnavailableError(`\`gh ${args[0]} ${args[1]}\` did not answer a list.`);
  }
  return parsed.map((entry: unknown) => {
    const number = (entry as { number?: unknown } | null)?.number;
    if (typeof number !== 'number' || !Number.isInteger(number)) {
      throw new TrackerUnavailableError(
        `\`gh ${args[0]} ${args[1]}\` answered an issue without its number.`,
      );
    }
    return number;
  });
}

/** Issue `number` as gh's GraphQL answer holds it; an answer without its fields is a refusal. */
function parseIssueAnswer(
  args: readonly string[],
  number: number,
  output: string,
): { issue: TrackerIssue; open: boolean; editedAt: string | null; timeline: unknown[] } {
  const answer = parseJson(args, output) as {
    data?: { repository?: { issue?: unknown } | null } | null;
  } | null;
  const { url, title, body, state, lastEditedAt, labels, timelineItems } = (answer?.data?.repository
    ?.issue ?? {}) as Record<string, unknown>;
  const labelNodes = (labels as { nodes?: unknown } | null)?.nodes;
  const timeline = (timelineItems as { nodes?: unknown } | null)?.nodes;
  if (
    typeof url !== 'string' ||
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    typeof state !== 'string' ||
    (lastEditedAt !== null && typeof lastEditedAt !== 'string') ||
    !Array.isArray(labelNodes) ||
    !Array.isArray(timeline)
  ) {
    throw new TrackerUnavailableError(
      `\`gh api graphql\` answered issue ${number} without its fields.`,
    );
  }
  const names = labelNodes
    .map((label: unknown) => (label as { name?: unknown } | null)?.name)
    .filter((label): label is string => typeof label === 'string');
  return {
    issue: { id: String(number), url, title, body, labels: names },
    open: state === 'OPEN',
    editedAt: lastEditedAt,
    timeline,
  };
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
