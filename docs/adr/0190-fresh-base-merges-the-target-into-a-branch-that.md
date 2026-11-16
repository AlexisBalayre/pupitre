# 0190. Fresh-base merges the target into a branch that already merged it, or whose rebase conflicts (2026-11-16)

- Status: accepted
- Amends: [0008](0008-fresh-base-gating.md), [0105](0105-a-branch-an-open-pr-holds-is-never.md)

190. **Fresh-base merges the target into a branch that already merged it, or whose rebase
     conflicts (2026-11-16).**
     Amends decisions 8 and 105. Fresh-base rebased every stale branch no open PR holds. Workers
     are told to resolve a conflict with the target by merging it into their branch while they
     wait for a first gate. When the target then moved again, the rebase dropped that merge
     commit and replayed the commits under it, the conflict it had resolved came back, and the
     gate failed with `Auto-rebase hit conflicts` although `git merge main` was clean. On
     2026-11-16, right after #330 and #339 merged, that cost t-mwfi02io and t-mvrwns2g-2 one of
     their two rejections each, for a failure they had already fixed.
     Now a stale branch no open PR holds takes the pinned target as a merge commit, in the same
     plumbing a PR branch uses (decision 105: `merge-tree --write-tree`, `commit-tree`, a
     compare-and-swap of the branch, and the pinned two-way `read-tree` of the worktree), in two
     cases. First, when it already holds a merge of the target: a merge commit in
     `<target>..<branch>` with a parent the target contains. It is read in one `rev-list --parents`
     (a parent is in the target exactly when it is not itself in that range), never a git process
     per parent, as it runs under the merge lock every queued gate waits on (found on security
     review). The rebase is not tried, so the worker's resolution is kept. Second, when the rebase hits conflicts: the rebase is aborted
     as before (no resolved stop goes on through rebase state the session can write, decision
     120), and the merge is tried. Only a conflicting merge fails fresh-base, with the PR
     branch's steer: `Run git merge refs/heads/<target>, resolve the conflicts, and commit the
     merge`. A merge the worker commits there is the one the next gate keeps. Any other branch
     is rebased as before, so a branch with no merge keeps the linear history decision 8 gives
     it. An interrupt during the rebase or its abort is rethrown, never taken as a conflict,
     so no merge follows a Ctrl-C. An abort that fails otherwise (a rebase that never started,
     or an `index.lock` the session holds) may leave the worktree mid-rebase on a detached
     HEAD, so it fails fresh-base as before, steering the worker to finish the abort and merge
     the target, and nothing is merged over it (found on CI review).
     *The reject budget.* A fresh-base failure the session did not cause no longer happens: the
     cleanly mergeable cases above pass. A merge that truly conflicts still re-steers the worker
     and counts toward the reject cap, as decision 15 has it, since the fix is the worker's.
     Rejected: rebasing with `--rebase-merges`, which replays the worker's merge but re-runs its
     conflict and stops for a resolution the gate cannot make. Rejected too: merging every stale
     branch, which would end decision 8's linear history for branches that rebase cleanly. The
     operator kept that rebase in decision 105.
     *Tests.* In `merge-gate-fresh-base.test.ts`, on real git repos: a branch that merged main
     over a conflict, gated after main moved again cleanly, passes fresh-base as `auto-merged
     main`. Main lands on a merge whose parents are the worker's merge and the moved target,
     with the worker's resolution. A branch whose rebase conflicts but whose merge is clean
     passes as `auto-merged main after the auto-rebase hit conflicts`. A branch whose merge with
     the target conflicts is rejected and steered to `git merge refs/heads/main`, with the
     branch, the target and the worktree left as they were. A branch holding 30 merges off the
     target is still rebased, with no more `--is-ancestor` checks than one holding 1. In `merge-gate.test.ts`, a plain
     conflicting branch is steered to the same merge. An interrupt thrown from the rebase,
     once it has stopped on its conflict, or from its abort, rejects the gate with no steer and
     leaves the branch and the target where they were; an abort that fails with no interrupt
     fails fresh-base and merges nothing.
