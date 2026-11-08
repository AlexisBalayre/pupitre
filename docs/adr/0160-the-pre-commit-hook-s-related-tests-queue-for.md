# 0160. The pre-commit hook's related tests queue for a test slot inside a session (2026-11-08)

- Status: accepted
- Amends: [0096](0096-test-runs-queue-for-a-few-machine-wide.md)

160. **The pre-commit hook's related tests queue for a test slot inside a session (2026-11-08).**
    Amends decision 96, whose slots the hook bypassed: `scripts/pre-commit` ran `vitest related`
    directly, so every worker committing started its own vitest pool outside the 2 slots. On
    2026-11-08 five commits ran at once (29 vitest processes), the load stayed at 65 to 100 on 8
    cores, the hook timed out unrelated tests and the merge gate's test stage ran over an hour.
    *Inside a session* (`PUP_SESSION_ID` set) the hook lists the test files with `vitest list
    --filesOnly --changed`, which runs no test, then runs them with `pup session test -- <files>`.
    `vitest related` has no list form (vitest 4 rejects `--listTests` and `--related`), so the
    listing names the tests that import any file changed in the working tree, staged or not: a
    superset of the staged files' tests. *Accepted:* vitest's default `forceRerunTriggers`
    (`package.json`, `vitest.config.*`, `vite.config.*`) makes `--changed` list every test once
    one of those files is modified in the working tree, staged, unstaged or untracked, so such a
    commit runs the whole suite through one slot, where outside a session it runs the staged
    files' tests only. That keeps the slot's queue and the gate's priority intact, and changing
    `vitest.config.ts` to cut it is outside this decision; commit a dependency or script change
    on its own, or revert the trigger file in the worktree, to avoid it. The run says whom it waits for, and waits while a merge
    gate holds a slot or queues ahead.
    *Fails closed.* The hook uses `node -- "$PUP_BIN"` when that is an existing file, else the
    `pup` on the PATH once `pup session --help` answers as pupitre does (Homebrew ships an
    unrelated `pup`, an HTML parser, that exits 0 on `session test`), else blocks the commit. A listing that exits non-zero blocks it too; only a
    clean listing with no file runs nothing, as vitest reports no related test.
    *Outside a session* the hook runs `vitest related --run` directly, as before.
    *Ceiling.* The test files go to the project's test command as names, so a file whose path
    contains another's runs too.
