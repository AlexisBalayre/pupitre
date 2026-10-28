# 0117. A sandbox grant's own name, every directory above it and every directory below a checkout that leads to a nested `.git` cannot be unlinked or renamed, except a caller's output directory, which keeps its name free (2026-10-28).

- Status: accepted

117. **A sandbox grant's own name, every directory above it and every directory below a
    checkout that leads to a nested `.git` cannot be unlinked or renamed, except a caller's
    output directory, which keeps its name free (2026-10-28).**
    The t-mvqve712 security review found by reading the profile that a grant covers its own
    name, so a child may rename it. Reproduced under the generated profile on macOS: in
    `pup init` and `pup audit` the child's cwd is the operator's repo. The child ran `mv` on
    the repo into its TMPDIR, where decision 36's `.git` deny does not reach because it is
    scoped to the checkout's path. There it ran `git config core.hooksPath`, then moved the
    repo back. The repo's `.git/config` then carried the hook path for pup's next unsandboxed
    git call (decision 28). The direct write was refused as before. A hard link from scratch to
    a file under `.git` was refused too, so the rename was the only way in.
    The conductor's review of the first fix found the same hole one level down, also
    reproduced. The operator's repo holds the session worktrees under `.worktrees/`. The child
    moved `.worktrees/s1` into scratch, rewrote its `.git` pointer file to `gitdir:` a
    directory the child controls, and moved it back. pup's next git call in that worktree would
    run that directory's config. Submodules and vendored repos are exposed the same way.
    *The pin.* `writeProfile` ends the profile with one `(deny file-write-unlink (literal ...))`
    rule. A rename checks its source against `file-write-unlink`, as `rmdir` and `unlink` do,
    so the rule stops a move as well as a removal. A `renamex_np` swap checks both names as
    sources: measured, a swap of a scratch directory with a pinned root is refused in either
    operand order. The rule names four kinds of path. The first is the checkout the child runs
    in. The second is the two scratch roots the seam made, its TMPDIR and the toolchain cache.
    That also stops, at the source, the swaps that free those names for a symlink. The third
    is every ancestor of every grant, up to `/`, because moving an ancestor moves the grant
    inside it. Only an ancestor that some other grant covers could move at all, and the pin
    does not depend on knowing which one does. The fourth is every directory below the
    checkout that holds a `.git`, file or directory, or leads to one: for `.worktrees/s1/.git`,
    `.worktrees` and `.worktrees/s1`. The `.git` itself is already covered by the any-depth
    deny. Seatbelt cannot match "a directory that contains `.git`", and denying unlink on
    every directory under a checkout would stop a build from cleaning its own output. So
    `writeProfile` walks the checkout each time it writes a child's profile. The walk follows no
    link and matches `.git` without regard to case, as the APFS lookup does. It is not cached
    for the run, because pup adds worktrees to the operator's repo while an audit runs. On this
    repo, with seven worktrees and their `node_modules`, the walk takes about a second per
    child; a stage takes seconds to minutes, and children are spawned per stage. Each pin is a
    `literal`, so a child still renames and removes any directory that leads to no `.git`.
    Measured on APFS, a rename that spells the root in another case is refused too. With no
    pins at all the rule is left out, because a bare `file-write-unlink` deny refuses every
    unlink.
    *The exemption.* The caller's `writablePaths` go to `writeProfile` as `outputPaths`. They
    keep the any-depth `.git` deny of a checkout, but their own names are not pinned and they
    are not walked. A failing vitest run removes its empty report directory, and the re-run
    makes it again (decision 108). Pinning that directory would bring back the EPERM decision
    108 fixed. The ancestors of an output are pinned, so the holder pup made around the report
    directory stays put.
    Ceilings. An output a child moves elsewhere takes its contents along. Every current caller
    passes a directory pup made with `mkdtemp`, the TypeScript report directory and the Python
    coverage directory. Neither holds a repo pup's git reads. A caller that passes a repo as an
    output would reopen this hole for that repo. The nested set is what the walk saw when the
    profile was written: a worktree pup adds while the child runs is not pinned for that
    child. A directory the walk cannot read is not walked. A child can still move a repo it
    made in scratch into the checkout, under a name that does not exist yet, since a rename's
    destination is checked only as a new name. pup runs no git in such a directory, and the
    next profile pins it.
    Tests: in `sandbox-utils.test.ts`, under pup's own applied profile, a child that runs the
    whole move, config edit and move back on its git-initialised cwd is refused, and
    `core.hooksPath` stays unset. A second child is refused four moves: its checkout's granted
    parent into TMPDIR, TMPDIR into that grant, the cache into it, and the cache emptied and
    replaced with a link. Moving and removing below those names still works. A third is refused
    the worktree move with its pointer rewrite, and the move of `.worktrees` itself. The pointer
    file is unchanged, and a sibling directory with no `.git` still moves. A fourth is refused a
    `renamex_np` swap of a scratch directory with its checkout, in both operand orders, while
    the same swap of two scratch directories goes through. With the pins emptied, the first two
    fail because the child's command succeeds. Without the walk's pins, the worktree test
    fails. Without the root pins, the swap test fails. In `sandbox-profile-utils.test.ts`, the
    two whole-text goldens carry the rule. An output keeps the `.git` deny, and its holder is
    pinned but its own name is not. No pins means no rule. On a real tree, the walk pins exactly
    `.worktrees`, `.worktrees/s1`, `vendor` and `vendor/lib`. Those lead to a pointer file and to
    a `.GIT` directory; a linked directory holding a repo and a plain directory are not pinned.
