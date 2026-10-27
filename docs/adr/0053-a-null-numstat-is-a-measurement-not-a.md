# 0053. A null numstat is a measurement, not a free skip (2026-09-17)

- Status: accepted

53. **A null numstat is a measurement, not a free skip (2026-09-17).** Decision 41 stated the
    ceiling: a `* -diff` line makes `git diff --numstat` emit `-\t-` for every file, `--text`
    does not restore it, and `countChangedLines` skipped a null count as a real binary — so a
    5 000-line diff counted zero, the `diff-size` stage passed and the review-queue risk score
    floored. Reproduced before anything was written, against Apple Git 2.39.5, and with two
    surfaces decision 50's refusal does not cover. `info/attributes` is refused at the gate,
    but the review queue runs no refusal, and **`core.attributesFile`** in the shared config
    points git at a `* -diff` file anywhere; **`core.bigFileThreshold=1`** does the same with
    no attribute at all. Neither names a command, so neither belongs in `armedGitDrivers`.
    *The patch cannot tell a forged null from a real one.* Decision 41's proposed fix was "a
    file git calls binary but which has parsed hunks is forged". It is not: `--text -U0` parses
    hunks out of a real binary too — a committed file holding `x\0y\n` yields `@@ -1 +1 @@` like
    any other — so that rule would flag every image a session commits and the skip for a real
    binary would be gone. The discriminator is the one git itself uses before anything tells it
    otherwise: a NUL in the first 8000 bytes (`buffer_is_binary`). `gitDiffBinaryRecount` reads
    both sides of the merge-base diff with `git cat-file blob`; binary on either side is a real
    binary and stays free, text on both is a forged null, recounted from the `--text -U0` hunk
    headers — adds *and* deletes, because the metric is both, and because keying on
    `gitDiffAddedLines` alone would miss a forged file that only deletes. The 8000 is
    load-bearing in the other direction: reading the whole blob would let a session append one
    NUL past git's window and have a text file it had also forged read as binary. Each rule has
    a discriminating test, proven by removing it: without the recount the forged diff passes,
    without the content check a real binary is flagged, and with the whole blob read the late
    NUL counts as binary.
    *Recounted and flagged, at any size.* The recount alone makes the size honest again, so a
    small forged diff would pass on a true count. It still flags, naming the files, because a
    text file git was told to call binary is a write no diff and no scope audit showed — the
    same "loud" decision 50 chose — and the operator decides with `--accept-debt`, which records
    it as its own ledger entry beside an oversize one. The review queue takes the recounted
    number and nothing else: its risk score is a size, and it is a size again.
    *The functional cost, stated.* A repo whose tracked `.gitattributes` legitimately marks a
    text format `binary` or `-diff` (a minified bundle, a generated SVG) now has those files
    counted toward the diff size and the stage flagged on every merge that touches them. The
    gate cannot tell a tracked attribute from a session-written one without reading every
    attribute source git consults, which is the list this decision just found to be longer than
    it looked. Loud, and the right direction: the alternative is a gate a session can zero.
    *Ceilings.* `buildSessionReview`'s per-file `files` list is still raw `gitDiffNumstat`, so
    the review detail shows a forged file as `-`; the stat type lives outside this change's
    scope, and the queue entry above it carries the true count. A file larger than the 64 MiB
    buffer throws, as the coverage stage's patch read already does — loud, not free.
