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
