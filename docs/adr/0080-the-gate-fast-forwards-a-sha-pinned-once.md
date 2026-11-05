# 0080. The gate fast-forwards a sha pinned once, with plumbing, and porcelain `git merge` is gone from it (2026-10-08, closes decision 79's accepted window)

- Status: accepted

80. **The gate fast-forwards a sha pinned once, with plumbing, and porcelain `git merge` is gone
    from it (2026-10-08, closes decision 79's accepted window).** `gateAndMerge` resolved
    `session.branch` by name at every step and landed it with `git merge --ff-only`, so a session
    alive during the stages, with write access to the shared `.git`, could flip the main
    checkout's HEAD between the under-lock re-read and the merge so git applied
    `branch.<other>.mergeOptions`; name a lightweight tag like its branch, which a bare name
    resolves to first; commit after build, test, lint and the scope audit ran; re-arm
    `info/attributes` after the one-time `assertNoArmedGitDrivers`; or point HEAD at a branch
    named with a leading `-`, which the rebase read as an option. Now:
    *Both ends pinned.* Under the lock the target's sha is read from `refs/heads/<target>` before
    fresh-base, and the rebase runs onto that sha. Right after fresh-base the branch is resolved
    from `refs/heads/<branch>^{commit}`, never a bare name, and from there that sha is what the
    scope audit, every diff, the binary recount, the commit log, the debt measurement's diffs,
    the merge, the `--pr` push and the `merge` event (as `sha`) name. A commit or tag the session
    makes later changes nothing the gate measures or lands. Either ref being a symbolic ref is
    refused at the pin: a branch symref'd to `main` pins `main`'s own sha, passes every stage on
    an empty diff, and the delete below would have removed `main` through it (found on review,
    reproduced). Every ref the gate writes passes `--no-deref`, for a symref written after the
    pin: the target, the branch delete, and the `--pr` push's remote-tracking ref.
    *The fast-forward is plumbing.* `git merge-base --is-ancestor <targetSha> <sha>` right after
    the pin, failing fresh-base (a re-steer, in both modes) when the rebase left the branch behind
    because the worktree had something else checked out; then `git
    read-tree -m -u <targetSha> <sha>` in the main checkout, then `git update-ref -m … refs/heads/
    <target> <sha> <targetSha>`. None of these reads per-branch config, so a HEAD flipped between
    any check and any spawn cannot bring `mergeOptions` back; the old-value argument makes the
    ref update a compare-and-swap that refuses if anything moved the target since it was pinned,
    which also covers the window between the HEAD re-read and the checkout. `read-tree -m -u`
    refuses to overwrite a local change in the main checkout, as the porcelain merge did, after an
    `update-index -q --refresh` so a stale stat is not taken for one. Both run with
    `--work-tree <repoPath>`, since `core.worktree` in the shared config would otherwise aim the
    checkout's writes elsewhere, `--no-sparse-checkout`, since a planted `core.sparseCheckout`
    would have the checkout delete trusted files from the main checkout (found on review,
    reproduced) — an operator who uses sparse-checkout there gets a full tree after a merge —
    and `--no-recurse-submodules`; `GIT_SAFE_CONFIG` gains `-c
    submodule.recurse=false`, because with it set a tracked `.gitmodules` let the checkout (and
    the rebase) recurse into a planted `.git/modules/<name>` whose own config and attributes arm a
    smudge filter no driver check reads (found on review, reproduced; it predates this decision).
    Nothing is recorded on any failure. The target is read once more right before `read-tree`
    (found on review): pinned before the stages, a session alive through them can move it on
    purpose, and a refusal after the checkout would have left a restore line for the operator to
    paste while the session arms a smudge filter against it; so a moved target is refused before
    the checkout is touched, and the compare-and-swap is the backstop for the milliseconds in
    between. A refused checkout moved nothing and says so. A refused compare-and-swap leaves the
    moved ref alone and pup itself runs the inverse `read-tree -m -u <sha> <targetSha>` under the
    lock, keeping local changes — after checking the drivers once more, because the forward
    checkout of the session's own tree is a window the session controls (found on review); with
    a driver armed the restore is skipped and the line is printed with the order to clear
    `filter.*` and `info/attributes` first (decision 50), as it is when the inverse fails. `pup review` and the overlap scan name `refs/heads/` too (found on review): a
    bare name resolves a same-named tag first, and the review must show what the gate merges.
    On a detached main checkout the overlap sweep is skipped whole rather than run against
    `refs/heads/` of nothing: the stored overlaps and the beat are kept, `scanOverlaps` returns
    undefined, and `pup watch` says the radar is paused instead of printing an all-clear.
    *The driver check runs twice.* `assertNoArmedGitDrivers` runs again on the main checkout under
    the lock, next to the HEAD re-read and before the checkout, because `read-tree -u` runs a
    smudge filter on every file it writes. This narrows decision 50's window to the few
    milliseconds between that read and the checkout's spawn; it does not close it, since a
    session polling `ps` can write between them. Closing it means running the checkout from a
    scratch git dir that never reads the shared config, as decision 54 does for the push.
    *The target name is checked.* Before any stage, a target that starts with `-`, or that `git
    check-ref-format --branch` rejects or rewrites (it expands `@{-N}`), is refused, and decision
    79's `=` refusal stays though no `-c` is keyed on the name any more, because a refusal set only
    grows. So is a name carrying a control or format character (`\p{Cc}`, `\p{Cf}`):
    `check-ref-format` lets C1 controls and bidi overrides through, `sanitizeReason` strips the
    first and not the second, and the name is printed in every refusal; the messages that name it
    pass it through `sanitizeReason` besides. Wherever the target is an argument it is
    `refs/heads/<target>` or its sha, the fresh-base conflict hint included.
    *The branch is deleted by compare-and-swap too.* `update-ref -d refs/heads/<branch> <sha>`
    replaces `git branch -d/-D`, so a branch the session moved past the pin is kept, its unmeasured
    commits left for the operator rather than merged or thrown away.
    Tests drive `runMergeGate`: a tag named like the branch pointing at an out-of-scope commit
    changes nothing; a commit made from an adapter's in-process `gateCommands` is not merged and
    the event carries the pinned sha; a target moved there is refused with the compare-and-swap
    message and no `merge` event; `info/attributes` armed there is refused and the smudge never
    runs; a `-evil` HEAD is refused before `gateCommands` is asked; a branch symref'd to `main` is
    refused and `main` survives. `GIT_SAFE_CONFIG` keeps
    `merge.verifySignatures=false` and `pull.twohead=ort`: they cost nothing and cover any
    porcelain merge pup may run elsewhere.
    *Not closed here:* the pin covers what git names — the scope audit, the diff-size count, the
    patch the coverage stage reads, the commit log and the merge. Build, test, lint, the
    nested-package stages and every debt capability (dead code, duplication, complexity,
    coverage) still read the live worktree, whose files the session can change while they run,
    and the baseline ratchet comes from those capabilities, so the merged commit is the one the
    diffs named, not necessarily the one those stages saw — closed by decision 81, which runs
    them on a detached checkout of the pinned sha. And the `merge` event's `sha` is written but not yet
    named by `EventPayloads` or `decodeEvent` (`session-event.types.ts`, `session.repository.ts`,
    out of this task's scope), so nothing reads it back yet.
