# 0134. The gate waits for the load only while another test run is going (2026-11-06, amends 88)

- Status: accepted
- Amends: [0088](0088-the-merge-lock-records-its-holder-survives-every.md)

134. **The gate waits for the load only while another test run is going (2026-11-06, amends
    88).**
    Decision 88 made a gate asked to wait (`pup merge`, `pup land`) hold off its tests until
    the 1-minute load average fell under `availableParallelism()`, for up to
    `GATE_SLOT_WAIT_MS` (10 minutes). That assumes the load above the core count is pup's
    own: workers' test runs saturating the machine. On a machine whose idle load already sits
    above the core count, it is not. Here an endpoint-security scanner and a file-sync daemon
    keep the load near 20 on 8 cores. Every gate waited the full 10 minutes under the merge
    lock and then ran its tests anyway (task t-mw5aflcx). The wait cannot outlast load pup did
    not cause, and the test slots (decision 96) already bound how many test runs share the
    machine.
    *The rule.* `waitForLoad` waits only while the load is at or above the ceiling *and*
    another process holds a test slot or has a live gate wait file
    (`testRunsElsewhere` in `test-slot.service.ts`). With neither, the gate runs its tests at
    once and prints nothing. A wait already going re-checks both every 5 s. It ends when the
    load falls or when the other runs end, whichever comes first, and is still bounded by
    `GATE_SLOT_WAIT_MS`, after which the tests run anyway, as before. The line that starts the
    wait now says that other test runs are going.
    *What counts as another run.* A slot whose holder is a live process other than the gate's
    own, and a gate wait file younger than `GATE_SLOT_WAIT_MS` whose pid is alive. These are
    the same liveness rules `acquire` applies, so a dead holder's slot is reclaimed and a dead
    gate's wait file removed, as every reader of the slots does. Only a slots path where
    `lstat` finds nothing, not yet made, holds no run. Anything else that cannot be read counts
    as a run, so the gate keeps decision 88's bounded wait rather than skip it on an error: a
    file planted where the directory goes, and a dangling link, whose read fails with the same
    ENOENT a missing directory gives (security review of a4545ff).
    *Ceilings.* Another project's gate waiting on the load, not yet on a slot, leaves no file,
    so two such gates can both skip the wait and run at once. The slots still serialise them
    past `TEST_SLOTS`, the bound decision 96 relies on: the later one gets the slot wait instead
    of the load wait. A worker waiting for a slot leaves no file either, but it waits only
    while every slot is held or a gate waits, which already counts. Load from a worker's Claude session, which takes no slot, no longer holds a
    gate back. Decision 96 made test runs the load that matters, and lint, typecheck and debt
    children are this gate's own.
    Tests: under a fake load source, a load of 20 on a ceiling of 8 with no other test run
    returns at once and prints nothing; a wait with other runs going waits for the load to
    fall with one line, runs the tests after its timeout with a one-line note, ends on an
    interrupt, and stops once the other runs end though the load stays high.
    `testRunsElsewhere` is false for empty or missing slots and for this process's own slot,
    true for another live process's slot or gate wait file and for slots it cannot read, a
    dangling link at the slots path included, and it
    reclaims a dead holder's slot and wait file.
