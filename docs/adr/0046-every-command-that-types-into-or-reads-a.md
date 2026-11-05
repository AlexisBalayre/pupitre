# 0046. Every command that types into or reads a session goes to the pane recorded at launch, never to the session (2026-09-06)

- Status: accepted

46. **Every command that types into or reads a session goes to the pane recorded at launch,
    never to the session (2026-09-06).** `tmuxTarget` built `=pup-<id>:`, a session target,
    which tmux resolves to the session's *active* pane, and the agent holds `$TMUX`: decision
    45's security review verified that one `tmux split-window` from inside the session moved
    `capture-pane`, `paste-buffer` and `send-keys` to the new pane — a shell of the agent's own
    — where `pasteLanded` read the operator's steer as landed and Enter ran it, while `pup`
    printed `Steered` and wrote a `steer` event. Re-verified here on tmux 3.7b before the fix:
    a split moves the active pane; a pane id (`%N`) addressed after a `swap-pane` still reaches
    the same process; `kill-session -t %N` kills the session holding that pane after a
    `rename-session` that the pinned name no longer finds.
    *Pin the pane, mint it once.* `new-session -d -P -F '#{pane_id}'` prints the id of the
    pane it opened, and `launchSession` returns it as a `SessionPane` (`sessionId`,
    `paneId`); the id is checked where it is minted, so a launch whose tmux printed anything
    else fails there rather than late. `startSession` and the respawn paths store it in
    `sessions.tmux_target` — the column existed and held the session name — before the
    kickoff types into it. `steerPane`, `interruptPane`, `kickoff` and `capturePane` take the
    pane, and `paneTarget` is the single place a `-t` is formed for anything that types or
    reads: a value that is not `%N` is refused there, never passed to tmux, where a bare name
    would resolve to the active pane. A pane id is server-unique and never reissued, so a
    split, a swap or a rename cannot move it, and there is no fallback from a pane to a name
    anywhere. `pinned()` remains for the two commands that address a session by name and
    nothing else: the stale-name kill before `new-session`, and `killSession`, which now
    kills by pane first (so a renamed window does not run on under a name the kill cannot
    find) and by pinned name second (for a row whose pane was never recorded, and for the
    panes a split left in the session).
    *A missing pane is a refusal, not a redirect.* `SessionPaneMissingError` names the session
    and the pane, and nothing is sent: a row with no pane recorded (a launch that failed before
    its update) refuses in `sessionPane`; a row whose `tmux_target` is not a pane id — every
    session launched before this change holds its name there — refuses in `paneTarget` and
    says to respawn it, which mints a pane; a pane tmux reports gone, or a dead server, is
    tmux's own can't-find-pane or error-connecting line turned into the same error by `tmuxAt`,
    which pipes stderr so the operator reads the refusal and not tmux's. The session half of
    the runtime moved into `session-lifecycle`: `sessionPane(row)`, `steerSession(db, id,
    message)` and `interruptSession(db, id)` resolve the row and hand its pane to the runtime,
    the shape `killSession(db, id)` already had; `requestHandoff` and the respawns use the row
    they hold.
    *Verified by the fake, and by reverting.* The runtime suite's `tmux` script now models
    panes the way tmux resolves `-t`: a pane id names that pane and must exist, anything else
    resolves to whichever pane is active, and each pane keeps what was pasted or keyed into
    it. The discriminating case splits from inside — pane 9 becomes active — and asserts the
    steer and its Enter reached pane 3 and nothing reached pane 9; with `paneTarget` reverted
    to the session form the paste and Enter land in pane 9 and the test fails, which is the
    finding reproduced. A killed launch pane refuses with the named error after one capture,
    and a dead server refuses the same way; a legacy name refuses before any tmux call. The
    lifecycle and handoff suites assert the stored pane, the kickoff's pane, the kill's pane
    and the refusals through the mocked runtime.
    *Every caller goes through the store.* `pup steer` and `pup interrupt` call
    `steerSession(db, id, message)` and `interruptSession(db, id)` from `session-lifecycle`,
    as does the merge gate's rejection re-steer, and the merge's kill passes the row's pane
    beside the name; the runtime no longer exports a session-addressed steer, so there is no
    name-addressed path left for a caller to fall back on. Where a refusal is printed,
    `SessionPaneMissingError` is caught beside `SteerNotDeliveredError` and nothing is
    recorded: a steer refused for a gone pane writes no `steer` event, an interrupt refused
    before Escape writes no `interrupt` event, a launch whose window died under its kickoff
    is rolled back the way a refused kickoff is, and `pup respawn` points a gone pane at
    `pup kill --respawn` rather than a re-run that has no pane to ask. The gate parks a
    session with no pane recorded as blocked, as it does any re-steer it cannot deliver.
    *What this leaves open.* **The store is the root of trust.** The pane pin closes the tmux
    path; an agent that edits `sessions.tmux_target` in the store, which its shell can reach,
    points a steer wherever it likes, as it could already write any row. The sandbox that
    keeps the agent's hands off its own window and store is the instrument, as decisions 44
    and 45 said. **A move across sessions.** `swap-pane`, `join-pane`, `break-pane -t` and
    `move-pane` between two pup sessions each carry the launch pane into a sibling's window;
    steers still reach it, and a kill by pane then kills the sibling's session around it.
    With `join-pane` the source session is emptied and tmux destroys it itself, so the
    name-kill that follows finds nothing and only the sibling dies (verified on tmux 3.7b:
    `join-pane -s %0 -t =pupB:` then `kill-session -t %0` killed B). Nothing in the
    split-only threat model does this, and the pane-first kill is still the right order:
    without it a rename leaves the window running. **Denial of steering** stands as
    decision 45 left it.
