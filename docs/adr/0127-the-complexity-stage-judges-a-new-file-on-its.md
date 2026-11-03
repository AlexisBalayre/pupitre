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
    counting on another scale meets the same 50. New files have no total ceiling: N new files of
    50 each pass, and code split out of a file into new ones passes while each stays under the
    cap. "New" is read from the before-measure, not from the target tree, so an existing file
    that drops out of the before list is judged against the cap, not the +15 rise. Before this
    decision a missing entry was the harshest reading, a rise from zero; now it is the most
    lenient. A before-measure that fails (a custom command that exits non-zero or prints no JSON
    array, a read error) errors the gate, and the TypeScript adapter, whose parser takes any
    content, leaves out only non-source files and files the main checkout lacks. Three ways
    remain for an existing file to drop out. A rename or move: the file is new under its new
    path, so a rise of up to the cap less its current count lands unflagged (a file of 10
    renamed and grown to 50 passes), and so does a case-only rename on a case-insensitive
    filesystem (APFS) wherever the before-measure misses the new spelling. A partial custom
    command: the target's command can return a partial list, skipping a file its tool cannot
    parse, or spell a path differently from the after side. This is the before side only: the
    built-in adapters measure both sides over the same `git diff -z` paths, and the before
    command and content are the target's, so a session cannot shape that list. A session writing
    the main checkout: the before-measure reads the main checkout, so a file a session removes
    there reads as absent. Deciding "new" from the target tree is owed, as task t-mvv19qls: a
    file gets the cap only when the target sha's tree, read with the gate's pinned git, lacks
    its path, and a file the target holds but the before-measure omits keeps the rise from zero.
    It needs `merge-gate.service.ts` and the measurement type, outside this task's scope.
    docs/04 still reads "complexity delta on touched files", which holds for every file the
    target already has. *Tests* (`debt.test.ts`). An existing file rising by exactly 15 passes
    and by 38 flags. A new file of 20, and one of exactly 50, pass; one of 51 flags. A risen
    file and an oversized new one flag together with 80 points between them, while a new file of
    20 beside them is left out of the flag. The rename ceiling is pinned: a file of 10 that
    leaves the before list and returns at 50 under a new path passes.
