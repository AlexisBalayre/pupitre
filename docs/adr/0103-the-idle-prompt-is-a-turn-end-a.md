# 0103. The idle prompt is a turn end, a turn ended on the session's own background shell reads `working on a background shell`, and workers commit and test in the foreground (2026-10-25)

- Status: accepted
- Amends: [0002](0002-all-session-state-comes-from-hooks-and-transcript.md), [0035](0035-a-running-session-is-stalled-by-events-file.md)

103. **The idle prompt is a turn end, a turn ended on the session's own background shell reads
    `working on a background shell`, and workers commit and test in the foreground
    (2026-10-25).**
    Amends decisions 2 and 35. `classifySessionActivity` read every Notification as
    awaiting-input. Claude Code sends one more a minute after a turn ends, `notification_type:
    "idle_prompt"` with the message `Claude is waiting for your input`, so a worker whose turn had
    simply ended printed `WAITING ON INPUT (Claude is waiting for your input)` on its `pup status`
    and `pup ui` row and carried `needsHuman`. The idle prompt now classifies like a Stop: idle.
    A `permission_prompt` and every other type, an untyped one included, still read as
    awaiting-input. An idle prompt with no Stop before it, as after a turn interrupted with
    Escape, also ends the turn.
    The hook log can tell a turn that ended on a background shell. A Bash call's PostToolUse
    carries `tool_response.backgroundTaskId` when the shell went to the background, whether
    `run_in_background` asked for it or a foreground call was moved there on its timeout (those
    also carry `timedOutAfterMs`), and a `TaskStop` names in `tool_input.task_id` the id it
    ended. Verified against live `~/.pupitre/*/sessions/*/events.jsonl`. A turn runs from the
    previous Stop or idle prompt to its own Stop. One that launched a shell it did not stop
    classifies as `background`, which `pup status`, `pup ui` and the web dashboard print as
    `working on a background shell`. It is not `needsHuman` and nothing in the needs-you inbox
    names it. A shell that exits re-invokes the session, and the turn that starts then ends with
    a Stop of its own, so the classification clears. The log has no event for the exit itself.
    Two cases are not told apart. A shell that exits while the turn that launched it is still
    going reads `background` after that turn ends, until the next one. A shell launched in an
    earlier turn and still running when a later turn ends reads idle. The stall rule (decision
    35) still wins over `background`, so a background shell quiet for ten minutes reads STALLED,
    as a wedge presenting as any other kind does.
    The cause is removed too. Measured 10-13..10-23, 25 of the conductor's 86 idle notices were
    workers waiting on a background pre-commit or suite. The worker protocol now says to run
    commits, the pre-commit hook they trigger and `pup session test` in the foreground, never with
    `run_in_background`, with a Bash `timeout` of up to 600000 ms so a long one is not moved
    to the background, and never to end a turn while a background job of its own is still
    running. The conductor had been adding a "finish your protocol" / "commit in the foreground"
    note to every launch and steer, and nudging turns that ended on a background job. Its
    `## Sessions` section now says every session carries that rule, not to repeat it, and that a
    session showing `working on a background shell` is not idle: subscribe again and wait for its
    next notice.
    *Tests.* In `session-activity.test.ts`: an idle prompt after a Stop, and one with no Stop,
    classify idle; a permission prompt, an elicitation and an untyped Notification stay
    awaiting-input; a turn that launched a background shell, or had one moved there on its
    timeout, reads `background`, also when interrupted; a `TaskStop` of that id clears it, one
    of another id does not; a later turn's Stop, with tools or without, clears it; a launch in a
    turn still going reads working. In `dashboard.test.ts`, the idle prompt is not `needsHuman`,
    and a background-shell session is neither `needsHuman` nor in `needsYou`. `activityLabel` and
    the web dashboard print `working on a background shell`. In `profile-compiler.test.ts` the
    worker context carries the foreground rule. In `conductor.test.ts` the kickoff carries no
    finish-protocol note and carries the wait-out rule.
