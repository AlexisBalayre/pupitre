# 0076. A blocked worker asks with `pup session ask "<question>"`, and a steer answers it (2026-10-06, amends decision 74)

- Status: accepted
- Amends: [0074](0074-a-worker-is-kept-off-the-screens-pup.md)

76. **A blocked worker asks with `pup session ask "<question>"`, and a steer answers it
    (2026-10-06, amends decision 74).** From the Copiste grilling. Decision 74 took away the
    selector and told a blocked worker to write its question as plain text and end its turn, but
    nothing parses a pane's text (decision 2), so the question reached nobody until someone
    attached. `pup session ask <question>` sits beside `pup session done` and is guarded the same
    way by `ownSession`: refused without `PUP_SESSION_ID`, and refused from outside that session's
    own worktree. It appends a `question` event `{text}` through `markSessionQuestion` and leaves
    the session `running`, because asking is not finishing; the worker then ends its turn. The
    dashboard snapshot derives the open question from the store the way it derives a stall: the
    newest `question` event, unless a `steer` event came after it. Any steer counts as the answer,
    whoever sent it and however it was delivered, because the steer is what reaches the worker.
    The text is the session's own words, so it is scrubbed and cut by `sanitizeReason` (decision
    29) before it reaches `pup status`, which prints `question: <text>` at the end of the session
    line, the TUI detail pane, which shows it in a section of its own, or the command's own echo.
    Under "last events" the `question` event reads as its text. The protocol line now names the
    command: run `pup session ask "<question>"` and end your turn; a steer answers it. Decision
    74's deny list is unchanged.
    *Not changed here:* an open question does not set `needsHuman` or sort the row first, and the
    fleet view's rows (`sessionLine` in `dashboard-text.utils.ts`, out of this task's scope) do
    not carry it yet, so a question is seen from `pup status` in the project or from `pup ui`.
