# 0180. A gate stage's cwd is granted only when it resolves under the gate's checkout, checked in `writeProfile` on the string the profile names (2026-11-13).

- Status: accepted
- Amends: [0108](0108-a-sandbox-grant-is-resolved-up-to-its.md)

180. **A gate stage's cwd is granted only when it resolves under the gate's checkout, checked in
    `writeProfile` on the string the profile names (2026-11-13).**
    Decision 108 left a ceiling. `grantPath` resolves a grant's parent, so a caller's grant whose
    parent a child can rewrite resolves through it. A nested package's stage cwd is
    `join(checkoutDir, pkg.dir)`. When `pkg.dir` comes from `git ls-tree`, each of its segments is
    a real directory when the checkout is cut. The build and root test stages then run session
    code with the checkout writable, so they can replace an outer segment, such as `packages`,
    with a link to a directory that holds the same inner name, such as the main checkout's own
    `packages/<x>`. The package's next stage then had its profile grant that target, and wrote to
    the main checkout. `resolvePath` did the same before decision 108. The security review of
    t-mvl9b0p2 found it.
    *The check.* `grantWithin(path, root)` is `grantPath(path)`, refused unless the result is the
    resolved `root` or under it. The refusal names both the path and what it resolves to.
    `GateChildOptions` takes an optional `root`, and `writeProfile` takes it as a fifth argument.
    With a `root`, the checkout grant goes through `grantWithin`, so the path that is checked is
    the path the profile names. A check before the spawn, in the merge gate, would leave a window
    before `grantPath` resolves the parent again. Lint runs alongside the nested stages with the
    checkout writable, and a build descendant can outlive its run (decision 100's ceiling), so
    either could swap the segment in that window. After the check, a link swapped in changes
    nothing, because the profile names resolved paths and the kernel matches resolved paths.
    `measureBranch` passes `root: checkoutDir` for every stage. The root's own stages resolve to
    the checkout itself and pass as before. A refusal is the stage's failure, with the refusal as
    its detail, and is never re-run, because it carries no runner exit status. Where pup does not
    write a profile (`inherited`, `declared-vm`), `gateInvocation` makes the same check, so a
    stage refused under one mode is refused under all of them.
    Ceiling: only the gate passes a `root`. Capabilities and `pup init`/`pup audit` children run
    with the measured checkout or the main checkout as cwd, never a path below a segment a child
    can rewrite, so they pass none. The last name of a cwd is still never read, and a link there
    is granted as the link, as decision 108 has it.
    Tests: in `sandbox-profile-utils.test.ts`, a grant under a link out of the root is refused
    with the path and its target named, and no profile is written. The root itself and a nested
    package under it, each named through the unresolved TMPDIR, are granted under the resolved
    root. In `merge-gate.test.ts`, a build that replaces `src/packages` with a link to the main
    checkout's own `src/packages` fails the package's test stage on the refusal, and the stage's
    command never runs in the target. With the build leaving the tree alone, the same package's
    stage passes and the gate merges.
