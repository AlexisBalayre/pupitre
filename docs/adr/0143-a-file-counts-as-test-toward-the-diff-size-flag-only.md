# 0143. A file counts as test toward the diff-size flag only where the test stage's runner collects it (2026-11-07)

- Status: accepted
- Amends: [0110](0110-the-diff-size-flag-counts-source-lines-only.md)

143. **A file counts as test toward the diff-size flag only where the test stage's runner
    collects it (2026-11-07).** Closes the first item decision 110 owed. A test was the
    `*.test.ts` spelling decision 39 trusts because a vitest `include` conventionally collects
    it, so production code parked there fails the test stage with "No test suite found". That
    is true only inside the `include`: here it is `src/**/*.test.ts`, so `scripts/big.test.ts`
    was collected by nothing, failed nothing, and counted 2000 lines of code as test. An
    adapter now has an optional `testFiles(ctx, files)` capability saying which of `files` its
    test stage collects as test modules, answered by path alone so the old path of a rename is
    answered too, and `countChangedLines` takes it as an optional fourth argument, asks it
    once for every path on the branch, every changed path, deletions included (a deleted test
    is on no branch path), and every path a rename left, and counts as test only what it
    names, still under a name a token can spell and never renamed onto from one it does not
    name. The gate asks the primary adapter alone: one repo has one test stage, run by the
    adapter that detected first (decision 22), and a second adapter's runner never runs, so
    what it would collect proves nothing. An adapter without the capability (a custom one, or
    the gate's test stubs) keeps the `*.test.ts` spelling, and so does the review queue's
    estimate, which passes none.
    Both checkouts answer, as decision 31 has `python_files` answer for coverage, and a file
    is a test only where both collect it: the trusted checkout is what the gate trusts, and the
    measured one is what the stage's run actually reads, so a branch that narrows its own
    `include` or adds an `exclude` leaves a file the run never collects, which then fails
    nothing however little test it holds. The trusted side alone is not enough, for the
    reason decision 31 gives.
    **TypeScript** answers from vitest. The `test` script must be plain `vitest` or `vitest
    run` in both checkouts (the `coveredTest` rule of decision 95): `vitest run src/core` or
    another runner collects something else, and then nothing counts as test. The config is the
    first of `vitest.config.{ts,mts,cts,js,mjs,cjs}` then `vite.config.*` present, vitest's own
    order, read as a plain file without following a link and parsed with the TypeScript
    compiler, never run. It is read statically: a default export that is an object literal,
    bare or through `defineConfig`, whose `test` holds `include` and `exclude` as arrays of
    string literals. Anything else that decides what one run collects leaves the answer unknown,
    and unknown collects nothing, the safe direction: a function config, `mergeConfig`, an
    identifier, CommonJS, a spread or computed key in the config or its `test`, a non-literal
    `include` or `exclude` (so `[...configDefaults.exclude, 'e2e/**']` too), a `root` at either
    level, `test.dir`, `test.projects` or `test.workspace`, or a `vitest.workspace.*` beside it.
    No config collects vitest's default `**/*.{test,spec}.?(c|m)[jt]s?(x)`. Vitest 3's
    default `exclude` (a `node_modules`, `dist`, `cypress`, `.idea`, `.git`, `.cache`,
    `.output` or `.temp` directory, a tool's `*.config.*`), a superset of vitest 4's, applies
    whatever the config declares, since excluding more only counts more as source. A declared
    `exclude` pattern drops a path it matches or any directory above it, as an ignore names a
    directory. Patterns are matched by `globToRegExp`, which escapes braces, classes and
    extglobs rather than honouring them, so an `include` using one collects nothing by it, and
    an `exclude` using one, or a `!`, leaves the answer unknown. They come from config a
    session writes, or one merge earlier wrote, and are matched against every path on the
    branch inside the merge lock, so a pattern is read only when it runs in time linear in a
    path: each segment `**` or holding at most one `*`, at most one `**` before the last
    segment, no `..` and no absolute path, at most 64 patterns (decision 31's cap). Two inner
    `**` cost a path of k segments k squared (`**/b/**/c` against `b/b/b/…`), while a last
    `**` is a `.*$` that matches whatever reaches it. An `include` pattern outside that
    collects nothing; an `exclude` one leaves the answer unknown. An exclude is matched once
    against the whole path, extended to match it up to any `/`, not once per ancestor
    directory, which made a deep path cost its depth times over. A file in a
    nested package is its own runner's (decision 58) and is never a root test.
    A collected test is named by its file name without whatever extension it has, no longer
    without `.ts` alone, so the reach check finds `./big.spec.js` naming `big.spec.tsx`.
    **Python does not answer**, and keeps decision 110's rule: every `.py`, `test_*.py`
    included, counts as source. Reading pytest's `python_files` the same way was weighed and
    refused. Vitest fails a collected file with no test in it, so collection proves a file is
    test code. Pytest collects a module with no test and passes it, so a `test_*.py` it
    collects can hold production code and pass the test stage. Counting it as test would
    loosen decision 110, not close its item.
    Ceilings, stated. A vitest config that is a link collects nothing, and one named by
    `--config` is never read, as the script rule refuses the flag.
    The gate's own branch is measured
    by the main checkout's adapter (the metric-scope lesson of decision 39), so this change
    first applies to the merge after it lands. Tests: in the TypeScript adapter, an `include`
    of `src/**` collects `src/a.test.ts` and not `scripts/x.test.ts`, no config collects the
    default spellings past the default exclude, `vitest.config` wins over `vite.config`, an
    exclude drops a file, a directory and what `**/fixtures/**` names, an include pattern with
    two stars in a segment or two inner `**` collects nothing, a
    narrowing script, another runner, a function config, a run-time include, a spread exclude,
    a braced exclude, a spread `test`, `projects`, `dir`, `root` and a workspace file each
    collect nothing, and a branch narrowing its include or excluding a file drops it; in the
    gate, `scripts/x.test.ts` outside the trusted include counts as source while
    `src/a.test.ts` counts as test, with a second adapter claiming every file not asked, a
    collected `big.spec.tsx` production code imports by `./big.spec.js` counts as source while
    an uncollected `a.test.ts` does too, a file renamed and rewritten onto a collected name
    from one not collected counts as source, and a deleted collected test counts as test.
