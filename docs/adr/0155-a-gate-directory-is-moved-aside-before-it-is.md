# 0155. A gate directory is moved aside before it is removed, and a grant must end in a name (2026-11-08)

- Status: accepted
- Amends: [0108](0108-a-sandbox-grant-is-resolved-up-to-its.md)

155. **A gate directory is moved aside before it is removed, and a grant must end in a name (2026-11-08).**
    Two Lows from the t-mvqve712 security review.
    *The grant.* Decision 108 resolves a grant up to its last name and never through it.
    `grantPath` took any string, though. An empty or relative path resolved against pup's own cwd, and
    one ending in `.`, `..` or a slash had a last name the resolve went through, which is the case
    decision 108 exists to prevent. `writeProfile` now throws unless the path is absolute,
    `normalize(path) === path`, and its last segment is a name, not empty, `.` or `..`.
    *The removal.* `removeGateDir` first renames the directory into a fresh `pup-removing-*`
    directory beside it, then deletes that whole. A child granted a path under the directory (the
    coverage holder's `report`, the Python adapter's report directory, the run's scratch) could
    survive the group kill under `setsid` and swap an entry between a directory and a link to `HOME`
    while the recursive delete walked it. Grants name paths, so once the directory has a name no grant
    covers, nothing such a child does reaches what is deleted. A path that is already gone is no
    failure. A rename that fails is reported, as a failed delete is (decision 95), and the delete is
    not tried in place. A delete that fails deletes nothing more, so what it left is renamed back and
    stays where the report and the operator expect it.
    *Ceiling.* The rename needs the directory's parent to be one no child is granted. Every caller's
    parent is the temporary directory today. A child that already holds a descriptor inside the tree
    can still write through it after the rename, but under a path no rule allows, so the sandbox
    refuses the write.
