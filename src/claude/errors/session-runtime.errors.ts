/**
 * The launching shell's `CLAUDE_CONFIG_DIR` is not a dir a window may run on:
 * the operator's to fix, so a launch refuses on it rather than crashing. The
 * message quotes the shell's value.
 */
export class ConfigDirRefusedError extends Error {
  constructor(value: string, reason: string) {
    super(
      `CLAUDE_CONFIG_DIR is ${JSON.stringify(value)}, which --session-env passes to every ` +
        `window: ${reason}.`,
    );
    this.name = 'ConfigDirRefusedError';
  }
}

/**
 * The session's pane, or a refusal. Raised before anything is sent: a pane
 * that was never recorded, or that is not a pane id — a row from before panes
 * were pinned holds the session name, which tmux would resolve to the active
 * pane — cannot be steered, and one tmux reports gone cannot be either. The
 * session runs on untouched, or is already gone; either way nothing landed
 * anywhere else.
 */
export class SessionPaneMissingError extends Error {
  readonly sessionId: string;
  readonly paneId: string | null;

  constructor(sessionId: string, paneId: string | null, reason: 'unrecorded' | 'gone') {
    super(
      paneId === null
        ? `Session ${sessionId} has no pane recorded at launch; nothing was sent.`
        : reason === 'unrecorded'
          ? `Session ${sessionId} recorded ${JSON.stringify(paneId)} as its pane, which is not ` +
            'a tmux pane id (it was launched before panes were pinned); nothing was sent. ' +
            `Respawn it: \`pup kill --respawn ${sessionId}\`.`
          : `Session ${sessionId}'s pane ${paneId} no longer exists; nothing was sent.`,
    );
    this.name = 'SessionPaneMissingError';
    this.sessionId = sessionId;
    this.paneId = paneId;
  }
}

/**
 * A steer that was not submitted: its paste never showed up whole in the
 * session's input box (the box was then cleared), or the box held text Ctrl-U
 * could not clear, or no box was on screen at all, so nothing was pasted.
 * Either way nothing was submitted and the session runs on untouched.
 */
export class SteerNotDeliveredError extends Error {
  readonly sessionId: string;

  constructor(
    sessionId: string,
    chars: number,
    reason: 'never-landed' | 'box-not-cleared' | 'box-absent' = 'never-landed',
  ) {
    super(
      reason === 'never-landed'
        ? `Steer to session ${sessionId} did not land: its input box never held the whole ` +
            `${chars}-char message. Cleared the box and submitted nothing; the session is ` +
            'still running with an empty prompt.'
        : reason === 'box-not-cleared'
          ? `Steer to session ${sessionId} did not land: its input box held text that Ctrl-U ` +
            `could not clear, so the ${chars}-char message was not pasted. Nothing was ` +
            'submitted; the session is still running with the box as it was.'
          : `Steer to session ${sessionId} did not land: its input box is not on screen (a ` +
            `dialog or menu holds the pane), so the ${chars}-char message was not pasted and ` +
            'no key was pressed. The session runs on; answer what its window shows, then steer again.',
    );
    this.name = 'SteerNotDeliveredError';
    this.sessionId = sessionId;
  }
}
