# 0105. A branch an open PR holds is never rebased: fresh-base merges the target into it, and the push does not force (2026-10-25)

- Status: accepted
- Amends: [0008](0008-fresh-base-gating.md), [0027](0027-a-failed-pup-merge-pr-retries-cleanly-and.md)

105. **A branch an open PR holds is never rebased: fresh-base merges the target into it, and the
    push does not force (2026-10-25).**
    Amends decision 8. Fresh-base rebased every stale branch onto the target, and the `--pr`
    gate then pushed it with `--force-with-lease`. On a fix round or a retry after the target
    moved, that replaced the commits the PR's review and CI had read (seen on #170:
    `+ 6498ed7...1c26673 (forced update)`), and the CI review's anchors with them. Now, when the
    `--pr` gate adopted an open PR for the branch, fresh-base merges the pinned target sha into
    it in plumbing only. `git merge-tree --write-tree` writes the merged tree, `commit-tree
    --no-gpg-sign` the merge commit (parents: the branch tip it read, then the target), and an
    `update-ref --no-deref` compare-and-swap moves the branch from that tip. While the worktree's
    HEAD is the branch, its index and files follow by the pinned two-way `read-tree -m -u` the
    fast-forward uses (decisions 80, 101). A worktree switched elsewhere is left alone. Never
    the porcelain `git merge`: it reads `branch.<name>.mergeOptions` (for HEAD's branch) from the
    shared config a session can write, after the `-c` pins and before argv, and the driver check
    does not flag it. A planted `-S` with a `gpg.program` of the session's ran that program
    outside the sandbox with the operator's environment, and `-F <file>` put the file's contents
    in the merge commit pushed to the PR; `--verify-signatures` and `-s <name>` (a
    `git-merge-<name>` from PATH) went the same way (found on security review of the first cut,
    reproduced on Apple Git 2.39.5). The fast-forward dropped the porcelain merge for the same
    surface in decision 80. A conflict (`merge-tree` exits 1) writes nothing and fails
    fresh-base with `Run git merge refs/heads/<target>, resolve the conflicts, and commit the
    merge`, which re-steers the worker and counts toward the reject cap like a rebase conflict
    (decision 15); the porcelain merge the worker runs there is the worker's own, inside its
    sandbox. Any other exit is git failing to merge at all (no `--write-tree` before 2.38, a
    missing object), which no worker can resolve: it throws to the operator with only objects
    written and no reject counted. A branch moved under the compare-and-swap fails fresh-base
    the same way, with nothing merged. The drivers are checked again right before `merge-tree`,
    which runs a merge driver on a conflicted file, and before the worktree's refresh and
    `read-tree`, which run a clean and a smudge filter: the check before the stages ran before
    the gh calls and the lock wait, while the session was alive (decision 50; found on the
    conductor's security review, which reproduced a driver `merge-tree` ran). When the
    `read-tree` step fails, a second compare-and-swap puts the branch back on the tip the merge
    read before anything else, an armed driver and an interrupt included, and only then does
    the refusal or the interrupt unwind the gate. The worktree's HEAD is read before the branch
    moves, so an interrupt there leaves nothing to put back; a session can hang only the pinned
    worktree git (an `includeIf` path at a FIFO), and the operator's Ctrl-C would otherwise have
    landed between the move and the undo (found on the conductor's second security review). A `read-tree` refused on an edit or a new file
    the session made after the worktree-clean stage, at a path the merge brings in, writes
    nothing. One that fails partway (a full disk, a permission, a Ctrl-C) may have written some
    files, which show as changes for the worker to discard; so the steer says the branch is back
    without the merge, never that nothing was written. An ignored file at such a path does not
    refuse it: `read-tree -m -u` overwrites it as the porcelain rebase did (Apple Git 2.39.5).
    The branch left on the merge would have had HEAD over the old tip's files, with `git
    status` showing the target's changes reversed and staged for the next commit to take; that
    revert would then pass fresh-base on the next gate (found on CI review, replacing a first
    cut that left the branch there and named the `read-tree` to run). An undo that fails too
    throws to the operator with its own error and the `read-tree`'s, as the fast-forward's
    failed restore does, since what the branch holds then is not something the gate can name.
    The push then goes without a lease, so git refuses anything but a fast-forward of what the PR holds. A
    session that rewrote the branch itself (a rebase or an amend in a fix round) is caught before the stages rather than by that push: when the
    remote-tracking ref of the last gate's push is not an ancestor of the branch, fresh-base
    fails and tells the worker to bring those commits back and merge rather than rebase. With no
    tracking ref (a PR pushed from another clone) the push alone guards. A branch no open PR
    holds is rebased as before, pushed or not: a plain `pup merge` (which asks GitHub nothing and
    fast-forwards, decision 16), the first `--pr` gate, and a retry whose earlier push landed but
    whose PR was never opened, which keeps the lease. The operator chose to keep that rebase
    unchanged. Rejected: refusing every stale open-PR branch with an operator-facing message.
    The merge is as mechanical as the rebase, and a refusal would hand the operator a step the
    gate can take.
    *Tests.* In `merge-gate.test.ts`, a branch whose first `--pr` gate pushed it and died opening
    the PR, gated again with the PR open after the target moved, passes fresh-base as
    `auto-merged main`. Its new head on origin is a merge whose parents are the pushed commit
    and the target, and the one push carries no force. With a conflicting target the gate
    rejects, steers `git merge 'refs/heads/main'` and no rebase, leaves the worktree clean on
    the pushed commit and pushes nothing. An amended branch fails fresh-base naming the pushed
    commit. With `mergeOptions` set to `-S` (and a `gpg.program` that writes a marker) or to
    `-F <secret file>`, on the session's branch and on a branch the worktree was switched to,
    the gate merges with no marker written and the merge commit's message exactly `Merge main
    into <branch>`. A gate whose build fails after the merge leaves the worktree on the merge,
    clean, with the target's files; with the worktree's HEAD detached it moves the branch to the
    merge and leaves the worktree on the pushed commit. A branch moved just before the
    compare-and-swap fails fresh-base naming the tip it moved from. An edit to a file the merge
    brings in, or a new file at a path it adds, made after the worktree-clean stage, fails it
    with the branch and the worktree's HEAD back on the pushed commit and nothing staged. A
    branch moved again before that undo throws with the undo's own `but expected <merge>`. A
    `read-tree` killed by SIGINT is rethrown with the branch already back, and a worktree
    `symbolic-ref` killed by SIGINT with the branch never moved. A merge driver armed
    at the worktree-clean stage's `status` throws `ArmedGitDriverError` before `merge-tree`
    runs, its marker unwritten; a smudge filter armed at `commit-tree` throws it before any
    `read-tree`, with the branch back on the pushed commit. None re-steers or pushes. A
    `merge-tree` exiting 128 throws, with no re-steer. A stale branch with no open PR is still
    rebased onto the target and lands on origin with no merge commit.
