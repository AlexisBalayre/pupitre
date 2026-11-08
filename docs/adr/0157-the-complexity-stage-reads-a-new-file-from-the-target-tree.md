# 0157. The complexity stage reads a new file from the target tree (2026-11-08)

- Status: accepted
- Amends: [0145](0145-the-complexity-stage-judges-a-new-file-on-its.md)

157. **The complexity stage reads a new file from the target tree (2026-11-08).**
    Amends decision 145, which read "new" from the before-measure and git's pairing, and owed
    reading it from the target tree as task t-mvv19qls. Under 145 an existing file that the
    before-measure left out was judged against `COMPLEXITY_NEW_FILE_FLAG_CAP` (50), not the
    +15 rise. Take a custom command at the target that returns a partial list, or `[]`: a file
    of 10 decision points could then grow to 50 with no flag. That gap was a fail-open.
    *The rule.* The gate lists the target sha's tree with `git ls-tree -r -z --name-only`
    through `runGit`, the same pinned git as every other gate read. It keeps the changed paths
    that list holds and passes them to `judgeComplexity` as `complexity.targetHolds`. Each
    touched file then gets the first of these that applies:
    - The file is in the before-measure: it keeps the +15 rise from that count.
    - Git paired the file with a source the before-measure has: it rises from the source's count (decision 145).
    - The target holds the file: it rises from zero. An existing file the before-measure
      leaves out is read the harshest way again, as it was before decision 145.
    - The target lacks the file: only then is it new, and judged against the cap.
    The tree is listed only when an adapter measures complexity, as the pairing pass is.
    *What it closes.* Two of 145's five ways for an existing file to drop out stop reaching the
    cap. One is a partial custom command. The other is a session writing the main checkout,
    since the tree is read from the target sha's objects, not from the files on disk. The
    other three still do:
    - A rename or copy rewritten past git's 50% pairing threshold.
    - A copy pass that ran out of time.
    - A rename whose source the before-measure skips.
    In each of these the new path is absent from the target's tree, so it is new by this rule
    too.
    *Not taken.* Passing the changed paths to `ls-tree` as pathspecs. Git reads a pathspec's
    magic and globs, so a path such as `src/[id].ts` could match more or less than itself.
    The full listing compared as strings has no such reading.
    *Tests.* In `debt.test.ts`, an empty before-list with a file the target holds flags at
    +16. A file the target lacks still passes at 40 under the cap, even when another path is
    held. In `merge-gate.test.ts`, a real-git gate run uses a custom adapter that returns `[]`
    at the target. The existing file grown by 20 flags as +20. A new file of 20 beside it
    stays unflagged.
