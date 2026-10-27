# 0045. A steer is submitted only once the pane shows it whole, and never in part (2026-09-06)

- Status: accepted
- Amended by: [0087](0087-pastes-go-through-a-buffer-named-for-the.md)

45. **A steer is submitted only once the pane shows it whole, and never in part (2026-09-06).**
    `steerSession` pasted through `tmux paste-buffer`, slept 700 ms, and pressed Enter. Twice
    on 2026-09-05 a 1.5–1.7 KB operator steer reached the agent as its tail alone — one as the
    four characters `ath.`, one starting mid-word — while steers under ~900 chars arrived
    whole; and on 2026-09-06 a session opened saying its prompt carried only the session
    protocol, which is the last section of the compiled context. That is the same failure on
    the first prompt of every session: `kickoff` delivers the context through the same call.
    Reproduced against a scratch Claude Code 2.1.263 pane with a 1.8 KB message: the agent
    received `19 tok120 … LASTWORD`, the head gone.
    *Two causes, two fixes.* First, the paste was not bracketed. The pty hands the text to the
    UI in ~1 KB reads, and without bracket marks the UI takes each read as its own paste —
    three placeholders for 3000 chars, `[Pasted text #1][Pasted text #2][Pasted text #3]`
    — and an Enter timed between them submits whatever had folded. `paste-buffer -p`
    wraps the whole buffer in the bracket marks, and the UI then folds it as one paste:
    fifteen of fifteen trials, 3 KB single-line and 19 KB over 150 lines, one placeholder
    each within 100 ms. Second, a fixed settle is a guess about ingestion time, and the guess
    was wrong at 1.5 KB. Enter now waits for `capturePane` to show the message whole, one
    settle per KB of message and never fewer than five — the first cut gave a one-line steer
    two settles, 1.4 s on a machine an audit pushes past a load of 60, which the security
    review named as a refusal mode of its own — and is never sent otherwise.
    *What "whole" can mean through a pane.* The UI folds any paste over ~800 chars, or over
    a couple of lines, into `[Pasted text #N]`, with `+L lines` where L is the newline count,
    so the words are unreadable and the count is the one thing to check; a shorter paste
    renders inline, and must begin with the message's first word and end with its last, in
    the box's last column-0 `❯` block — a submitted prompt is echoed above the box under the
    same glyph. `pasteLanded` in `pane.utils.ts` is that rule, pure over the capture, with the
    live panes as fixtures: the tail-only box of the reproduction, and `row one[Pasted text
    #33]`, a paste appended to a draft the box already held, which the first cut of this
    change met in the wild and rightly refused. The box is cleared before pasting for that
    reason, and cleared again on refusal: Ctrl-U takes one row per press, so clearing is a
    bounded loop of presses, each checked against the pane, and a box the budget cannot
    empty is its own refusal — the error says the box held text Ctrl-U could not clear and
    nothing was pasted, rather than the never-landed text, which would send the operator
    looking at the paste instead of at the box.
    *Refusal is an exit, not an event.* A paste that never shows whole raises
    `SteerNotDeliveredError`, named and carrying the session and the length; `pup steer`,
    `pup interrupt`, `pup launch`, `pup new`, `pup respawn` and `pup audit --sweep` print it
    and exit 1, and no `steer` event is written, since nothing was steered. `pup interrupt`
    still records its interrupt, because Escape had landed; `pup respawn` adds the re-run
    line. A launch whose kickoff is refused is rolled back, not left: `startSession` throws
    after the task is claimed, the row is `running` and the window is open, so the first cut
    left a claimed task (a re-launch raised `TaskAlreadyClaimedError`), an empty window and no
    kickoff or `scope_overlap` event behind a message that read as benign — the security
    review's finding 2. `session-lifecycle` is outside this change's scope, so `pup launch`,
    `pup new` and `pup audit --sweep` catch the error, which carries the session id, and call
    `killSession` on it: the window goes, the row is `killed`, the task returns to the backlog
    (decision 40), and the two lines printed say the launch was rolled back and which command
    to re-run. The operator sees a failed launch rather than an agent working from the tail
    of its task — the alternative, a `delivered:false` event and a "Launched" line, is what
    let the truncated kickoffs pass as started. `merge-gate` already treated a throwing
    re-steer as a blocked session, and now does so for this one too, under its existing
    reason `session unreachable`, which is now the wrong reason for a refused paste; the
    gate is outside this change's scope, and its own reason is a small later change.
    *Verified in vivo, then by removal.* The fixed path delivered the 1.8 KB reproduction whole
    (`FIRST=FIRSTWORD LAST=LASTWORD TOKENS=230` from the agent). The runtime suite drives the
    real `execFileSync` at a `tmux` script on PATH that logs its argv and plays the input box
    (the testing convention for `gh`): a 3000-char steer's log shows two settles ending in a
    tail, one ending in the placeholder, and only then Enter; a never-landing one shows the
    scaled settle count, Ctrl-U, and no Enter; the kickoff cases show the `+802 lines`
    placeholder before Enter and the throw. The fake clears one row per Ctrl-U, as the UI
    does, so the press loop is exercised, and it can be pinned stuck for the box-not-cleared
    case. Deleting the verification, the `-p`, the pre-paste clear, the settle floor, the
    clear's return check, or any one command's rollback fails a named test each.
    *What this leaves open.* **The guarantee holds for the pane the target resolves to.**
    `tmuxTarget` builds `=pup-<id>:`, a session target, which tmux resolves to the session's
    *active* pane, and the agent has `$TMUX`: the security review verified that one
    `tmux split-window` from inside the session moved `capture-pane`, `paste-buffer` and
    `send-keys` to the new pane, and `pasteLanded` returned true for the capture there. An
    agent that splits its window can therefore receive an operator's steer in a shell of its
    own and have Enter run it — a finding that predates this change and is not fixed by it.
    The fix is to pin the pane, not the session: capture the pane id at launch
    (`new-session -P -F '#{pane_id}'`), store it as `tmux_target`, and address every later
    command to it; its own change, planned in the backlog. **Denial of steering.** The clear
    is fail-safe, so an agent that keeps one character in its box makes every steer, handoff
    request and respawn refuse; the refusal is loud and names the box, and the pane pin above
    does not close it. A sandbox that keeps the agent's hands off its own window is the
    instrument, as decision 44 said of cwd. The check also inherits the pane's rendering
    rules: a word wider than the pane wraps mid-way and an inline paste of it is refused, and
    a future UI that changes the placeholder text refuses every folded paste until
    `pane.utils.ts` learns the new form — loud, on the first steer, which is the right side to
    fail on. A steer refused mid-turn leaves the session running untouched; the operator
    re-runs it.

    *Addendum, 2026-09-12: what the box suggests is not what the user typed.* The first
    operator steer after this decision merged was refused with box-not-cleared, and so was
    every steer, handoff request and gate re-steer to a session that had finished a turn:
    the driving loop was blocked on it. Nothing was in the box. Claude Code 2.1.263 offers a
    prompt of its own there once a turn ends — the capture read `❯ run the security review on
    this branch` — and the offer is not text: Escape does not dismiss it and Ctrl-U does not
    clear it, so `hasUnsubmittedInput` read a draft and `steerPane` spent all 64 presses on an
    empty box. The `Try "…"` hint was already known and matched by its prefix; a suggestion
    has no prefix to match, and matching its words would be matching the operator's own steers.
    *Dim is the discriminator, and only `-e` shows it.* Both are one thing: the box's ghost
    text, which Claude Code renders dim (SGR 2) where typed and pasted text carry no dim at
    all. Verified live on 2.1.269 by capturing the same box in each state: the hint is
    `\u001b[39m❯\u00a0\u001b[2mTry "how does <filepath> work?"\u001b[0m`, a typed draft is
    `\u001b[39m❯\u00a0draft text`, and a folded paste's `[Pasted text #1]` is undimmed too —
    which matters, since blanking it would have made every landed paste read as empty. So the
    four looks at the input box now take `capture-pane -e`, `pane.utils.ts` blanks every dim
    run before reading the box, and a box left with nothing else is empty. `waitUntilReady`
    keeps the plain capture: its marker carries no styling and escapes would only hide it.
    Two things the parser has to get right, both shapes the real capture produces: tmux emits
    only the attribute *changes*, so dim carries from one row to the next and the whole
    capture is scanned in order, not from the prompt down; and a 256-colour parameter has to
    be skipped whole, or `38;5;2` reads as dim and `38;5;22` as a reset. Ghost-completion
    falls out of the same rule — a typed head stands, the suggested tail is blanked. The
    hint's prefix stays as the fallback for a capture with no styling to read, and the fake
    tmux now renders a suggestion dim under `-e` and bare without it: the test that drops the
    flag on its way to the fake spends the 64 presses again, which is what makes `-e`
    load-bearing rather than incidental.
    *What this leaves open.* **The suggestion could not be reproduced on demand.** Neither
    2.1.263 nor 2.1.269 offered one across five probe turns on 2026-09-12, so the fixture's
    styling and non-breaking space are a verbatim live capture of the hint that shares the
    slot, and only its text is the one captured on 2026-09-06. A paste does replace a
    suggestion — the 2026-09-06 sighting recorded that typing replaces it and Ctrl-U brings
    it back, which is the hint's behaviour and the reason the pre-clear was the only thing in
    the way. Had it appended instead, the box would not begin with the message's first word
    and `pasteLanded` would refuse it as never-landed rather than submit it in part, so the
    steer fails loudly either way. **A suggestion is still a way to deny steering**, as a
    held character was: one the agent cannot choose, and the refusal names the box either
    way. **The socket is unaffected** — decision 47's peer messages never touch the input
    box, and whether a suggestion affects a message-started turn is still open there.

    *Addendum, 2026-09-12: the gate's own report, and the reason a refused one leaves behind.*
    The merge gate steers its report at a rejected session, and this decision gave it a second
    way to fail that its one reason did not describe. Live on 2026-09-12, session
    `t-mtycrep1`: the test stage failed, vitest had coloured its output, and the detail reached
    `formatGateReport` as 2000 characters of raw SGR. A pane shows an escape as what it does,
    never as the bytes that were sent, so `pasteLanded` could not match the paste, the steer
    was refused, and `runMergeGate`'s bare `catch` parked the session as
    `re-steer failed — session unreachable` — while its pane sat there alive with an empty box.
    Both halves were wrong: the report should not have carried escapes, and the reason sent
    the human to look for a window that was never gone.
    *Plain at the producer, not over the finished report.* `plainDetail` drops CSI sequences
    and sweeps the remaining control characters to spaces, keeping newlines — the scope audit
    puts a path on each — and the full `GATE_OUTPUT_TAIL_CHARS`, which is what makes it a
    sibling of decision 29's `sanitizeReason` rather than that function itself. It is applied
    in `commandFailureDetail`, where a gate command's output is captured, and the tail is cut
    after the strip so the cut cannot land mid-escape and leave its parameters as text. That
    site rather than `formatGateReport` because it covers every reader — the stored stages,
    the PR body, and the operator's own `printGateReport`, which prints details raw and lives
    in the CLI, outside this change's scope — and because it is the only route an escape
    takes into a stage that steers: git C-quotes a control byte in a pathname whatever
    `core.quotePath` says (checked, not assumed), `quotePath` already sanitizes the scope
    audit's, and an adapter's own text reaches flagged stages only, which are refused and
    never steered. A guard over the formatter would have been a branch no test could reach.
    *The refusal is its own reason.* `SteerNotDeliveredError` is caught apart from everything
    else and its message — the session, the character count, and which of the two refusals it
    was — is recorded as the blocked reason; every other throw keeps `session unreachable`.
    The two ask for different hands: a refused paste leaves a reachable session with an empty
    box and an agent still working from its last turn, a gone window leaves nothing to type
    into at all.
    *Verified by removal.* Three mutations, one named test each: dropping the strip leaves the
    steer carrying `\u001b`, collapsing the two arms into the message blocks an unreachable
    session with `no tmux session` as its reason, and collapsing them into the old string
    blocks a refused paste as `unreachable`.
    *What this leaves open.* **Nothing reads the reason back.** It is written to the
    `gate_result` event payload, which is where the old one went too, and no surface prints
    it: `pup status` shows `needs a human (N rejections)`, the review detail and the session
    dossier show neither. So the better reason is only reachable through the store until a CLI
    change surfaces it, and that is outside this change's scope. **`blocked` is a one-way
    door.** Nothing transitions a session back to `running` — `pup respawn` and
    `pup kill --respawn` both refuse anything that is not already running — so the operator's
    only move on a blocked session is `pup kill`, which returns its task to the backlog and
    throws away a context window that may be one steer from done. That was tolerable while
    blocked meant the reject cap or a dead window; a refused paste now parks a live session
    whose box is empty, which is exactly the case where typing the report in by hand and
    letting it run is the right answer. An `unblock` that re-steers and transitions
    `blocked -> running` — the state machine already allows the edge — deserves its own change.
    *Both are closed by decision 7's addendum (2026-09-12): `pup unblock` prints the reason it
    was parked for and lifts the parking. It steers nothing, for the reason recorded there.*
