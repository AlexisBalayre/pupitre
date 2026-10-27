# 0023. Patch coverage lands as the fourth soft stage (2026-07-24), closing decision 13

- Status: accepted

23. **Patch coverage lands as the fourth soft stage (2026-07-24), closing decision 13.**
    The adapter `coverage` capability runs the suite instrumented (vitest with a
    declared @vitest/coverage-v8|istanbul provider, JSON reporter into a temp dir) and
    returns per-file covered/instrumented line sets; `undefined` (missing tooling,
    failed run) degrades to skipped "not measured". The gate takes the branch's
    added/modified lines from per-file `-U0` diffs, keeps only lines carrying
    instrumented statements — types, comments, and deletions are free by
    construction — and flags when covered/instrumented falls below the baseline
    repo-wide ratio (minus a float epsilon). Flags follow diff-size semantics
    (decision 17); every merge stores the measured repo ratio (decision 21 ratchet).
    Known trade-off: the instrumented run re-executes the suite after the plain test
    stage; folding coverage into the test capability (the docs/06 shape) is deferred.
