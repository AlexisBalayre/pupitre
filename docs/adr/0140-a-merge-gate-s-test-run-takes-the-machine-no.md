# 0140. A merge gate's test run takes the machine: no session takes a test slot while a gate holds one (2026-11-07)

- Status: accepted
- Amends: [0096](0096-test-runs-queue-for-a-few-machine-wide.md)

140. **A merge gate's test run takes the machine: no session takes a test slot while a gate
    holds one (2026-11-07).**
    Amends decision 96. The machine has 2 test slots, and decision 96 served the gate first only
    while it waited: a gate's wait file held every worker back, but once the gate held one slot a
    session's `pup session test` took the other. With up to 6 workers testing and committing, the
    gate's full suite ran past its 10-minute stage cap at a load of 30 to 50 (2026-11-07). The
    gate's suite is the one that decides a merge and runs under the merge lock, so it is the run
    that must finish.
    So a worker now takes a free slot only when no live gate waits for one and no live gate holds
    one (`withTestSlot`). It waits, polling each second as before, and starts once the gate's run
    ends and frees its slot. A gate is not held back by anything new: it still takes a free slot
    beside a session's run already going, which is not stopped, and beside another project's
    gate. Only a slot's holder decides this, read the way every slot is, so a dead gate's slot is
    reclaimed and holds no worker back. A run with `PUP_TEST_SLOT` set still takes no slot, so a
    gate run inside a session's test run is unaffected.
    The wait line names the gate first, since it is what the worker waits for whatever else is
    free: `Waiting for the merge gate for t-2 (pid 4343) to end its test run, beside session t-1
    (pid 4242).` With no gate holding a slot the line is decision 96's. A run was told once; a
    worker is now told again whenever the gates it waits for, holding or queued, change to others,
    so one that began waiting on two sessions learns when a gate is what keeps it.
    The commit-time suite does not go through the slots. A worker's `git commit` runs the
    `pre-commit` hook installed from `scripts/pre-commit`, which runs `TEST_CMD` from the main
    checkout's `.claude/project.env`, `pnpm test`, the full Vitest suite, with `bash -c`. The
    session's test guard reads only the Bash tool's command, `git commit ...`, so it neither
    refuses nor queues that run: every worker commit runs the full suite unqueued, beside the
    gate's, and adds to the load measured above. It is not routed here: the
    hook lives in `scripts/pre-commit`, outside this change, is installed per clone by copying,
    and runs for human commits where no pup session or slot exists. Routing it, or narrowing a
    session's commit-time suite to what the gate does not already run, is a follow-up; until then
    this rule protects the gate from `pup session test` runs only.
    Ceilings: a gate's slot now keeps every worker's test run waiting, not one of two, so a gate
    run that hangs, or a live process holding a slot forged as a gate's, stalls sessions' tests
    until it ends; a gate's run is bounded by its stages' timeouts, and a forged slot is decision
    96's ceiling already. The rule is fairness among cooperating sessions, as decision 96's
    priority is, not a boundary.
    Tests: a worker waits while a gate holds one slot and the other is free, and starts when the
    gate ends; a worker waiting beside a gate and a session prints the gate's line and stays
    waiting after the session's slot frees; a gate takes a free slot beside a worker's run; a
    worker that began waiting on two sessions is told again when a gate queues ahead of it; a
    gate served before longer-waiting workers now keeps both of them out until its run ends. The
    session protocol and the conductor's context say a session's run waits while a gate runs its
    tests.
