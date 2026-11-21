/** Another session's branch that can still land, as the check reads it. */
export interface Competitor {
  /** The session's branch, which a refusal names. */
  branch: string;
  /**
   * What holds its decisions: the live branch's ref, or the commit an open PR's
   * gate pinned, undefined when its merge recorded none.
   */
  rev: string | undefined;
  /**
   * The PR's url, set on a pinned peer: one whose commit git cannot find
   * refuses the gate, naming the PR, rather than read as absent.
   */
  prUrl?: string;
}
