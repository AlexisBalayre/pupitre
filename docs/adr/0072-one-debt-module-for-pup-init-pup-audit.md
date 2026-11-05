# 0072. One debt module for `pup init`, `pup audit` and the merge gate, measuring every detected adapter (2026-09-29)

- Status: accepted
- Amends: [0022](0022-python-adapter-ships-the-v1-gate-surface-only.md)

72. **One debt module for `pup init`, `pup audit` and the merge gate, measuring every detected
    adapter (2026-09-29).** `pup init` measured dead code and duplication across every adapter it
    detected; the merge gate measured `req.adapter` — the first hit, per decision 22 — and
    nothing else. In a TypeScript+Python repo that is not a smaller measurement but a broken one,
    in two directions: the second stack's debt was never gated, and on a passing merge the ratchet
    overwrote the all-adapter bar `pup init` had recorded with a partial one, so the next merge
    gated against a number no adapter could reproduce and `pup audit` then reported the difference
    as a rise nobody caused. Two copies of the same comparison rules, and nothing holding them to
    the same arithmetic. So `src/core/debt.service.ts` owns both halves. `measureDebt(adapters,
    ctx)` is the single measurement: dead exports union over every adapter that answered,
    duplicated lines sum with the blocks concatenated, and one `gaps[]` entry per capability an
    adapter declared and could not run — which is also `pup init`'s findings list, so the reason
    an operator reads before launching a session and the reason a skipped gate stage prints come
    from the same place (decision 29). `judgeDebt(measured, baseline, changedPaths, sessionId)` is
    the pure verdict behind the dead-code, duplication, complexity and coverage stages, returning
    its four stage rows, the flags a merge writes to the ledger or refuses over, and the bar a pass
    ratchets to. `gateAndMerge` keeps the I/O and the ordering: the two complexity checkouts,
    `coverableFiles`, the added-lines diff, and where those four stages sit among the hard ones.
    `MergeRequest` takes `adapters: Adapter[]` and `pup merge` passes `detectAdapters(repoPath)`
    whole. *Two things deliberately keep using the first adapter,* which is what amends decision 22
    rather than reversing it: a repo has one build, one test and one lint, and the nested-package
    check reads the root manifest, so both stay with the adapter whose stack detected first. Debt is
    the opposite shape — every language carries its own, and a bar counted over one of them is not
    the repo's bar. *Coverage stays one adapter's too, and that is not the same exemption:* it is
    one ratio per repo, taken from the first adapter that can produce one exactly as `pup init`
    always has, and the gate's patch bar has to come from the same report `coverableFiles` is
    answered against — a Python file judged against a TypeScript report would read as a file the
    coverage tool never saw and flag on every merge. Merging two runners' ratios into one number is
    a separate decision, and `pup init` would have to agree to it first.
    *So the coverage gap this decision does not close, stated plainly:* both `coverage` and
    `coverableFiles` are asked of that first declaring adapter only, so in a TypeScript+Python repo
    a changed Python source file gets no decision-30 unreported-file check — it is absent from the
    coverage stage's view rather than flagged as unmeasured, exactly as it was before this decision.
    Patch coverage, the repo ratio and the ratchet all remain the first adapter's. Dead code,
    duplication and complexity are gated over both stacks from here on; coverage is the one debt
    stage where the second stack is still invisible, and closing it means deciding how two runners'
    reports combine into one ratio, on the `pup init` side first.
    *A partial dead-code count still compares, but never ratchets.* When one adapter measures and
    another cannot, the comparison runs — a subset of the findings can only fail to flag, never
    flag something real as fresh — and the stage says which adapter was missing. The bar does not
    move: ratcheting a count one adapter is absent from would write that adapter's known dead
    exports out, and the next merge would see them as fresh. This is decision 39's rule for a
    duplication number counted under a superseded rule, applied to a count missing a stack.
    *Stage names, statuses and detail strings are unchanged for a single-adapter repo,* which is
    every repo pupitre runs against today including its own, and the adapter is named in a reason
    only when more than one could have answered. That constraint is what makes the change reviewable
    at all: the whole extraction landed as its own commit with every existing gate test passing
    untouched, and the multi-adapter change on top of it.
    *The pure half is table-tested in `debt.test.ts`,* and the merge-gate cases that only exercised
    a comparison moved there — a dead-code or coverage verdict needs no git repo, no store and no
    real adapter to pin down. What stayed end to end in `merge-gate.test.ts` is what needs the real
    thing: the refusal path, decision 29's worktree/config split, the two complexity checkouts,
    `coverableFiles`, the ledger writes, and every ratchet the store can show — including the
    two-adapter merge whose ratcheted `duplicatedLines` is asserted against what `initProject`
    records over the same two adapters, which is the one assertion that would have caught the
    original bug.
    *An operator security review after the fact tightened two things.* The dead-code stage now
    *skips* rather than passes when one adapter measured nothing and the rest found nothing new: a
    session can make a capability unavailable from inside its own worktree — an unparseable `.py`
    file is enough to stop vulture — and a stage that measured nothing must not read as one that
    found nothing (decision 29's rule, applied to a partial measurement). A real finding still
    flags, because the adapters that did measure found it. And `runMergeGate` now refuses an empty
    `adapters` list before taking the lock: with no adapter the hard stages report "no command
    available" and every debt stage "adapter cannot measure", so the gate would merge anything it
    was handed while printing a full-looking report — decision 6's backstop, silent. `pup merge`
    already refused an undetected repo; the refusal belongs at the seam every caller shares.
    *Not validated with the gate,* per the rule decision 39 learned: a change to what a gate metric
    counts cannot be confirmed by the gate that counts it. `pnpm test`, `pnpm typecheck` and the new
    tables are the evidence.
