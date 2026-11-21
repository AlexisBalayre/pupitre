export interface PullRequestRef {
  /** `HOST/OWNER/REPO` pin for gh's `--repo`, derived from the origin remote. */
  repo: string;
  head: string;
  base: string;
}

export interface NewPullRequest extends PullRequestRef {
  title: string;
  body: string;
}

export interface ListedPullRequest {
  url?: unknown;
  baseRefName?: unknown;
  isCrossRepository?: unknown;
  autoMergeRequest?: unknown;
}

/**
 * One unresolved thread the review bot opened, still on the head's code: its
 * first comment is the finding.
 */
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
  /**
   * A fix round already replied on it and left it open for the operator, and
   * nobody who may reopen it commented since: of its newest comments, the last
   * one by the bot, by pup's own account or by the repo's owner, a member or a
   * collaborator is pup's reply, marked. Anyone else's comment is skipped.
   */
  isAnswered: boolean;
  /**
   * The comments on it since a fix round's newest marked reply, or since the
   * finding when no round replied, oldest first, that pup's own gh account or
   * the repo's owner wrote: the round takes them with the finding, as thread
   * data. Every session posts as that same login, so none is proof of the
   * operator's word. A member or collaborator may reopen a thread but is not
   * relayed, as neither proves write access; nor is a comment hidden on GitHub
   * or edited by an account other than its author's.
   */
  replies: string[];
  /**
   * The `fullDatabaseId` of the newest comment on it this read saw, whoever
   * wrote it: a round records it, so its gate tells a reply posted after the
   * kickoff read the thread, which its worker never saw, by a greater one.
   * Undefined when no comment carries one.
   */
  newestComment: string | undefined;
}

export interface PullRequestReview {
  state: string | undefined;
  head: string | undefined;
  /** The commit the bot's newest review is on; undefined when it has not reviewed. */
  reviewedHead: string | undefined;
  /** The bot's `claude-review` status on the head: its verdict, or why it reached none. */
  headStatus: { state: string; description: string } | undefined;
  /**
   * The repo's owner commented `@claude review` on the PR after the bot set
   * `headStatus`: the workflow reviews the head again on that comment, and
   * nothing marks the head while it runs, so `headStatus` is the run's before.
   */
  isRereviewAsked: boolean;
  /**
   * Every unresolved, non-outdated thread the bot opened, whichever of its runs
   * opened it, in GitHub's order, those a fix round answered included.
   */
  openThreads: ReviewThread[];
  /**
   * The bot's unresolved threads a push outdated. They are not relayed, since
   * their line moved, but a push alone does not answer one, so the operator
   * resolves each before the PR reads ready.
   */
  outdatedThreads: number;
}

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
  /** The greatest `fullDatabaseId` among its comments a fix round relays; undefined when none is. */
  newestRelayed: string | undefined;
}
