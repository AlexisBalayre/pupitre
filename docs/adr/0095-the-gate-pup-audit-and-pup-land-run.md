# 0095. The gate, `pup audit` and `pup land` run the suite once with coverage on, run the read-only stages alongside it and print each stage's time, and an interrupt reaches every stage child (2026-10-17)

- Status: accepted
- Amended by: [0088](0088-the-merge-lock-records-its-holder-survives-every.md)

95. **The gate, `pup audit` and `pup land` run the suite once with coverage on, run the read-only
    stages alongside it and print each stage's time, and an interrupt reaches every stage child
    (2026-10-17).**
    On a TypeScript repo with vitest coverage the gate ran the suite twice under the merge lock,
    once for the test stage and once more for the coverage figure, and ran every stage one after
    another; the audit did the same. Nothing is measured less, and no threshold moves.
    One run. An adapter may declare `coveredTest(ctx)`: the run `coverage` makes, as a command, the
    writable paths its report needs, `report()` and `dispose()`. The test stage runs it instead of
    the plain test command when the adapter that measures coverage, the first that declares it
    (decision 72), is the one whose test command the stages run (decision 22). Its exit status
    decides the test stage, with decision 94's one re-run, and the coverage stage reads that
    run's report; a failing run fails the test stage, so the gate stops there as before, and in
    `pup init`, `pup audit` and `pup land` coverage is a gap, "the instrumented test run failed,
    so its coverage is not read". The TypeScript adapter declares it only when, in the trusted
    checkout and the measured one alike, the `test` script is exactly `vitest` or `vitest run`,
    with no `pretest` or `posttest`, and no vitest or vite config at the root mentions
    `thresholds`, read only as regular files; and only when the measured checkout has
    `node_modules/.bin/vitest`, which the folded `npx --no-install` launch needs and a
    Plug'n'Play install lacks. Anything else would make
    the instrumented run a different run from the one the script makes, or fail a run whose every
    test passed on a coverage figure, and keeps today's two runs. The run is the one `coverage`
    always made: the provider pinned from the trusted manifest, every source file included, the
    report written to a `pup-coverage-*` directory outside the checkout, granted to the sandbox
    and removed after, under the stage timeout, which is the coverage run's 10 minutes too.
    Ceiling: a threshold set in a file a config imports is not seen, and fails the test stage
    with vitest's own threshold message.
    Concurrency. Build runs first and alone, since every other stage reads what it built. Then
    the test run (the root's, then each touched nested package's in turn, stopping at a
    failure), lint, each nested package's typecheck, dead code and duplication
    (`measureStaticDebt`) and both sides of complexity all start together, each command in its own
    sandboxed child with the same environment allowlist as before. Each child's profile is
    written to a directory of its own under the run's policy directory: one shared file was
    rewritten for the next child before `sandbox-exec` read the previous one's, so a child ran
    under another's grants, which is how the folded test run first lost its report directory to
    lint's profile, and how session code could have taken the grants of a child working in the
    trusted checkout. Every one settles before any result is read, so none outlives the
    checkout; an interrupt is the outcome whatever else failed; and the report keeps today's order
    and stops where today's run stopped, so a failing test still hides lint's result. A capability's own error still surfaces at the debt stages. A
    coverage run that was not folded still runs after them (`measureCoverage`), never alongside a
    suite. `pup init`, `pup audit` and `pup land` (`measureBaseline`) run build, then the test run,
    lint and the static debt together, then any unfolded coverage. The TypeScript adapter's
    dead-code, duplication and complexity run inside pup's own process, so while one runs, the
    children keep running and their output waits in its pipe.
    Times. Every gate stage that ran something carries `durationMs`: the hard stages (a re-run
    counted in), pup's own git checks, and each debt capability, which `measureStaticDebt` and
    `measureCoverage` time and `judgeDebt` puts on its stage, complexity timed until both sides
    settle. A coverage figure folded into the test run shows next to no time, since its run is
    the test stage's and counted there. A stage that ran nothing, such as one an adapter cannot
    measure, has no time. The time prints beside the status on the terminal and as `(12.3s)` in
    the report the PR body and the re-steer carry; `pup init` and `pup audit` print their stages'
    times the same way. Stages overlap, so the times do not add up to the gate's. The stored
    report `pup review` prints has none, since its decoder reads stage, status and detail only.
    Interrupts. Every stage child is spawned asynchronously in a process group of its own, with
    `execFileSync`'s output cap (ENOBUFS) and timeout (ETIMEDOUT, a SIGTERM to the group) kept.
    While any child runs, pup listens for SIGINT, SIGTERM and SIGHUP and forwards each to every
    running child's group. A group still alive 5 s later is sent SIGKILL, because a
    non-interactive `sh` leaves its background jobs ignoring SIGINT. The run then rejects with
    `GateInterruptedError`, which no stage catches and decision 94 never re-runs. The merge lock
    and the gate checkout are released on the way out, the session stays where it was, and the
    CLI exits 128 plus the signal's number (130 for Ctrl-C). `depGraph`, which `pup map` reads
    synchronously, keeps a synchronous spawn with the same sandbox and environment. Ceiling: a
    signal that arrives while no stage child runs, during pup's own git work between stages, is
    held by the merge lock's listener (decision 84) and not acted on; git children share pup's
    group, so the terminal's Ctrl-C reaches them directly.
    Cleanup. The gate's scratch TMPDIR, its checkout and the adapters' report directories are
    removed with three retries. A removal that still fails, such as ENOTEMPTY from a child that
    wrote while being stopped, prints `Could not remove <path> (<code>); it is left behind.` on
    stderr and never throws over the stage results.
    Measured: `measureBranch` on a clone of this repo at fad06ed with a two-line source change,
    main's code against this branch's, one after the other, while other sessions kept the host's
    load average between 9 and 45. Main took 599.6 s and 571.2 s; the branch took 275.4 s and
    302.3 s, each with decision 94's re-run of a flaky test, and 313.7 s on one run (test stage
    307.2 s, build 5.8 s, lint 0.6 s, every debt capability under 0.4 s). That is 46 to 53% less
    than main's 585 s mean. Main's third run hung in its coverage run, whose 10-minute timeout
    ended nothing, and was stopped after 85 minutes and not counted. The second branch run is how
    the shared profile file above was found.
    Tests: a fake vitest on a TypeScript repo runs once for both stages, with the coverage figure
    from that run; a script with flags runs twice; a failing instrumented run is re-run once,
    fails the test stage and reads no coverage. In init, a folded run calls no `coverage`, a
    failing one fails the test stage and records the gap, and a test command that is another
    adapter's is not folded. Six sandboxed children started together each write into the
    directory granted to it, which fails on the shared profile file. `coveredTest` folds `vitest`
    and `vitest run` and declines flags, another runner, a pre or post script, a missing provider
    and a thresholds config (the last proven by removing the check). In the gate and in init, a test stage that passes only if lint
    and every debt capability ran while it was running passes, and the stages keep their order.
    Every stage that ran something carries a time and coverage-without-a-capability none; the
    re-steer prints `- build: FAIL (0.2s) — …`; the CLI prints times on the gate's, init's and the
    audit's stage lines, and `measureStaticDebt`, `measureCoverage` and `judgeDebt` place each
    time. A gate interrupted while a stage child sleeps rejects within seconds with that child gone,
    the lock and checkout removed and the session awaiting review; a forwarded SIGTERM ends a
    grandchild, a child that ignores the signal is killed after the grace (proven by removing the
    escalation), and `pup` exits 129 on SIGHUP. An ENOTEMPTY on the gate checkout prints the
    warning and leaves the build failure as the result.
