# 0198. `pup land --remeasure` reads "before" from a checkout of the merge's base, wherever local main is (2026-11-17)

- Status: accepted
- Amends: [0185](0185-pup-land-remeasure-takes-a-moved-head-on-the.md)

198. **`pup land --remeasure` reads "before" from a checkout of the merge's base, wherever local
    main is (2026-11-17).** Decision 185 ran a remeasure only with the local target at the commit
    the merge went onto (`landedOn`). `measureBranch` read the complexity stage's "before" from the
    main checkout, so any other position would read the wrong side: past it, another PR's change or
    this merge's own; behind it, files the base had changed since. The same guard kept decision
    29's trusted config source honest: past `landedOn`, the main checkout holds the session's own
    merge, and the gate would take its commands and declared tools from files the session wrote.
    That refused the live cases t-mw6hh1hz (#278) and t-mvry2mew (#283), whose merges local main
    already holds. It also made every merge that a later land moved past impossible to remeasure
    for good.
    *The rule.* `measureBranch` takes an optional `targetDir` beside its pin. When given, it cuts a
    detached checkout of the pin's `targetSha` there with `cutGateCheckout`, the gate checkout's own
    cut, so the same refusals apply: armed drivers, shared-config or per-worktree `core.worktree`
    keys, and committed links that reach outside the checkout. That checkout stands in for the main
    checkout everywhere `measureBranch` reads config or "before". A remeasure passes `targetDir` as
    its gate checkout's path with `-target` appended. That is a sibling under the same private
    `mkdtemp` root, so the remeasure's `finally` removes both and prunes their registrations, on a
    pass, a refusal and a throw alike. The main-at-`landedOn` refusal is gone. The checks after the
    stages stay: the lock, the main checkout's branch, the local target at the commit read before
    the stages, and origin still holding its tip.
    *Where the config is read.* From the stand-in, at `landedOn`: it is the capability context's
    `configPath`, and the root `gateCommands` and `skipsTestsOnUntestedChanges` are given. Nested
    packages' scripts and manifests, the owning lockfiles and the uninstalled-package refusal read it
    too. Only the installed environment is the main checkout's, since nothing installs the stand-in.
    Each `node_modules` the gate links is linked into the stand-in first, entry by entry, from the
    main checkout's, as `linkEnvironment` links the gate checkout. The gate checkout then links the
    stand-in's, which is what an adapter checks its links against. Python gets nothing, as decision
    81's ceiling already says for the gate checkout. What git reads through the stand-in stays
    pinned: `configSha` is `targetSha`. Its `.git` file and admin dir lie outside every write a
    sandboxed stage is granted, as the main checkout's do (decision 101). A capability's child is
    keyed to the toolchain cache by its `configPath`, so a remeasure's capabilities start from a
    cache of their own; a stage's child keeps the repo's.
    *Where "before" is read.* From the stand-in, as `measurePath` and `configPath` with `measureSha`
    and `configSha` at `targetSha`. It is measured once the environments are linked, before any
    stage runs the session's code, and that figure is the one compared; nothing reads it again.
    *Where the checkout lives.* In the system temp dir, as the gate's own checkout is, not under
    the store (`~/.pupitre`). The sandbox denies every gate child reads under the store (decision
    36), and a custom adapter's complexity command runs as one, with the measured path as its cwd.
    A stage's child may write only its own cwd (the gate checkout or a nested package in it), the
    sandbox's scratch and cache dirs, and the paths the caller grants. Where pup does not sandbox, a
    stage can write beside its cwd, so the sandbox is not what keeps "before" honest. The order is:
    the figure is taken before the first stage starts, so a later write to the stand-in changes
    nothing read. The config read after the stages is as open to that write as the main checkout's
    is to the same write in a gate run.
    *What still reads the main checkout.* Which adapters run, and a custom adapter's commands, are
    resolved by the CLI before the land, from the main checkout. In the past case that is the merge
    itself. Changing `.pupitre/adapter.yml` is a protected path, so the scope audit refuses such a
    merge. The audit after a land reads the main checkout as it now is, as it always has.
    *The gate is unchanged.* `runMergeGate` and the re-gate pass no `targetDir`, so a gate run reads
    config and "before" from the main checkout as before, which the merge lock holds at the target
    it measures against. The merge-gate tests pass unchanged.
    *Tests.* In `land.test.ts`, the test that refused a remeasure with local main behind the base or
    past it holding the merge now lands both. Behind: another PR added `src/other.ts` on GitHub, and
    the head past the pin changes it. Past: the merge changes `src/app.ts`, and local main
    fast-forwarded onto it. An adapter's complexity capability records what its "before" call read
    at the measured path. In each case that is the file as the base holds it, read from a directory
    other than the repo. The directory is gone after the land, and no worktree lists it. A build
    stage that marks it ran and rewrites the stand-in beside it is not seen: "before" read the
    base's file before the mark existed. With local main fast-forwarded onto a merge that raises a
    file from 1 to 40, the remeasure flags a rise of 39 against the base, where a read at local main
    would find none. With local main fast-forwarded onto the merge, `gateCommands` and both
    complexity calls read the base's file at the path they are given. The gate checkout's
    `node_modules` entry links the stand-in's, and resolves to the main checkout's.
