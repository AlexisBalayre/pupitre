# 0133. A rebase that stops only on the ADR index falls back to the merge that regenerates it (2026-11-05)

- Status: accepted
- Amends: [0008](0008-fresh-base-gating.md), [0105](0105-a-branch-an-open-pr-holds-is-never.md), [0120](0120-fresh-base-regenerates-a-conflicted-adr-index-in-the.md)

133. **A rebase that stops only on the ADR index falls back to the merge that regenerates it
    (2026-11-05).** Decision 120 regenerated a conflicted `docs/adr/README.md` only where
    fresh-base merges, the branch of an open PR. A branch with no open PR is rebased
    (decision 8), and two such branches that each add a decision still conflicted on their
    index lines, sending the worker to hand-merge a generated file.
    *What resolves.* When the gate's auto-rebase stops, it lists the stop's unmerged entries
    with `ls-files --unmerged -z` before aborting. When they are exactly the index's three
    stages, each a regular file (decision 120's conflict shape), the rebase is aborted as
    before and the target is merged into the branch instead, through the same plumbing merge
    an open PR's branch takes (decision 105). That merge runs `merge-tree` over the whole
    branch and resolves an index-only conflict by running `scripts/adr-index.sh` in a scratch
    checkout, with every check of decision 120. The stage passes as `auto-merged <target>,
    its rebase having conflicted only in docs/adr/README.md`. The branch then holds a merge
    commit, which the fast-forward carries onto the target.
    *Why not continue the rebase.* Resolving the stop in place would mean `rebase
    --continue`, which reads its todo back from rebase state the live session can write.
    Decision 120 removed that surface, and this decision keeps it removed. Replaying the
    branch's commits in plumbing would keep history linear, but it would reimplement rebase
    (authorship, empty commits, merges) for one generated file. The fallback reuses a merge
    path that is already hardened. Reading the unmerged entries from the worktree's index is
    safe even though the session can write that index: the listing only decides whether to
    try the merge, and `merge-tree` decides what conflicts from the commits themselves.
    *What still refuses.* A stop that lists any other path keeps the plain rebase refusal,
    and nothing is merged. A fallback merge that refuses (another file conflicts across the
    whole branch, two decisions share a number, or any other refusal in decision 120) fails
    the stage with the rebase detail, followed by a line saying the gate merged the target
    in to regenerate the index and that the merge stopped too, then the merge's own detail.
    The branch is left where it was.
    *Tests.* In `merge-gate.test.ts`: a branch with no open PR that adds a decision while
    main adds another merges with no worker action and never runs `--continue`. The landed
    commit has the branch tip and the target as parents, and its index passes `adr-index.sh
    --check`. A rebase that also stops on `src/app.ts` keeps the plain refusal and runs no
    `merge-tree`. Two decisions that share a number report both refusals, commit no tree,
    and leave the branch and main unmoved.
