# 0160. The pre-commit hook's related tests queue for a test slot inside a session (2026-11-08)

- Status: accepted
- Amends: [0096](0096-test-runs-queue-for-a-few-machine-wide.md)

160. **The pre-commit hook's related tests queue for a test slot inside a session (2026-11-08).**
    Amends decision 96, whose slots the hook bypassed: `scripts/pre-commit` ran `vitest related`
    directly, so every worker committing started its own vitest pool outside the 2 slots. On
    2026-11-08 five commits ran at once (29 vitest processes), the load stayed at 65 to 100 on 8
    cores, the hook timed out unrelated tests and the merge gate's test stage ran over an hour.
    *Inside a session* (`PUP_SESSION_ID` set) the hook runs `pup session test --related --
    <staged source files>`. `--related`, among the options before the files, swaps the project's test command for
    the very `pnpm exec vitest related --run --passWithNoTests` the hook runs outside a session,
    without `--related` or the `--` the CLI keeps after it (vitest files what follows a `--` under
    `options['--']`, so `related` would see no file and pass having run nothing),
    so both paths test the same set: the tests that import a staged source file. The run holds a
    slot, says whom it waits for, and waits while a merge gate holds a slot or queues ahead.
    *Why not list first.* A listing by `vitest list --filesOnly --changed` was tried and dropped:
    vitest runs every test when a changed file matches its `forceRerunTriggers` (`package.json`,
    the vitest and vite config), so a commit with an unstaged `package.json` ran the whole suite
    in one slot, and vitest 4 has neither a `--forceRerunTriggers` nor a `--related` option for
    `list`.
    *Fails closed.* The hook uses `node -- "$PUP_BIN"` when that is an existing file, else the
    `pup` on the PATH once `pup session --help` answers as pupitre does (Homebrew ships an
    unrelated `pup`, an HTML parser, that exits 0 on `session test`), else blocks the commit.
    *Outside a session* the hook runs `vitest related --run` directly, as before.
    *Ceiling.* `--related` is vitest's alone: it runs `pnpm exec vitest related`, whatever the
    project's adapter declares as its test command.
