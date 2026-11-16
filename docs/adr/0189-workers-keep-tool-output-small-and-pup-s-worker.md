# 0189. Workers keep tool output small, and pup's worker commands print one line on success (2026-11-16)

- Status: accepted

189. **Workers keep tool output small, and pup's worker commands print one line on success (2026-11-16).**
    *The baseline.* The `pup retro` of decision 150 run on 2026-11-14 over 7 days counted 10,477
    Bash results under 1k tokens and 885 of 1k-5k tokens in worker sessions. Every result stays in
    the transcript and is re-read from the prompt cache on each later request, so many small results
    cost more than their size suggests. This was the retro's largest finding. The next retro compares
    against these two counts.
    *The rule.* The session protocol in the compiled worker context gains one line: keep tool output
    small, since every result is re-read on each later request. It names three habits: batch related
    commands into one Bash call, ask for quiet output (`--quiet`, `-q`, or `tail` or `grep` on test
    and install runs), and do not re-run a command to re-read output already in context. It is one
    line because the context budget (decisions 71 and 128) bounds how far the compiled context may
    grow. Every line added to it is paid for on every request of every worker.
    *The commands.* `pup session done` prints `Session <id> marked done.` and no longer echoes the
    summary. `pup session ask` prints `Session <id> question recorded; end your turn, a steer answers
    it.` and no longer echoes the question and its options. In both cases the worker wrote that text
    itself one call earlier. The operator still sees the question and its options in `pup status`
    (decision 93). A refusal still prints its full detail on stderr with exit status 1.
    *Not changed.* `pup session test` still streams the test run to the terminal. It inherits the
    child's stdio so that the waits, interrupts and exit status of decision 140 reach the worker
    unchanged. The rule above asks the worker to filter that output with `tail` or `grep`.
    Capturing it and printing it only on failure would be a separate decision.
