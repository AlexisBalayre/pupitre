/** One dead turn the sweep acted on. */
export interface ResumedTurn {
  /** The session resumed, or `conductor` for the operator's delegate. */
  id: string;
  /** The pane's own error line, sanitized for the terminal (decision 29). */
  reason: string;
  /** Why nothing was typed, when the steer was refused; the resume then needs a human. */
  refusal?: string;
}
