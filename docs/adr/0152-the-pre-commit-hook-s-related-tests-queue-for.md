# 0152. The pre-commit hook's related tests queue for a test slot inside a session (2026-11-08)

- Status: accepted
- Amends: [0096](0096-test-runs-queue-for-a-few-machine-wide.md)

152. **The pre-commit hook's related tests queue for a test slot inside a session (2026-11-08).**
    Amends decision 96, whose slots the hook bypassed: `scripts/pre-commit` ran `vitest related`
    directly, so every worker committing started its own vitest pool outside the 2 slots. On
    2026-11-08 five commits ran at once (29 vitest processes), the load stayed at 65 to 100 on 8
    cores, the hook timed out unrelated tests and the merge gate's test stage ran over an hour.
    *Inside a session* (`PUP_SESSION_ID` set) the hook lists the related test files with `vitest
    related --listTests`, which runs no test, then runs them with `pup session test <files>`
    (`node "$PUP_BIN"` when `pup` is not on the path). The run says whom it waits for, and
    waits while a merge gate holds a slot or queues ahead. No related test file means no run.
    *Outside a session* the hook runs `vitest related --run` directly, as before.
    *Ceiling.* The test files go to the project's test command as names, so a file whose path
    contains another's runs too.
