# 0094. Worker windows run at nice 10, workers run related tests only, and the gate re-runs a failed test stage once (2026-10-16)

- Status: accepted

94. **Worker windows run at nice 10, workers run related tests only, and the gate re-runs a failed
    test stage once (2026-10-16).**
    Two workers drove an 8-core Mac to load 15, and a gate's test stage, run while a worker's suite
    ran, timed out on untouched timing-sensitive tests: a rejection, and two park the task as
    blocked. Three changes let four sessions share the machine. Every worker's window starts
    `claude` as `nice -n 10 claude …`, `nice` resolved on pup's PATH as `claude` is, so every test,
    build and tool the window spawns inherits the niceness and yields the CPU to the gate. The
    conductor's window is not niced: the gate runs inside the `pup merge --pr` the conductor starts,
    and would inherit its niceness, so its stages run at normal priority as the operator's do. The
    session protocol tells workers to run only the tests related to what they changed — the
    runner's related-tests form when it has one (`vitest related <files>`), else the test files by
    name — and to leave the full suite to the gate, which runs it. And a failed test stage, root or
    a nested package's, runs once more under the same lock before it counts: a pass on the re-run
    passes the stage, its detail naming it flaky with the tests that failed the first time; a
    second failure rejects as before, its detail naming both runs' failing tests ahead of the
    re-run's output tail. Only the failing-tests exit is re-run, status 1 for vitest, jest, pytest
    and `go test` alike: a child a signal killed (an operator's Ctrl-C reaches it, and a passing
    re-run would turn the abort into a merge), a runner that caught the interrupt (130, pytest's
    2), a wrapper reporting a killed child (129, 143), and a stage that ran out its timeout (whose
    re-run would hold the merge lock twice as long on a hung suite) each fail at once. A runner
    whose failing-tests status is not 1 (cargo's 101) loses the re-run, which fails safe; one that
    traps the interrupt and exits 1 cannot be told from a flake, and a second Ctrl-C ends its
    re-run. Build and lint are deterministic and never re-run. Failing tests are
    named from the lines common runners open a failure with (vitest's `FAIL` and `×`, jest's `✕`
    and `●`, pytest's `FAILED`, go's `--- FAIL:`), at most ten, for the operator to read. The
    `index.test.ts` symlink entry-point test, which spawns a whole `pup`, takes a 20 s timeout as
    decision 46's kickoff test does.
    Tests: the session's tmux argv carries `nice -n 10` before the resolved `claude`, and the
    conductor's carries no `nice`; the gate's test spawn carries no `nice`; a test stage killed by
    SIGINT, one exiting 130, one exiting 2 and one timed out each run once and reject; the compiled
    context carries the related-tests line; with a fake adapter a test stage failing once then
    passing merges, run twice, marked flaky with the failing name; one failing twice rejects naming
    both runs' failures; a failing build and a failing lint each run once.
