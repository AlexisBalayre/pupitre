# 0145. The complexity stage judges a new file on its own count, against a cap (2026-11-07)

- Status: accepted
- Amends: [0021](0021-debt-delta-three-soft-stages-with-a-merge.md)

145. **The complexity stage judges a new file on its own count, against a cap (2026-11-07).**
    Amends decision 21. The stage compared each touched file's decision points before and
    after, and read a file missing from the before-measure as 0. Its whole count then became
    the rise, so any new file over 15 decision points was flagged. Over a quarter of this
    repo's source files hold more than that: of 120 files measured on 2026-10-30, the median
    was 5, the 75th percentile 24, the 90th 63 and the largest 401. A session that added an
    ordinary module was refused for debt it had raised nowhere. Redoes PR #216, which was
    closed before it landed.
    *The rule.* A file in the before-measure keeps the `COMPLEXITY_FILE_FLAG_DELTA` (+15)
    rise. So does a file git pairs as a rename or a copy: it rises from its source path's
    count. The gate reads the pairs from `git diff -z --raw -M -C -C -l0` over the target and
    the gated sha. These flags are passed on the command line, so the `diff.renames` and
    `diff.renameLimit` a session can write into the shared config do not apply. The doubled
    `-C` pairs a copy of any file the target holds, even one the branch never changed. The
    before-measure then covers the changed paths plus every pair's source. The diff-size
    stage keeps its own `-M`-only call, so a copy still counts there as added lines (decision
    113). Only a file that is absent from the before-measure and has no pair is judged on its
    own count. It is flagged above `COMPLEXITY_NEW_FILE_FLAG_CAP` (50), which sits between
    the 75th and 90th percentiles above. Both bars live in `merge-gate.constants.ts`, and one place applies
    them: `judgeComplexity`, inside `judgeDebt` in `debt.service.ts`, the module the gate's
    debt verdict already shares (decision 72). `pup init` stores no complexity bar, so the
    gate is this rule's only reader. A flagged new file is quoted as
    `path (new file, N decision points)` next to the risen files' `path (+N)`. Its whole count
    joins the flag's points, since the repo did gain them. The flag keeps its
    `Complexity rise` description, which the dashboard's debt sheet sorts by (decision 98).
    The pass detail names both bars.
    *Not taken.* Judging a new file by its largest function. The adapter contract
    (`FileComplexity`) carries one number per file, so every adapter, the custom command's
    output shape included, would have to change to report functions.
    *Ceilings.*
    The cap reads the adapter's absolute scale, which the delta never did. The JSDoc on
    `measureComplexity` in `src/adapters/typescript-debt.utils.ts`, "the absolute scale is
    free", is now false for new files. It sits outside this task's scope and stays owed. A
    custom adapter that counts on another scale meets the same 50.
    New files have no total ceiling. N new files of 50 points each pass, and so does code
    split out of a file into new ones, as long as each stays under the cap.
    "New" is read from the before-measure and git's pairing, not from the target tree. An
    existing file that drops out of both is therefore judged against the cap, not the +15
    rise. Before this decision a missing entry got the harshest reading, a rise from zero;
    now it gets the most lenient. A before-measure that fails errors the gate: a custom
    command that exits non-zero or prints no JSON array, or a read error. The TypeScript
    adapter, whose parser takes any content, leaves out only non-source files and files the
    main checkout lacks. That leaves four ways for an existing file to drop out:
    - A rename or copy rewritten past git's pairing threshold. Git pairs two paths only
      when their contents are at least 50% similar, so a renamed or copied file whose content
      is mostly rewritten reads as a delete plus an add, and the new path meets the cap. A
      file of 10 points can therefore grow to 50 unflagged, as long as most of its text
      changes along the way.
    - A rename whose source the before-measure skips. A non-source file renamed to a source
      name, such as `.txt` to `.ts`, pairs with a source the TypeScript adapter never
      measures, so the new path meets the cap.
    - A partial custom command. On the before side, the target's command can return a
      partial list, skipping a file its tool cannot parse, or spell a path differently from
      the after side. The built-in adapters measure both sides over the same `git diff -z`
      paths. The before command and its content are the target's, so a session cannot shape
      that list.
    - A session writing the main checkout. The before-measure reads the main checkout, so a
      file a session removes there reads as absent.
    Deciding "new" from the target tree is owed as backlog task t-mvv19qls: a file gets the
    cap only when the target sha's tree, read with the gate's pinned git, lacks its path, and
    a file the target holds but the before-measure omits keeps the rise from zero. docs/04 still reads "complexity delta on touched files", which holds for every
    file the before-measure has.
    *Tests.* In `debt.test.ts`, an existing file that rises by exactly 15 passes, and one
    that rises by 38 flags. A new file of 20 passes, and so does one of exactly 50; one of 51
    flags. A risen file and an oversized new one flag together with 80 points between them,
    while a new file of 20 beside them stays out of the flag. A file of 10 renamed or copied
    and grown to 50 flags as +40, and a copy grown by 15 passes. In `merge-gate.test.ts`, a
    real-git gate run renames one file and copies another the branch never changed, grows
    each by 40, and flags both as +40. With `-C -C` dropped, that test fails.
