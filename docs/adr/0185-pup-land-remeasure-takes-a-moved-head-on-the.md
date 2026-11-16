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
    full pass lands, and the land then goes on as usual. The land checks the stages itself, not
    only that `measureBranch` returned: it lands on `pass`, on `skipped` as the gate passes it (no
    command, the untested skip of decision 139), and on `flagged`, which the ledger judges. Any
    other status refuses, a future one included, naming the stage and its detail. A `skipped`
    is held to the pin. The gate, and the re-gate that re-pins, file their passing report on the
    way to merged, just before the `merge` event naming the sha they pinned, and the lookup
    relies on that pairing. Walking back, in event-id order, from the newest `merge` event naming
    the pin, the first `gate_result` or `merge` it meets must be a passing report into merged.
    An older `merge` there means this pin filed no report, and the remeasure refuses rather than
    borrow the older pin's. So does a report that failed or went elsewhere, whatever came after
    the pin. Events of other types are passed over, since none carries a report: the gate kills
    the pane and removes the worktree between its report and its merge event. That report must
    list build, test and lint, which every gate run lists whether it ran or skipped them; an empty
    or partial one refuses. A stage that ran there, passing or flagged, must run again, so a
    commit past the pin that takes a script or a config away cannot turn it into a skip. Only
    `worktree-clean` and `fresh-base` are let off: the gate runs them on the session's worktree,
    and a remeasure, measuring the merge commit from a checkout of its own, has none.
    *What it does not catch.* Stages are matched by name and status only. A commit past the pin
    that replaces a script with a no-op gets `pass` from that stage, as it would at the gate,
    which trusts the session's scripts the same way. A `flagged` stage must
    have filed debt: each wording below names the stage that files it, and a flagged stage with
    no flag of its own refuses. So does a debt
    flag whose kind the session's own gate did not already file as accepted debt: no one
    accepted it. A kind the session already holds open in the ledger passes only up to the
    figures accepted: the stages measure the whole PR again, so the flags the first gate filed
    come back, but an `Oversize diff (612 lines)` someone accepted does not let 651 lines through.
    Each figure is compared on its own, in the direction it worsens: more lines, files, exports or
    decision points; for duplication, a lower before or a higher after; for a coverage gap, a
    lower patch coverage or a higher baseline. A flag passes when one open entry of its kind is
    no worse on every figure. The figures are read from the gate's own wordings matched whole, so
    a path or a name inside a description cannot supply one; a description in no such wording,
    or a figure that is no finite number, on either side, refuses. A wording with no figure (a
    nested package missing a script, a coverage gap of unreported files) passes only against an
    entry of the same kind, which keeps every word but the figures: the same package and script,
    the same cause. A percentage is one figure whether it is rounded to a whole percent or not, so
    `80%` and `80.4%` give the same kind. Where a flag's files are what was accepted rather than
    where it was found (a text file git reports as binary, a changed source file coverage did not
    measure, a coverage gap of unreported files), the entry no worse must also have named each of
    the flag's files: a count held level cannot swap a hidden file no one read for the one
    accepted. A coverage gap of unreported files and patch coverage refuses whatever was
    accepted: its wording records no patch coverage, so held to its kind and files alone its
    patch coverage could fall to any figure, as long as the uncovered lines stayed in files the
    entry named. The refusal says its figures are unreadable or unrecorded. An entry whose files
    are not a JSON list of paths accepts nothing, so a string cannot match a file by substring.
    *Not caught:*
    a re-gate files no flag of a kind the session already holds, so the ledger keeps the first
    gate's figures, and a remeasure of a re-pinned head whose figures grew since then refuses;
    it fails closed. A remeasure files no debt, refused or passed: every flag it passes is
    already an open entry no worse, which filing again would only duplicate, as the re-gate
    does not file a kind the session holds. `measureBranch` only reads the store, so a refusal
    changes nothing and records nothing. A pass records only the `landed` event below, and the
    audit then re-stamps the baseline as it does after every land. The session stays merged
    after a refusal, and the operator still has `--accept-head`.
    *After the stages.* They take minutes, so the land reads again what it acts on before
    anything moves: the merge lock must still be held, the main checkout still on the target,
    and the local target at the commit read before. Origin's target is fetched again and must
    still hold the tip fetched before; origin moving on changes nothing landed, while origin
    rewound refuses. Anything moved refuses, and the operator re-runs the remeasure.
    *The local target.* `measureBranch` reads the complexity stage's "before" from the main
    checkout's files, which the gate's merge lock holds at the target it measures against. A
    remeasure measures against the commit the merge went onto, so it runs only when the local
    target is at that commit, and refuses before any stage otherwise. Another PR that merged
    between the two and changed a file this merge changes would hide this merge's rise, or
    inflate it. A local target that already holds the merge would read the merge's own change as
    what came before. Either way the rise read is not this merge's. A session whose merge the
    local target already holds therefore cannot be remeasured, as long as that side is read from
    the main checkout.
    *What it checks besides.* The PR's head ref is still read from origin and must be the head
    GitHub reports. The merge commit must still have the tree that merging that head gives
    (decision 131). The pin need not be an ancestor of the head, unlike with `--accept-head`: the
    stages measure everything the merge landed, not "the gate's content plus what someone read".
    `--remeasure` and `--accept-head` are refused together, and so is `--remeasure` on a PR that
    merged at the pin. `--remeasure` with decision 146's `--abandon-closed` is refused too: that
    flag records a closed PR and lands nothing, so a remeasure beside it would be dropped unread.
    *Critical areas.* A pass says that the code builds and that its tests and lint pass. It does
    not say that a change to the gate, git, the store or the hooks is sound. So when the commits
    past the pin (`<pin>..<head>`) change a file in a `CRITICAL_AREAS` path, the remeasure is
    refused before any stage runs, unless `--approved-by <who>` names the operator's approval.
    `--remeasure` is operator-only, as `--accept-head` is, and `pup land` is refused to sessions
    already. `--approved-by` is a name the CLI cannot check, so a conductor that could pass one
    could land an unmeasured change to a critical area on a steer or an injected prompt.
    `--approved-by` without `--remeasure` is refused. The paths past the pin are the two trees'
    difference, not the scope audit's diff from a merge-base: the head need not descend from the
    pin, and from an older merge-base a head that kept a critical change the pin had changed back
    would show none. A head that took in its target since lists the target's changes too, which
    over-reports and fails closed. The git is the scope audit's otherwise: the safe config, the
    scrubbed environment with replace refs off, no external diff or textconv, and `--no-renames`,
    so a file moved out of a critical area counts as a change to it. The glob match is
    case-sensitive, as the gate's is, so on a case-insensitive filesystem a path spelled in
    another case escapes it there too.
    *The event.* The `landed` event of a remeasured land records `remeasuredHead`, `pinned`, the
    passing report as `remeasure`, and `approvedBy` when one was given. An accepted land keeps
    decision 164's `acceptedHead` and `pinned`, and a land at the pin carries none of these.
    *Not taken.* Re-gating a MERGED PR with `pup merge --pr`, for decision 164's reason. Measuring
    the PR's head instead of the merge commit was not taken either: the merge commit is what
    lands on the target.
