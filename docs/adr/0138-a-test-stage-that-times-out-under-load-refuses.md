# 0138. The gate's command cap is 25 minutes, and a test stage that times out under load refuses the merge rather than reject the session (2026-11-07, amends 7, 95 and 96)

- Status: accepted
- Amends: [0007](0007-rejection-re-steer-is-capped-at-2.md), [0095](0095-the-gate-pup-audit-and-pup-land-run.md), [0096](0096-test-runs-queue-for-a-few-machine-wide.md)

138. **The gate's command cap is 25 minutes, and a test stage that times out under load refuses
    the merge rather than reject the session (2026-11-07, amends 7, 95 and 96).**
    The gate killed every stage child at `GATE_COMMAND_TIMEOUT_MS`, which was 10 minutes. Pup's own
    full suite takes about 9.5 minutes even at a load of 14, and longer at the loads of 25 to 50
    this machine reaches with several workers testing. So the gate reported a test FAIL,
    injected the report into the worker and spent one of the two rejections decision 7 allows,
    on code that was fine: six times on 2026-11-07 alone. One of them was t-mw4pvd2a-1's one-line
    workflow change, rejected after the gate had already waited 600 s for the load (decisions 88
    and 134). A worker cannot fix a timeout the machine caused, so a report telling it to fix the
    failures sends it after nothing and brings the session one step nearer to `blocked`.
    *The cap.* `GATE_COMMAND_TIMEOUT_MS` is 25 minutes (operator decision, 2026-11-07). The same
    constant caps every command that uses it: each gate stage, a coverage-folded test run
    included (decision 95's "the coverage run's 10 minutes too" no longer holds for the folded
    run; the adapter's standalone coverage run keeps its own 10 minutes), `pup init`'s baseline
    stages, `pup land`'s commands and the git tree reads. What derives from it follows:
    `GATE_SLOT_WAIT_MS` is that cap, so the gate's slot wait (decision 96), its load wait
    (decisions 88 and 134) and the age past which a gate wait file is ignored are now 25 minutes
    each. A run that holds a slot for one stage's cap is still the longest a live run may hold
    it. `MERGE_LOCK_WAIT_MS` keeps its formula, three caps and two waits, and so is now 125
    minutes: still what a gate with one suite can hold the lock for.
    *The rule.* A test run, the root suite or a nested package's, that runs out
    `GATE_COMMAND_TIMEOUT_MS` while the 1-minute load average is at or over
    `availableParallelism()` refuses the merge with `The test stage timed out under load N, at
    or over the machine's C cores; nothing was merged; run pup merge again when the load
    falls.` That is the same ceiling decision 88's wait uses. The refusal is thrown, as the
    gate's other refusals under the lock are. It climbs no rung of the reject cap, injects
    nothing into the session, records no gate result, and merges and pushes nothing. The session
    stays `awaiting-review`, and `pup merge` exits non-zero with that line. The load is read when
    the timed-out run ends, which is as close to the timeout as the gate can read it.
    *What stays a rejection.* A timeout at a load under the cores, which is a hung or slow suite
    the branch can answer for. And every real test failure, at any load: a failing runner's exit
    gets its one re-run (decision 94) and then rejects, as before. Build, lint and typecheck
    timeouts are not test runs and keep rejecting.
    *Ceilings.* The suite's own workers count in the load it is read under, so a suite busy
    enough to fill the cores until its cap is refused rather than rejected, even on an
    otherwise quiet machine. It is still not merged, and the operator sees the load in the line.
    A hung suite waiting on nothing adds no load and is still rejected, now after 25 minutes
    rather than 10. Nothing bounds how many times the operator can re-run a refused merge, which
    is the point: the machine is what has to change, not the session.
    Tests: a test stage that traps its timeout's SIGTERM, at a load half a core under the cores,
    is still rejected without a re-run, steered and counted. At a load equal to the cores it
    throws the refusal, steers nothing, leaves the reject count at 0, the session
    `awaiting-review`, `main` where it was and the worktree in place. A runner's failing exit at
    four times the cores is re-run once, then rejected, steered and counted. No test pinned the
    10 minutes: the timeout tests shorten the cap through a mock, and the wait tests read
    `GATE_SLOT_WAIT_MS`.
