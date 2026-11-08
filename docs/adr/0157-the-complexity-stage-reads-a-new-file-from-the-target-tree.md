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
    through `runGit`, the same pinned git as every other gate read. It keeps the paths that
    list holds out of the changed paths plus every rename or copy pair's source, the same set
    the before-measure covers, and passes them to `judgeComplexity` as
    `complexity.targetHolds`. Each touched file then gets the first of these that applies:
    - The file is in the before-measure: it keeps the +15 rise from that count.
    - Git paired the file with a source the before-measure has: it rises from the source's count (decision 145).
    - The target holds the file, or its paired source: it rises from zero. An existing file
      the before-measure leaves out is read the harshest way again, as it was before decision
      145, and so is a file renamed or copied from one.
    - The target lacks both the file and any source: only then is it new, and judged against
      the cap.
    The tree is listed only when an adapter measures complexity, as the pairing pass is.
    *What it closes.* The target sha's tree, not the before-measure, now decides whether a file
    is new. Three of 145's five ways for an existing file to drop out no longer make it new:
    - A partial custom command at the target.
    - A rename or copy whose source the before-measure skips. The source is in the target's
      tree, so the new path rises from zero. A non-source file renamed to a source name, such
      as `.txt` to `.ts`, now counts its whole count as a rise.
    - A session writing the main checkout. A file it removes there is still in the target
      sha's objects.
    The before-count still comes from the main checkout, though, so a session that writes there
    can still inflate it and make a rise read smaller. This decision settles only which files
    are new, not how high a file stood before.
    Two ways remain, and in each the new path has no pair, so the target tree lacks it and it
    is new by this rule too:
    - A rename or copy rewritten past git's 50% pairing threshold.
    - A copy pass that ran out of time.
    *Not taken.* Passing the changed paths to `ls-tree` as pathspecs. Git reads a pathspec's
    magic and globs, so a path such as `src/[id].ts` could match more or less than itself.
    The full listing compared as strings has no such reading.
    *Tests.* In `debt.test.ts`, an empty before-list with a file the target holds flags at
    +16. A file the target lacks still passes at 40 under the cap, even when another path is
    held. A rename, and a copy of an unchanged file, each at 50 with an omitted source the
    target holds, flag at +50. In `merge-gate.test.ts`, real-git gate runs use a custom adapter
    that returns `[]` at the target. The existing file grown by 20 flags as +20, and a new file
    of 20 beside it stays unflagged. A renamed file and a copy of a file the branch never
    changed, each at exactly the cap of 50, both flag at +50.
