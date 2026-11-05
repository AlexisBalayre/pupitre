# 0132. The pre-commit hook runs only the tests related to the staged files (2026-11-05)

- Status: accepted

132. **The pre-commit hook runs only the tests related to the staged files (2026-11-05).**
    `scripts/pre-commit` ran `TEST_CMD`, the full suite, on every commit. On a loaded machine
    the slow files (`fix-round.test.ts`, `land.test.ts`, `merge-gate.test.ts`) hit their 30-second
    per-test timeouts, so commits failed for reasons unrelated to the change, and workers
    stalled on the hook for hours. A commit inside a session also runs outside the machine's
    test slots (decision 96), so the full suite there competed with every other session's run.
    *What the hook runs.* Lint, now on every staged file whatever its extension: biome's own
    `files.includes` decides what it checks, and `LINT_CMD`'s `--no-errors-on-unmatched` passes
    the rest. A docs-only commit therefore still runs lint (on nothing biome checks) and
    typecheck, as before. Typecheck is unchanged. Tests run as `pnpm exec vitest related --run
    --passWithNoTests` on the staged files that match `SOURCE_EXTENSIONS`, each prefixed `./`
    like lint's. That runs each staged test file and every test file that reaches a staged
    source file through its static imports, directly or through others, so a staged change is
    still tested by the files that import it. A commit with no staged source file runs no
    vitest at all, and neither does any commit when `TEST_CMD` is empty: the key still turns
    tests on, though the hook no longer runs its command.
    *The merge gate keeps the full suite.* Its test stage is the adapter's (`pnpm run test`, or
    the coverage run of the same suite, decision 95), resolved from the trusted checkout's
    manifest, and never reads this hook. That full run backs up what the hook now skips.
    *Ceilings.* `vitest related` follows only the static import graph. A test that reaches
    code only through a child process (the CLI or a script it spawns, as `pre-commit.test.ts`
    runs this hook), through a computed dynamic import, or by reading a fixture from disk is
    not selected for that code. Nor is any test selected for a change to `vitest.config.ts`,
    `package.json`, the lockfile or a shell script. Each of those commits with fewer tests than
    before, and fails at the merge gate if it broke the suite. The hook is installed by copying
    it into `.git/hooks/pre-commit`, so the change reaches a checkout only when the operator
    copies it again. Not taken: a `project.env` key for the related-test command. That file
    comes from the `.claude/` template, and this command has one consumer. Also not taken:
    falling back to the full suite when a config file is staged, which would bring back the
    stall for every dependency bump the gate already covers.
    *Tests* (`pre-commit.test.ts`). The hook runs in a temp repo whose `pnpm` is a stub that
    logs its arguments. A staged source file runs lint, typecheck and `vitest related` on that
    file, and never `pnpm test`. Staged source and test files are all passed to `vitest
    related`, and a staged doc is not. A docs-only commit runs lint and typecheck and no
    vitest. A failing related run blocks the commit, and an empty `TEST_CMD` runs no tests.
