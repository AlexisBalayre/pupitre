export interface NewPullRequest {
  /** `HOST/OWNER/REPO` pin for gh's `--repo`, derived from the origin remote. */
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}
