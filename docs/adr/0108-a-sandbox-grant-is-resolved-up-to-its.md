# 0108. A sandbox grant is resolved up to its own name and never through it, and the folded coverage run's report directory sits inside a directory of the gate's own that no child is granted (2026-10-27).

- Status: accepted

108. **A sandbox grant is resolved up to its own name and never through it, and the folded
    coverage run's report directory sits inside a directory of the gate's own that no child is
    granted (2026-10-27).**
    On 2026-10-23 the gate's test stage for t-mvb3b6zo (#170) failed on vitest's
    `V8CoverageProvider.clean`, a `mkdir` of `/var/folders/.../T/pup-coverage-5bebhi` refused with
    EPERM, and t-mvcgnwul's gate had hit the same failure on its re-run earlier. The cause was the
    gate's own sequence, not another run. Vitest defaults `reportOnFailure` to false, so a run
    with a failing test calls `cleanAfterRun`, which removes `.tmp` and then the reports directory
    it left empty. Decision 94's re-run then spawns a second child, whose profile `writeProfile`
    writes afresh. `resolvePath` resolves a path that exists and uses a missing one as given, so
    the grant read `/var/folders/...`, from `os.tmpdir()`. The kernel checks the resolved
    `/private/var/folders/...`, which that rule never matches. The re-run's `clean` could not make
    the directory again, and a flaky first run that the re-run would have passed failed the stage
    with EPERM. Load, such as the `pup audit` running beside #170's gate, only made the first
    failure likelier. Nothing removes another run's directory: an audit's coverage run makes its
    own, decision 100's `tempDir` removes only what its test made, and `endSandboxRun` removes only
    its run's scratch and profile directories. The child's TMPDIR plays no part either: the report
    directory sits outside it, and it is resolved already.
    The security review of the first fix found the same re-profiling could be turned into a
    widening. A grant covers its own name, so a child can remove it and leave a symlink there.
    With a session's test failing on purpose, its `process.on('exit')` handler can do that after
    vitest's cleanup, and the re-run's profile then followed the link and granted its target,
    `HOME` or `/opt/homebrew/bin` included. Main had the same hole with its unresolved
    directory.
    *The grant.* `writeProfile` now names each grant through `grantPath`: its parent resolved,
    its own name appended unread. A real directory comes out as before. A missing grant or a
    symlink keeps its own name, unfollowed, so writes through a link resolve to a target no rule
    matches, and a removed grant still matches what the kernel checks. So the grant can only ever
    be the path the caller named. The name is never read, not even to tell a directory from a
    link. A first version checked it with `lstat` and then resolved it with `realpath`. A
    descendant that called `setsid()` escapes the group SIGKILL (decision 100's ceiling), so it
    can outlive its run and keep swapping the name between a directory and a link. Against such a
    loop, the reviewer's copy of that version returned the target 257 times in 117,496 calls.
    The parent is still followed, so a grant's parent must be one no child is granted. `resolvePath` is unchanged for its other readers, the toolchain cache key
    and the TMPDIR base.
    *The report directory.* `instrumentedRun` makes `pup-coverage-*` with `mkdtemp` and `report`
    inside it. `report` is vitest's `reportsDirectory` and the only grant. The holder is never
    granted, so no child can remove it, free its name or swap it for a link, and `dispose` removes
    it. When `report` cannot be made, the holder is removed before the error goes on. The grant is
    still one directory the gate made, now one level deeper. The Python adapter's `coverage`
    grants its `mkdtemp` directory itself, which the seam rule now covers, and it runs once,
    never behind a re-run.
    Ceiling: a caller grant whose parent a child or a session's commit can rewrite still resolves
    through that parent. A nested package's stage `cwd`, `join(checkoutDir, pkg.dir)`, may be
    one when `pkg.dir` has more than one segment and the session's commit made an outer segment a
    link. That path resolved fully before this change as well. It is not verified here and is
    left to a task of its own, which the conductor has filed.
    Tests: in `sandbox-profile-utils.test.ts`, a symlink at a grant when the profile is written
    is granted as the link and not its target. A grant that is gone and one that is a directory,
    each named through the unresolved TMPDIR, are both granted under the resolved parent. In
    `typescript-adapter.test.ts`, under pup's own applied profile: a child given the folded run's
    grants removes its report directory, as a failing run does, and a second child makes it again
    and writes the report. A child that swaps the directory for a link to another directory
    leaves the next child refused a write through it. A child cannot remove the holder. With
    `grantPath` taken out, the two link tests, the gone-grant test and the re-run test fail: the
    re-run on `Operation not permitted`, the adapter's link test on a write that landed in the
    link's target. The directory case is the control and passes either way.
