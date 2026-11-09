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
    reason decision 31 gives. The trusted checkout is the operator's checkout (`configPath`,
    the gate's `repoPath`), read as it stands on disk, not the tree at `targetSha`.
    **TypeScript** answers from vitest. The `test` script must be plain `vitest` or `vitest
    run` in both checkouts, with no `pretest` or `posttest` beside it (the `coveredTest` rule
    of decision 95): `vitest run src/core`, another runner or a script around the run collects
    or does something else, and then nothing counts as test. The config is the
    first of `vitest.config.{ts,mts,cts,js,mjs,cjs}` then `vite.config.*` present, vitest's own
    order, read as a plain file without following a link and parsed with the TypeScript
    compiler, never run, by `src/adapters/vitest-config.utils.ts`. It is read statically: a
    default export that is an object literal, bare or through the `defineConfig` imported from
    `vitest/config` or `vite`, whose `test` holds `include` and `exclude` as arrays of at most
    64 string literals. Anything else that decides what one run collects leaves the answer
    unknown, and unknown collects nothing, the safe direction: a function config,
    `mergeConfig`, any other callee (a `defineConfig` of the config's own or imported from
    elsewhere included), an identifier, CommonJS, a spread or computed key in the config or its
    `test`, a non-literal `include` or `exclude` (so `[...configDefaults.exclude, 'e2e/**']`
    too), a `root` or a `__proto__` at either level (an object literal's `__proto__` hands it
    inherited keys the read never sees), `test.dir`, `test.projects`, `test.workspace` or
    `test.typecheck` (whose `only` runs type tests alone, so no test-named file runs), or a
    `vitest.workspace.*` beside it.
    The measured config is the branch's, and vitest runs it, so a static read of it can be
    wrong: a branch can add a plugin whose `config` hook pushes an `exclude` at run time, or
    assign one onto `Object.prototype` inside a value. So it is read only where running it
    builds the object the read sees and does nothing else. Every statement but the default
    export must be an import from `vitest/config` or `vite`, and the exported object must be
    data alone: object and array literals, spreads, string, number, boolean and `null`
    literals, names and property reads. A call, function, assignment, operator, template,
    parenthesis or computed key anywhere in it leaves the answer unknown. The trusted config is
    the operator's, and is read as written, whatever else it holds. No config collects vitest's default `**/*.{test,spec}.?(c|m)[jt]s?(x)`. Vitest 3's
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
    segment, no `..` and no absolute path, at most 64 patterns (decision 31's cap; more leave
    the answer unknown). Two inner
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
    `--config` is never read, as the script rule refuses the flag. In a repo whose `include`
    is wider than this one's, or which has no config and so takes vitest's default, more
    spellings than `.test.ts` count as test: `.spec.*`, `.tsx`, `.mts` and the rest the
    `include` names. Each still fails the run if it holds no test. Code loaded by convention or
    by a glob rather than by a specifier that spells its name escapes the reach check, so a
    collected test it loads still counts as test: a Next.js `pages/` or `app/` route, a
    `import.meta.glob('./**/*.spec.ts')`. That is the module-graph item decision 110 still
    owes. A measured config that runs code, as this repo's does (`availableParallelism()` from
    `node:os` sets `maxWorkers`), is unknown on every branch, so there every test file counts
    as source, the `.test.ts` files decision 110 counted as test included. Such a repo gets
    the split back by making its config data.
    The gate's own branch is measured
    by the main checkout's adapter (the metric-scope lesson of decision 39), so this change
    first applies to the merge after it lands. Tests: in the config reader, an `include` of
    `src/**` collects `src/a.test.ts` and not `scripts/x.test.ts`, no config collects the
    default spellings past the default exclude, `vitest.config` wins over `vite.config`, an
    exclude drops a file, a directory and what `**/fixtures/**` names, and an include pattern
    with two stars in a segment, two inner `**` or braces collects nothing by it. Read as the
    trusted checkout's, the laxer side, each of these is unknown: a function config, the
    config's own `defineConfig` wrapper, one imported from elsewhere, another import aliased to
    the name, a run-time include, an include or exclude over 64 patterns, a spread exclude, a
    braced exclude, an exclude with a `!`, a `..` or an absolute path, a spread `test`, a
    shorthand, getter or twice-named include, `projects`, `test.workspace`, `dir`,
    `test.root`, `typecheck`, a `__proto__` under `test` or at the top, and a top-level
    `root`. A workspace file is unknown too, and a config that is a symlink is not read. Another
    import, a call or an assignment in a value, a plugin hook and a plugin built by `eval` are
    each read in the trusted checkout and unknown in the measured one, while a measured config
    of data, with an imported name, a spread and a property read, is read. In the adapter, a
    narrowing script, another runner, a `pretest`, a `posttest` and a manifest that is not
    JSON each collect nothing, a config calling `availableParallelism()` is read in the
    trusted checkout and collects nothing in the measured one, a nested package's test is not
    a root test, and a branch narrowing its include or excluding a file drops it. In the gate,
    `scripts/x.test.ts` outside the trusted include counts as source while `src/a.test.ts`
    counts as test, with a second adapter claiming every file not asked, every file counts as
    source where only the branch's config imports its `defineConfig` from elsewhere, a
    collected `big.spec.tsx` production code imports by `./big.spec.js` counts as source while
    an uncollected `a.test.ts` does too, a file renamed and rewritten onto a collected name
    from one not collected counts as source, and a deleted collected test counts as test.
