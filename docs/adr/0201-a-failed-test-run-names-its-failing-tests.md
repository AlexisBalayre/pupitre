# 0201. A failed test run names its failing tests through the adapter, and keeps its whole output in the store (2026-11-18)

- Status: accepted
- Amends: [0094](0094-worker-windows-run-at-nice-10-workers-run.md)
- Amends: [0095](0095-the-gate-pup-audit-and-pup-land-run.md)

201. **A failed test run names its failing tests through the adapter, and keeps its whole output
    in the store (2026-11-18).**
    A failed test stage's detail, and the land's baseline test run, kept only the last
    `GATE_OUTPUT_TAIL_CHARS` of the child's output. On this repo that tail was a fixture's git
    noise (`fatal: no merge base found`, merge chatter), and named no test, so the operator and the
    session could not tell a flake from a broken suite without re-running it.
    *Named by the adapter.* `Adapter.failingTests(output)` reads the failed tests from the summary
    its own runner prints: vitest's `FAIL file > test` lines and whole-file `FAIL file [ file ]`
    entries, jest's per-file `FAIL` headers and the `●` test lines under them, and pytest's short
    test summary (`FAILED file::test`, `ERROR file`). Core never parses the free text: only the
    adapter knows its runner's format, and a regex in core would match whatever a fixture prints.
    The gate's detail leads with `failing: file > test; …`, at most 10 and a count of the rest.
    It names them for the first run and the re-run of decision 94 apart, and on a flaky pass
    names what failed the first time. An adapter without `failingTests` gets "none named — its
    adapter cannot read the runner's summary", and a summary that names none says so. The names
    are for people to read. Nothing in the gate acts on them, so a wrong name cannot pass or
    refuse anything.
    *Kept in the store.* The whole output, with each failed run under a `--- run N of M ---`
    header, is written to `<dir>/<stage>-output.log` through `writeStoreFile` (decision 194). The
    gate writes into the session's directory. `pup init`, `pup audit` and the land's audit
    (decision 95) write into the project's directory, `~/.pupitre/<projectId>`, which holds
    `state.db`. The path is printed in a failing gate's detail and in the timeout-under-load
    refusal. Both stay on the operator's machine. A flaky pass's detail names its failures but
    no path, because a passed report is the PR's body and is published on GitHub. The gate prints
    that path as a progress note in the operator's terminal instead. For the land it is printed at the end of the coverage gap, `the instrumented test run failed,
    so its coverage is not read; full output: <path>`, which is the land's line. Only directories
    pup already made are written into: a missing one says `full output not kept: no directory at
    <dir>` and is not created. The next failure of the same stage overwrites the file, so the
    store holds one file per stage, not one per run.
    *Rejected.* A larger tail. It still truncates, and a suite whose fixtures print more than the
    tail still names no test. A JSON reporter run alongside the suite. It adds a second report
    file per runner, the gate would have to grant write access to it, and runners differ in
    whether they keep printing their summary. Every runner pup adapts already prints a summary
    that names its failures.

## Amendment (2026-11-18, PR #392)

The land no longer prints the path at the end of the coverage gap. `pup init`, `pup audit` and
the land print it as a line of their own on the operator's terminal, `The baseline test run
failed; full output: <path>.`, never in the coverage gap's reason: `pup audit --sweep` puts its
findings in the sweep task's goal, and that goal is published in the sweep's PR body. The same
clause leads the failed test stage's detail, and the web dashboard's land shows that line among
its own, since the land's terminal there is the server's. The web dashboard's merge likewise
shows the gate's notes among its lines, so the flaky pass's path reaches the operator there too.
