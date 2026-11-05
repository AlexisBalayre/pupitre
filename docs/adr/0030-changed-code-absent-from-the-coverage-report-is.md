# 0030. Changed code absent from the coverage report is flagged, not free (2026-07-25)

- Status: accepted

30. **Changed code absent from the coverage report is flagged, not free (2026-07-25).**
    Closes the loophole decision 29 recorded and deferred. Patch coverage only ever looked
    at changed lines the report mentions, so anything the report omitted counted as zero
    instrumentable changed lines — a PASS. Two ways to reach it, one hostile and one
    ordinary: `coverage.exclude` (or `[tool.coverage.run] omit`) the changed files, or
    simply ship a module no test ever loads. Either way the stage read as green on code
    with no tests at all, which is exactly what decision 13's patch-coverage gate exists
    to prevent.
    The gate cannot judge this alone: "absent from the report" means nothing without
    knowing whether the file is code. So adapters gain `coverableFiles(ctx, files)` — the
    subset of a changed-file list the toolchain would expect coverage for. Both
    implementations drop files that no longer exist, so a deletion stays free by
    construction as decision 13 requires. The exclusion list is deliberately *narrow* and
    matched to what the tools actually exclude: `config` is a valid role suffix in this
    repo, so a blanket `*.config.*` rule would make `src/payments.config.ts` an
    exempt-by-naming hiding place for production code. Named build configs and
    root-anchored artifact directories are excluded; `src/build/`, `src/test/` and
    `packages/tests/` are not.
    Two things this needed to be more than theatre. The stage's own guards were the
    bigger hole: "coverage unavailable" and "report has no instrumentable lines" both
    short-circuited to `skipped` *before* any check ran, and both are session-reachable
    from the worktree's coverage config — so excluding *everything* was free while
    excluding *the changed files* was caught. Changed source plus no measurement is now a
    flag, not a skip. And the TypeScript run pins `--coverage.provider` from the trusted
    manifest, because vitest's `provider: 'custom'` with a session-authored provider
    module hands the gate a forged report — every file present, 100% covered — which then
    ratchets the stored baseline to the forged number.
    It also passes an explicit `--coverage.include`, because vitest 3+ reports only files
    a test loaded. Without it an untested module is *absent* rather than 0%-covered, which
    both weakens the signal (a file-presence flag instead of a precise patch-coverage one)
    and makes every type-only module look hidden — 15 of this repo's 68 source files are
    `*.types.ts`, which no test can ever load because the transform elides type imports.
    Flagging those every merge would train operators to reflexively `--accept-debt`,
    destroying the ledger's meaning along with this gate's.
    Ceilings, stated rather than implied. The flag fires on a file missing from the
    report, not on lines excluded *within* a reported one (`/* istanbul ignore */`,
    `# pragma: no cover`), so a file present with zero instrumented lines still passes.
    Tightening to "present and instrumented" was tried and rejected: with
    `--coverage.include` a type-only module appears with no statements, so that rule
    flags ordinary TypeScript. Python has no equivalent of the provider pin — a worktree
    `conftest.py` can rewrite the JSON report after pytest-cov writes it — and no
    `--coverage.include` equivalent is passed there, so its untested modules surface as
    unreported files rather than 0%-covered ones. `isPythonTestFile` follows pytest's
    *default* `python_files`, which a worktree config can redefine. The custom adapter
    gets no `coverableFiles`, so `.pupitre/adapter.yml` repos keep the old behaviour
    rather than the YAML contract growing a sixth key. In short: this closes the ordinary
    and the narrow-hostile cases and raises the cost of the rest; it is not a proof
    against a determined session, which decisions 28 and 29 already established needs a
    real sandbox.
    Both coverage problems are evaluated rather than short-circuited, so a merge that
    hides files *and* drops the ratio records both in one ledger entry naming every file
    involved. Repo paths reaching a stage detail go through the decision-29 sanitizer
    now too: paths come from `git diff -z` as raw bytes precisely so they are not mangled,
    and a detail is printed to the operator's terminal, fenced into the PR body, and fed
    back to the session as a re-steer prompt.
