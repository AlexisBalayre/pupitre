# 0081. The gate's stages run on a private detached checkout of the pinned sha (2026-10-13, closes decision 80's stages gap)

- Status: accepted

81. **The gate's stages run on a private detached checkout of the pinned sha (2026-10-13, closes
    decision 80's stages gap).** After decision 80 the gate landed one pinned sha, but build,
    test, lint, the nested-package stages and every debt capability still ran with `cwd` and
    `measurePath` set to the session's worktree, which the live session can edit while they run,
    so the stages could pass on edited files while the pinned, untested sha landed, and the
    baseline ratchet came from those files. Now, right after the pin, `gateAndMerge` cuts a
    detached checkout of that sha and every stage and capability reads it, `cwd` and
    `measurePath` both; tool config is still read from the main checkout (decision 29), and the
    scope audit and the diffs already named the sha.
    *Where it lives.* Not under the project's state dir beside the conductor's checkout
    (decision 51), as first planned: the sandbox denies every gate child reads and writes under
    `~/.pupitre`, which holds the store (decision 36), so a stage there cannot even resolve its
    own working directory (found in the first test run). It is `checkout` inside a fresh
    `mkdtemp` directory under the resolved temp dir, cut per gate under
    the merge lock and removed in a `finally` that runs before the lock is released, on a pass, a
    failed stage and a thrown gate alike: the directory goes with `rmSync` and the registration
    with `git worktree prune`. A failure to remove it is swallowed, so it never replaces the
    gate's outcome or error; the registration then waits for a prune after the directory is
    gone.
    *How it is cut.* `git worktree add --detach --no-checkout`, then `read-tree --reset -u` with
    `--work-tree`, `--no-sparse-checkout` and `--no-recurse-submodules`, for `fastForward`'s
    reasons: `core.worktree` in the shared config would aim the writes elsewhere, and a planted
    `core.sparseCheckout` would leave out committed files no stage would then see. The checkout
    runs a smudge filter on every file it writes, so `assertNoArmedGitDrivers` runs on the main
    checkout right before it, a third time, since the auto-rebase is a window the live session
    controls. A submodule is not checked out, as the fast-forward never recursed into one.
    *The ceiling.* The checkout is at the OS-user ceiling decisions 47 and 63 name: a session
    running as the same user can list it and write to it. What this closes is the worktree the
    session owns and edits as a matter of course, not a same-user attack.
    *Dependencies.* The gate's checkout sits outside the repo, so Node's walk up from it reaches
    no `node_modules`. It gets a real `node_modules` holding a link to every entry of the main
    checkout's, and never the session worktree's own, though a stage in the worktree used to
    resolve that one first: the session can write its worktree's `node_modules` (the pre-commit
    hook installs a real one there, `.bin` and `.pnpm` included), so a live session could
    rewrite `.bin/vitest` or `.bin/tsc` while the stages run and fake a pass, which would defeat
    this decision (operator must-fix on review). The consequence, accepted: a branch that changes
    its dependencies fails its stages until the operator installs them in the main checkout.
    The same per-entry linking covers every touched nested package (decision 59), from
    `<repo>/<pkg>/node_modules`, since a standalone package resolves from its own directory;
    every environment is linked before any stage runs, because a stage runs session code with
    the checkout writable and a link made after it could follow a swapped-in parent out of the
    checkout (found on review). A `node_modules` the pinned tree commits is kept like any
    committed file, a vendored one included; every committed symlink in the pinned tree, inside
    `node_modules` or anywhere else, is resolved once after the cut and the tree refused if one
    reaches outside the checkout — a dangling one judged by where it points, so `.env ->
    .env.local` on the target branch is kept — since a stage would read through it into the
    session's worktree (found on review). A vendored regular file such as `.bin/vitest` is the
    branch's own content and the operator's to review, not the gate's: that is the ceiling.
    *The Python ceiling.* No `.venv` is linked, and Python stages fail closed in the checkout
    until a later decision gives them an environment. Linking the main checkout's was tried on
    review and withdrawn for two reasons: an editable install (`poetry install`, `uv sync`)
    leaves a `.pth` naming the main checkout's source root, so the tests would import the
    trusted code and pass on a broken branch, the one outcome this decision exists to prevent;
    and `uv run` syncs into the environment it finds, which through the links is the main
    checkout's.
    Not one link to the whole directory, which was the first shape and failed this repo's own
    test stage in the sandbox: vite writes `.vite-temp` beside the packages, the sandbox matches
    resolved paths, and through the link the write landed on a checkout it keeps read-only.
    `.cache` and the `.vite*` entries are left out, so the caches start empty and are written in
    the checkout. Nothing commits there, so nothing is staged, and it goes with the checkout.
    Verified by running this repo's build, test and lint through `runGateChild` on such a
    checkout of `main`: all three pass, and no worktree entry is left.
    Tests drive `runMergeGate`: the worktree edited from an adapter's in-process `gateCommands`
    after the cut leaves the build stage and the dead-code capability reading the pinned file;
    the checkout and its registration are gone after a pass, a failed stage and a thrown gate;
    the main checkout's packages are linked into a `node_modules` of the checkout's own, with no
    cache, even when the worktree has a `node_modules` of its own;
    a planted `core.sparseCheckout` still checks out every committed file; drivers armed as the
    auto-rebase ends are refused before any stage, with no smudge run; a checkout a stage made
    unremovable leaves the outcome standing. Two existing tests change because they encoded the
    old contract: the capability context's `measurePath` and the nested-package `pwd` now name
    the gate's checkout, not the worktree.
