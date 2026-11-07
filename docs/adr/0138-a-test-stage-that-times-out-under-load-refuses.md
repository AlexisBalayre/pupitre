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
    *Staleness under the longer cap.* Nothing takes a live holder as stale by age. A test slot
    is reclaimed only when its holder's pid is dead, and so is the merge lock. A lock with no
    pid written is refused after a one-second grace and never reclaimed. The only age check on
    the lock is `RECLAIM_STALE_MS` (10 s), and it covers the reclaim marker a reclaiming run
    leaves, not the lock. So a live gate holding either for 25 minutes, or for the whole 125, is
    never reclaimed. The one age window is a gate's slot-wait file. Readers count it for
    `GATE_SLOT_WAIT_MS` and the wait that writes it is bounded by the same constant, so the
    two grow together. The wait checks its deadline once a poll (1 s), and the file can outlive
    the window by up to that poll before it is removed. That margin is unchanged by this
    decision.
    *The rule.* A test run, the root suite or a nested package's, that runs out
    `GATE_COMMAND_TIMEOUT_MS` counts as timed out under load only on evidence that the load is
    not the session's own. All three must hold, at the ceiling decision 88's wait uses,
    `availableParallelism()`. First, the 1-minute load average was at or over it before the
    suites started: it is read once, after the load wait and before the slot and the stages
    that run alongside the suites. Second, it is still at or over it when the timed-out run
    ends. Third, at that moment another process holds a test slot or waits for one as a gate
    (`testRunsElsewhere`, decision 134). Such a timeout refuses the merge with `The test stage
    timed out under load N, at or over the machine's C cores, with other test runs going;
    nothing was merged; run pup merge again when the load falls.` The refusal is thrown, as
    the gate's other refusals under the lock are. It climbs no rung of the reject cap, injects
    nothing into the session, records no gate result, and merges and pushes nothing, and with
    `--pr` writes nothing to GitHub. The session stays `awaiting-review`, the merge lock and the
    gate's test slot are released, and `pup merge` exits non-zero with that line.
    *What stays a rejection.* Every other timeout. A timeout at a load under the cores, which is
    a hung or slow suite the branch can answer for. A timeout on a machine that was quiet before
    the suites and loaded only while they ran. And a timeout with no other test run going, the
    load then being none of pup's tests (decision 134's reading). And every real test failure,
    at any load: a failing runner's exit gets its one re-run (decision 94) and then rejects, as
    before. Build, lint and typecheck timeouts are not test runs and keep rejecting.
    *Ceilings.* The evidence is bounded, not proof. The rule shuts the path a security review
    of this decision found: a session whose own tests fill the cores until the cap (busy loops,
    or a sleep while its pane keeps the CPU busy) would otherwise be refused on every `pup merge`,
    never rejected and never blocked, holding the merge lock for its build and test caps each
    time. Such a suite is now rejected unless another run is testing and the machine was loaded
    before it. A session can still load the machine from its pane before the gate starts, and so
    meet the first condition. The third is out of its reach unless another session or gate is
    testing at the same moment. A real overload with no other pup test run going, such as
    decision 134's scanner, still rejects on a timeout. With the cap at 25 minutes and the suite
    at about 9.5, that should be rare. Nothing bounds how many times the operator can re-run a
    refused merge, which is the point: the machine is what has to change, not the session. A
    hung suite waiting on nothing is rejected, now after 25 minutes rather than 10.
    Tests: the gate's slots live under a home of the test's own, with the other run's slot
    planted or not. A test stage that traps its timeout's SIGTERM, at a load half a core under
    the cores, is still rejected without a re-run, steered and counted. Loaded at the cores
    before and during the run, with another run holding a slot, it throws the refusal. It then
    steers nothing, leaves the reject count at 0, the session `awaiting-review`, `main` where it
    was and the worktree in place. It frees the gate's slot, leaving only the other run's, and
    releases the merge lock, so a second `pup merge` merges. With `--pr` the same refusal
    pushes no branch and makes no `gh pr create`, `edit` or `comment` call. Three timeouts
    are still rejected, steered and counted:
    - quiet before the run and loaded only by it, with no other run;
    - the same with another run going;
    - loaded before and during the run, with no other run.

    A runner's failing exit at four times the cores is re-run once, then rejected. No test
    pinned the 10 minutes: the timeout tests shorten the cap through a mock, and the wait tests
    read `GATE_SLOT_WAIT_MS`.
