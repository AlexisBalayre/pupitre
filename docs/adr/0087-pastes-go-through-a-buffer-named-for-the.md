# 0087. Pastes go through a buffer named for the call, every attach spawns tmux from the runtime with the scrubbed environment, a steer reads the box by its frame, and `pup attach <session>` enters a worker's window (2026-10-16, amends 45, 47 and 85)

- Status: accepted
- Amends: [0045](0045-a-steer-is-submitted-only-once-the-pane.md), [0047](0047-a-conductor-session-is-the-operator-s-delegate.md), [0085](0085-pup-attach-hands-the-terminal-to-the-conductor.md)

87. **Pastes go through a buffer named for the call, every attach spawns tmux from the runtime
    with the scrubbed environment, a steer reads the box by its frame, and `pup attach <session>`
    enters a worker's window (2026-10-16, amends 45, 47 and 85).**
    Four holes around the tmux paste and attach paths. `pasteText` loaded the message into tmux's
    unnamed buffer and pasted the top of the stack, so a steer and a `pup conductor tell` racing on
    one server could each paste the other's text into the wrong box and submit it. Each paste now
    loads `load-buffer -b pup-paste-<uuid> -` and pastes `paste-buffer -b <same> -d -p -t <pane>`,
    a name minted per call, so no two pastes share a buffer; a paste that fails deletes its buffer
    (`delete-buffer -b`), so the message is not left on the server for `show-buffer` to read.
    `pup ui`'s attach spawned tmux itself, with none of `tmuxEnv()`'s scrubbing, so the operator's
    `ANTHROPIC_API_KEY`, `$TMUX` and the rest reached a tmux that, finding no server, starts one
    whose global environment every window inherits and any client reads back (decision 47); and
    an inherited `$TMUX` pointed a session attach, which names no socket, at whatever server the
    operator's terminal was on. `attachConductor` becomes `attachWindow(target)` in
    `session-runtime.service.ts`, taking a session, the conductor or the radar, and is the one
    attach spawn: `pup attach` and `pup ui` both call it, and `AttachTarget` carries the window
    rather than an argv. `steerPane` read the box through `inputBoxText`, which takes the echo of
    the prompt just submitted, still on screen above a dialog, for a box holding text: the steer
    then pressed Ctrl-U into the dialog, or with an empty echo pasted into it. It now reads
    `inputBoxState`, the frame rule `pup conductor tell` uses (decision 85): a box that is not on
    screen is refused before any key with a new `SteerNotDeliveredError` reason, `box-absent`,
    that says a dialog holds the pane; a paste that never showed whole is cleared only when the
    box is still there; and the Enter retry stops once the box leaves the screen rather than
    pressing Enter into what replaced it. `pup attach <session>` hands the terminal to that
    worker's window on the default server through `attachWindow`, after the same operator-only
    refusal and with the same kind of detach hint (`Ctrl-b d detaches and leaves the session
    running; Ctrl-c or /exit would kill it`). It refuses a session this project's store does not
    hold, before tmux is asked, and one with no live window (`hasSessionWindow`, a pinned
    `has-session` on the default server), naming `pup status --history`. Bare `pup attach` still
    attaches the conductor.
    Tests: against the fake tmux, which now keeps named buffers and refuses a paste of one it
    does not hold, two steers load and paste two different names, each paste the name its load
    used, with no buffer left; a racing client's unnamed load between the load and the paste does
    not reach the box; a paste to a gone pane deletes its buffer; a dialog under an echoed prompt
    is refused with no key pressed and nothing typed; a dialog that replaces the box after Enter
    gets no second Enter. `attachWindow` keeps `ANTHROPIC_API_KEY` and `TMUX` out of the spawn for
    a session's window and the conductor's; `pup ui`'s `attachTo` does the same through it, and
    reports a tmux that could not be spawned. `pup attach <session>` prints the hint, then
    attaches; refuses a session with no live window, an unknown one before asking tmux, and a
    session and the conductor; and carries tmux's failing status.
