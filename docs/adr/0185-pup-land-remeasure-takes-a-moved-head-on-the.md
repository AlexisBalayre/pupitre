# 0185. `pup land --remeasure` takes a moved head on the gate's word (2026-11-13)

- Status: accepted
- Amends: [0164](0164-pup-land-takes-a-moved-head-on-the-operator-s-word.md)

185. **`pup land --remeasure` takes a moved head on the gate's word (2026-11-13).**
    Decision 164 lets a PR that GitHub merged at a head past the pin land only on the operator's
    `--accept-head`, after they have read the commits past the pin. A session whose fix round
    pushed after the gate's pin, such as t-mw6hh1hz (#278) or t-mvry2mew (#283), then waits on
    that read even when the gate could measure the merge itself.
    *The rule.* `pup land <session> --remeasure` runs the gate's stages under the land's merge lock.
    These are `measureBranch`'s stages: ADR numbers, build, test, lint, nested packages, scope
    audit, diff size and the debt deltas. They run on the commit GitHub's merge made, against
    the commit that merge went onto on the pinned target, which is the base `mergedOnto` finds.
    They use a gate checkout, a sandbox run and a test slot, the same as `runMergeGate`. Only a
    full pass lands, and the land then goes on as usual. A hard stage that fails refuses the land
    and names the stage and its detail. So does a debt flag whose kind the session's own gate
    did not already file as accepted debt: no one accepted it. A kind the session already holds
    open in the ledger passes, since the stages measure the whole PR again, and the flags the
    first gate filed come back with new figures. The re-gate reads the ledger the same way
    (decision 86). A refusal changes nothing and records nothing. The session stays merged, and
    the operator still has `--accept-head`.
    *What it checks besides.* The PR's head ref is still read from origin and must be the head
    GitHub reports. The merge commit must still have the tree that merging that head gives
    (decision 131). The pin need not be an ancestor of the head, unlike with `--accept-head`: the
    stages measure everything the merge landed, not "the gate's content plus what someone read".
    `--remeasure` and `--accept-head` are refused together, and so is `--remeasure` on a PR that
    merged at the pin.
    *Critical areas.* A pass says that the code builds and that its tests and lint pass. It does
    not say that a change to the gate, git, the store or the hooks is sound. So when the commits
    past the pin (`<pin>...<head>`) change a file in a `CRITICAL_AREAS` path, the remeasure is
    refused before any stage runs, unless `--approved-by <who>` names the operator's approval.
    The conductor may run `--remeasure`, since the gate is what vouches. It relays an approval
    and never gives one, so it cannot name `human` (decision 75). `--approved-by` without
    `--remeasure` is refused.
    *The event.* The `landed` event of a remeasured land records `remeasuredHead`, `pinned`, the
    passing report as `remeasure`, and `approvedBy` when one was given. An accepted land keeps
    decision 164's `acceptedHead` and `pinned`, and a land at the pin carries none of these.
    *Not taken.* Re-gating a MERGED PR with `pup merge --pr`, for decision 164's reason. Measuring
    the PR's head instead of the merge commit was not taken either: the merge commit is what
    lands on the target.
