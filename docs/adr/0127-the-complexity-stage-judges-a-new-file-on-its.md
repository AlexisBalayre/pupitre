# 0127. The complexity stage judges a new file on its own count, against a cap (2026-10-30)

- Status: accepted
- Amends: [0021](0021-debt-delta-three-soft-stages-with-a-merge.md)

127. **The complexity stage judges a new file on its own count, against a cap (2026-10-30).**
    Amends decision 21. The stage compared each touched file's decision points at the target
    with the branch's, and a file the target did not hold read as 0 before. Its whole count was
    then the rise, so any new file past 15 decision points flagged: over a quarter of this
    repo's source files hold more than that (120 files measured on 2026-10-30: median 5, 75th
    percentile 24, 90th 63, largest 401). A session that added an ordinary module was refused
    for debt it had not raised anywhere. *The rule.* A file the target holds keeps the
    `COMPLEXITY_FILE_FLAG_DELTA` (+15) rise. A file absent from the before-measure has nothing
    to rise from, so it is judged on its own count, flagged above `COMPLEXITY_NEW_FILE_FLAG_CAP`
    (50), between the 75th and 90th percentiles above. Both bars sit in
    `merge-gate.constants.ts` and are applied in one place, `judgeComplexity` in
    `debt.service.ts`. A flagged new file is quoted as `path (new file, N decision points)`
    beside the risen files' `path (+N)`, and its whole count joins the flag's points, since the
    repo did gain them. The flag keeps its `Complexity rise` description, which the dashboard's
    debt sheet sorts by (decision 98). The pass detail names both bars. *Not taken.* Judging a
    new file by its largest function: the adapter contract (`FileComplexity`) carries one number
    per file, and every adapter would have to change to report functions. *Ceilings.* The cap
    reads the adapter's absolute scale, which the delta never did: `measureComplexity`'s comment
    that "the absolute scale is free" no longer holds for new files, and a custom adapter
    counting on another scale meets the same 50. A rename or move makes an existing file new
    under its new path, so up to the cap less its current count can land in it unflagged. So can
    a case-only rename on a case-insensitive filesystem (APFS), wherever the before-measure
    misses the file under its new spelling. New files have no total ceiling: N new files of 50
    each pass, and code split out of a file into new ones passes while each stays under the cap.
    "New" is read from the before-measure, not from the target tree. A before-measure that fails
    (a custom command that exits non-zero or prints no JSON array, a read error) errors the
    gate, and the TypeScript adapter, whose parser takes any content, leaves out only non-source
    files and files the main checkout lacks. A custom adapter's command can still return a
    partial list at the target, skipping a file its tool cannot parse, and that existing file is
    then judged against the cap, not the +15 rise. The command and the content are the target's,
    so a session cannot shape that list. Deciding "new" from the target tree (the changed paths
    `git ls-tree` finds at the target sha, with a file the target holds but the before-measure
    omits falling back to a rise from zero) is owed, since it needs `merge-gate.service.ts` and
    the measurement type. docs/04 still reads "complexity delta on touched files", which holds
    for every file the target already has. *Tests* (`debt.test.ts`). An existing file rising by
    exactly 15 passes and by 38 flags. A new file of 20, and one of exactly 50, pass; one of 51
    flags. A risen file and an oversized new one flag together with 80 points between them,
    while a new file of 20 beside them is left out of the flag.
