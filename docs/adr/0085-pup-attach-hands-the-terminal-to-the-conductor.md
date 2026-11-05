# 0085. `pup attach` hands the terminal to the conductor, and `pup conductor tell <message>` types into it (2026-10-14)

- Status: accepted
- Amended by: [0087](0087-pastes-go-through-a-buffer-named-for-the.md)

85. **`pup attach` hands the terminal to the conductor, and `pup conductor tell <message>` types
    into it (2026-10-14).**
    Reaching the conductor meant copying the attach line `pup status` prints, and the two keys an
    operator reaches for to leave a Claude Code window, Ctrl-c and `/exit`, end the conductor
    rather than leave it. Telling it something meant attaching to type it. `pup attach` refuses when
    no conductor runs, naming `pup conductor start`, and otherwise prints `Ctrl-b d detaches and
    leaves the conductor running; Ctrl-c or /exit would kill it` before it runs the argv the attach
    line spells (`attachArgs`, socket and pinned target included, decision 47) with the terminal
    inherited and the environment scrubbed like every tmux call's; pup exits with tmux's status.
    `pup conductor tell <message>` refuses an empty or blank message and one over 800 characters,
    since Claude Code folds a longer paste into a placeholder and it arrives truncated, then pastes
    the message into the conductor's pane, found by `conductorPane` on its own socket. The text rides
    tmux's stdin through `load-buffer -`, and `paste-buffer -p` names only the pane, so it is on no
    tmux argv, which any process on the machine can read, and `send-keys` never carries it; pup's
    own argv still does, as `pup steer`'s does.
    It refuses, sending nothing, unless the input box is on screen and empty: a paste appends to
    what the box holds, and a draft there may be the operator's own from `pup attach`, so the tell
    neither submits it with the message nor erases it. It waits, as a steer does, until the paste
    shows whole; when it never does it clears the box, which it saw empty, and presses no Enter, so
    no part of the message is left for a later Enter (decision 45). Then it presses Enter, waits one
    submit beat, and presses Enter a second time only when text is still in the box, never when a
    dialog has replaced the box, where Enter would pick an option. The box is told apart from a
    dialog by its frame: its prompt row sits right under the top border, and the echo of the prompt
    just submitted, still on screen above a dialog, does not. It prints whether it landed, which is
    the box on screen and empty after the last Enter, and fails when it does not. It is not
    `steerPane`: the tell refuses a non-empty box rather than clearing it and owns its single
    retry, so the runtime exports the steps (`pasteIntoPane`, `submitPane`, `readInputBox`, which
    reads the box as empty, holding text, or absent) and the sequence lives in `tellConductor` in
    `conductor.service.ts`. The tmux calls stay in
    `src/claude/`, `pup attach`'s included (`attachConductor`). Both commands are the operator's: a
    session or the conductor running either is refused, as `pup status` withholds the socket from
    them and the socket exists to keep every session from typing into the conductor (decision 47).
    `pup conductor start` and `stop` refuse a message rather than drop it.
    Tests: `tellConductor` with the runtime mocked refuses an empty, a blank and an 801-character
    message before looking for a pane, refuses with `pup conductor start` when there is no pane,
    takes 800, refuses a box holding text or off screen before the paste, presses no Enter when the
    paste never shows whole, presses Enter once when the box clears, twice when it still holds text,
    once only when a dialog replaced it, and answers not landed when the second Enter leaves text
    there or the box is gone. `inputBoxState` reads a dialog under an echoed prompt as no box.
    Against the fake tmux `pasteIntoPane` clears a box whose paste never showed whole, presses
    nothing into a dialog already up, and stops clearing at the first look that finds one, and the
    paste is `load-buffer -` then `paste-buffer -d -p -t <pane>` on the conductor's socket with the
    text on no argv. `pup attach` refuses with no conductor, prints the hint before attaching, carries
    tmux's failing status, and refuses a session and the conductor; `pup conductor tell` prints
    landed or not, prints core's refusals, and refuses a session and the conductor.
