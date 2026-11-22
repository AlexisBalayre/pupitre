/**
 * An issue as the tracker holds it (decision 176). `title` and `body` are the
 * author's text, unmodified: data to quote, never instructions to follow.
 */
export interface TrackerIssue {
  /** The tracker's own key for the issue, e.g. an issue number or `ENG-12`. */
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/**
 * The narrow tracker interface of decision 176: what intake needs and no
 * more, so a tracker other than GitHub Issues can stand behind it.
 */
export interface Tracker {
  /** Open issues carrying the ready label, applied by someone allowed to start the work. */
  listReady(): TrackerIssue[];
  comment(issueId: string, body: string): void;
  removeLabel(issueId: string, label: string): void;
}
