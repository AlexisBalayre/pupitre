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
    and names the stage and its detail; the land checks the stages itself, not only that
    `measureBranch` returned. So does a debt flag whose kind the session's own gate did not
    already file as accepted debt: no one accepted it. A kind the session already holds open in
    the ledger passes only up to the figure accepted: the stages measure the whole PR again, so
    the flags the first gate filed come back, but an `Oversize diff (612 lines)` someone accepted
    does not let 651 lines through. Worse means more lines, files, exports or decision points, a
    larger duplication rise, or a larger patch-coverage drop below the baseline; against several
    open entries of a kind, the worst one accepted is the bar. Equal or better passes. A refusal
    changes nothing and records nothing: `measureBranch` only reads the store, and the debt it
    flags, the baseline it would ratchet and the event are written by the land alone, after a
    pass. The session stays merged, and the operator still has `--accept-head`.
    *After the stages.* They take minutes, so the land reads again what it acts on before
    anything moves: the merge lock must still be held, the main checkout still on the target,
    and the local target at the commit read before. Origin's target is fetched again and must
    still hold the tip fetched before; origin moving on changes nothing landed, while origin
    rewound refuses. Anything moved refuses, and the operator re-runs the remeasure.
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
    `--remeasure` is operator-only, as `--accept-head` is, and `pup land` is refused to sessions
    already. `--approved-by` is a name the CLI cannot check, so a conductor that could pass one
    could land an unmeasured change to a critical area on a steer or an injected prompt.
    `--approved-by` without `--remeasure` is refused. The paths past the pin are listed with
    `gitDiffPaths`, the git the gate's scope audit runs: the safe config, the scrubbed
    environment with replace refs off, and no external diff or textconv. The glob match is
    case-sensitive, as the gate's is, so on a case-insensitive filesystem a path spelled in
    another case escapes it there too.
    *The event.* The `landed` event of a remeasured land records `remeasuredHead`, `pinned`, the
    passing report as `remeasure`, and `approvedBy` when one was given. An accepted land keeps
    decision 164's `acceptedHead` and `pinned`, and a land at the pin carries none of these.
    *Not taken.* Re-gating a MERGED PR with `pup merge --pr`, for decision 164's reason. Measuring
    the PR's head instead of the merge commit was not taken either: the merge commit is what
    lands on the target.
