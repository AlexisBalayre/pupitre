# 0113. Pup's git pins `core.bigFileThreshold`, a diff's path argument is a literal pathspec, and the gate's hunk and numstat reads pin their inter-hunk context, diff algorithm and rename detection (2026-10-27).

- Status: accepted
- Amends: [0053](0053-a-null-numstat-is-a-measurement-not-a.md)

113. **Pup's git pins `core.bigFileThreshold`, a diff's path argument is a literal
    pathspec, and the gate's hunk and numstat reads pin their inter-hunk context, diff
    algorithm and rename detection (2026-10-27).** Found by the security reviews of
    t-mvqfsrhg and of this task. Five config and naming tricks a session can use bent the
    gate's diff reads, and no diff shows any of them.
    *The threshold.* `core.bigFileThreshold` sits in the shared `$GIT_COMMON_DIR/config` a
    session can write (decision 50). Set to 1, git calls every file binary: `--numstat`
    reads `-\t-` for every text file (reproduced on git 2.39). `--text` still restores the
    `-U0` patch there, so decision 53's recount finds the lines, but each file then lands in
    `forged` when nothing about it is forged, and the review reported the patch losing its
    hunks too, which leaves the recount and `gitDiffAddedLines` at 0 lines. The patch
    coverage and diff-size stages would then be starved. `GIT_SAFE_CONFIG` pins
    `core.bigFileThreshold=512m`, git's default, far above `GIT_MAX_BUFFER`'s 64 MiB, so
    any file pup can read is under it. The pin is in the shared list rather than a
    diff-only argv because `-c` is top-level and the list already reaches every git pup
    runs, codegraph's and the session's `safe_git` included. It only changes how big blobs
    are packed and diffed, which no pup git call relies on.
    *The pathspec.* `diffHunks` runs one diff per changed file, passing its path after
    `--`. Git still parses a path there as a pathspec, so a file named `:(top)foo` was read
    as `foo` with the `top` magic and returned no hunks. `diffHunks` passes
    `--literal-pathspecs`, a top-level flag, which turns off magic and globbing for that
    call. It is the file's only pathspec: `blobIsBinary`'s `<rev>:<path>` is an object
    name, not a pathspec. The flag is not in `GIT_SAFE_CONFIG`: the list holds `-c` pairs
    only, which codegraph's git reads as key and value, and the session hooks' `safe_git`
    passes magic on purpose (`status -- ':(icase).claude'`).
    *The inter-hunk context.* A session-written `diff.interHunkContext=1000` merges `-U0`
    hunks closer than that, so two added lines 100 apart read as one hunk adding lines
    1–102. `patchCoverage` then counts unchanged lines that tests already cover, which can
    lift an untested change over the bar. `diffHunks` passes `--inter-hunk-context=0`.
    *The diff algorithm.* A session-written `diff.algorithm` of `patience` or `histogram`
    anchors only on lines that appear once in each file. When a file's unique first and
    last lines swap around 100 repeated ones, myers reads lines 1 and 102 as added, but
    either of those reads lines 2–102: 101 unchanged lines tests already cover, the same
    lift as above (reproduced on git 2.39). `diffHunks` passes `--diff-algorithm=myers`,
    git's default. `gitDiffNumstat` keeps the operator's algorithm: a non-minimal one only
    inflates the size count, which works against the session.
    *Rename detection.* Under a session-written `diff.renames=copies`, `--numstat` scores a
    new file copied from a file the branch changes as its edits from that file's old
    content: a 300-line copy counted 0 lines and slipped under the oversize flag.
    `gitDiffNumstat` runs with `-c diff.renames=true`, git's default, so a rename is still
    detected and a copy counts as the new file it is. The three pins are on their own call
    rather than in `DIFF_SAFE_FLAGS` or `GIT_SAFE_CONFIG`: those are the only reads where
    the key bends a count, and the other diffs keep the operator's preferences.
    *Tests.* In `git-diff-client.test.ts`, with `core.bigFileThreshold` set to 1 in the
    repo config, `gitDiffNumstat` counts both text files and `gitDiffAddedLines` lists
    their lines. A changed file named `:(top)foo` gets its hunks from `gitDiffAddedLines`
    and the recount. Under `diff.interHunkContext=1000`, two added lines 100 apart stay
    lines 1 and 102. Under `diff.algorithm=patience`, the swap above stays lines 1 and
    102. Under `diff.renames=copies`, a new 300-line file copied from a changed one counts
    300 added lines. Each test fails with its fix removed.
