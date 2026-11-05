# 0032. A coverage report holds only files coverage is expected for (2026-07-27)

- Status: accepted

32. **A coverage report holds only files coverage is expected for (2026-07-27).** Found by
    turning the stage on for pupitre itself, which is the first time any of the coverage
    decisions ran against this repo. `pup audit` recorded a baseline of **32.8%** where the
    real figure is **68.1%**, and chasing the gap turned up two defects in decision 30's
    `--coverage.include`, both invisible to the unit tests because both are about which files
    the glob reaches.
    The include exists so an unloaded module appears as 0%-covered instead of absent. It also
    **overrides vitest's default excludes**: without it the report has 50 files and no test
    files, with it 103 files including all 35 test files, each instrumented and wholly
    uncovered. Those 1802 lines halve the repo ratio. Worse, `patchCoverage` counts any added
    line the report instruments, so every added test line counted as uncovered — **writing
    tests lowered a PR's patch coverage**, exactly inverting what decision 13's bar is for.
    The PR that landed immediately before this one added 117 test lines and would have been
    flagged for it.
    The second defect only appears in the checkout that sets the baseline. `**/*.ts` from the
    main checkout descends into `.worktrees/`, so every open session's copy of every source
    file joins the report: measuring main with one worktree open gave 136 files against a
    worktree's 68. The repo's ratio moved with how many sessions happened to exist, and the
    baseline is recorded from main while the gate measures in a worktree — so the two sides of
    every comparison had different denominators. This is why the same code reported 68 files
    in one checkout and 103 in another, which is what exposed the whole thing.
    Both are answered in `istanbulToCoverageReport`, which already dropped entries resolving
    outside the repo, by dropping `isCoverageExcluded` files too. That is deliberately the
    *same predicate* `coverableFiles` uses to decide what coverage is expected for, so the
    report and the expectation cannot drift apart: a file the gate would never flag as
    unreported also cannot drag the ratio down. Filtering in pup rather than passing
    `--coverage.exclude` keeps it outside the worktree's reach, consistent with decision 30
    pinning the provider. `.worktrees/` joins the exclusion list not because it is generated
    but because it is another checkout of the same repo; the Python adapter already skips it
    in `COMPILEALL_EXCLUDE` and `VULTURE_EXCLUDE` for the same reason.
    Both checkouts now report 68 files and 0.6814. Ceiling: the excluded files are still
    instrumented by vitest before pup discards them, so the run does more work than it needs
    to — correctness first, and the waste is bounded by the include glob.
    The lesson is decision 26's, sharpened: PR-mode merges never ratchet, so the post-merge
    `pup audit` is the only thing that writes a baseline, and it runs in the one checkout
    where `.worktrees/` exists. A metric can be unit-tested, reviewed, and still wrong in the
    only place it is ever recorded.
