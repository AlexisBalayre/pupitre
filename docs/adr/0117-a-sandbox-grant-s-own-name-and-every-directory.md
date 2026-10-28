# 0117. A sandbox grant's own name and every directory above it cannot be unlinked or renamed, except a caller's output directory, which keeps its name free (2026-10-28).

- Status: accepted

117. **A sandbox grant's own name and every directory above it cannot be unlinked or renamed,
    except a caller's output directory, which keeps its name free (2026-10-28).**
    The t-mvqve712 security review found by reading the profile that a grant covers its own
    name, so a child may rename it. Reproduced under the generated profile on macOS: in
    `pup init` and `pup audit` the child's cwd is the operator's repo. The child ran `mv` on
    the repo into its TMPDIR, where decision 36's `.git` deny does not reach because it is
    scoped to the checkout's path. There it ran `git config core.hooksPath`, then moved the
    repo back. The repo's `.git/config` then carried the hook path for pup's next unsandboxed
    git call (decision 28). The direct write was refused as before. A hard link from scratch to
    a file under `.git` was refused too, so the rename was the only way in.
    *The pin.* `writeProfile` ends the profile with one `(deny file-write-unlink (literal ...))`
    rule. A rename checks its source against `file-write-unlink`, as `rmdir` and `unlink` do,
    so the rule stops a move as well as a removal. It names three kinds of path. The first is
    the checkout the child runs in. The second is the two scratch roots the seam made, its
    TMPDIR and the toolchain cache. That also stops, at the source, the swaps that free those
    names for a symlink. The third is every ancestor of every grant, up to `/`, because moving
    an ancestor moves the grant inside it. Only an ancestor that some other grant covers could
    move at all, and the pin does not depend on knowing which one does. Each pin is a `literal`,
    so a child still renames and removes anything below a root. Measured on APFS, a rename that
    spells the root in another case is refused too. With no pins at all the rule is left out,
    because a bare `file-write-unlink` deny refuses every unlink.
    *The exemption.* The caller's `writablePaths` go to `writeProfile` as `outputPaths`. They
    keep the any-depth `.git` deny of a checkout, but their own names are not pinned. A failing
    vitest run removes its empty report directory, and the re-run makes it again (decision
    108). Pinning that directory would bring back the EPERM decision 108 fixed. The ancestors of
    an output are pinned, so the holder pup made around the report directory stays put.
    Ceiling: an output a child moves elsewhere takes its contents along. Every current caller
    passes a directory pup made with `mkdtemp`, the TypeScript report directory and the Python
    coverage directory. Neither holds a repo pup's git reads. A caller that passes a repo as an
    output would reopen this hole for that repo.
    Tests: in `sandbox-utils.test.ts`, under pup's own applied profile, a child that runs the
    whole move, config edit and move back on its git-initialised cwd is refused, and
    `core.hooksPath` stays unset. A second child is refused four moves: its checkout's granted
    parent into TMPDIR, TMPDIR into that grant, the cache into it, and the cache emptied and
    replaced with a link. Moving and removing below those names still works. With the pins
    emptied, both tests fail because the child's command succeeds. In
    `sandbox-profile-utils.test.ts`, the two whole-text goldens carry the rule. An output
    keeps the `.git` deny, and its holder is pinned but its own name is not. No pins means
    no rule.
