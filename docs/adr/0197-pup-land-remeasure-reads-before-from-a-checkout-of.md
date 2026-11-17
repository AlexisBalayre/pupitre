# 0197. `pup land --remeasure` reads "before" from a checkout of the merge's base, wherever local main is (2026-11-17)

- Status: accepted
- Amends: [0185](0185-pup-land-remeasure-takes-a-moved-head-on-the.md)

197. **`pup land --remeasure` reads "before" from a checkout of the merge's base, wherever local
    main is (2026-11-17).** Decision 185 ran a remeasure only with the local target at the commit
    the merge went onto (`landedOn`). `measureBranch` read the complexity stage's "before" from the
    main checkout, so any other position would read the wrong side: past it, another PR's change or
    this merge's own; behind it, files the base had changed since. That refused the live cases
    t-mw6hh1hz (#278) and t-mvry2mew (#283), whose merges local main already holds. It also made
    every merge that a later land moved past impossible to remeasure for good.
    *The rule.* `measureBranch` takes an optional `beforeDir` beside its pin. When given, it cuts a
    detached checkout of the pin's `targetSha` there with `cutGateCheckout`, the gate checkout's own
    cut, so the same refusals apply: armed drivers, shared-config or per-worktree `core.worktree`
    keys, and committed links that reach outside the checkout. The complexity "before" then reads
    that checkout's files. Only `measurePath` changes: `configPath` stays the main checkout, as for
    the "after" side and the gate's "before", and `measureSha` and `configSha` stay `targetSha`. The
    checkout is cut only when an adapter measures complexity, and before any stage runs the
    session's code. A remeasure passes `beforeDir` as its gate checkout's path with `-before`
    appended. That is a sibling under the same private `mkdtemp` root, so the remeasure's `finally`
    removes both and prunes their registrations, on a pass, a refusal and a throw alike. The
    main-at-`landedOn` refusal is gone. The checks after the stages stay: the lock, the main
    checkout's branch, the local target at the commit read before the stages, and origin still
    holding its tip.
    *Where the checkout lives.* In the system temp dir, as the gate's own checkout is, not under
    the store (`~/.pupitre`). The sandbox denies every gate child reads under the store (decision
    36), and a custom adapter's complexity command runs as one, with the measured path as its cwd.
    A stage's child may write only its own cwd (the gate checkout or a nested package in it), the
    sandbox's scratch and cache dirs, and the paths the caller grants. So the session code a stage
    runs cannot rewrite the "before" checkout beside it. A committed link that could reach it is
    refused as one that leaves the gate checkout. Where pup does not sandbox, that write is open,
    as one to the main checkout already is.
    *The gate is unchanged.* `runMergeGate` and the re-gate pass no `beforeDir`, so a gate run reads
    "before" from the main checkout as before, which the merge lock holds at the target it measures
    against. The merge-gate tests pass unchanged.
    *Tests.* In `land.test.ts`, the test that refused a remeasure with local main behind the base or
    past it holding the merge now lands both. Behind: another PR added `src/other.ts` on GitHub, and
    the head past the pin changes it. Past: the merge changes `src/app.ts`, and local main
    fast-forwarded onto it. An adapter's complexity capability records what its "before" call read
    at the measured path. In each case that is the file as the base holds it, read from a directory
    other than the repo. The directory is gone after the land, and no worktree lists it.
