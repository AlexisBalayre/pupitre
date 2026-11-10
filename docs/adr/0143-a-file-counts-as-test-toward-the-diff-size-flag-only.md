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
    `include` or `exclude` leaves a file the run never collects, which then fails nothing
    however little test it holds. The trusted side alone is not enough, for the reason decision
    31 gives. Neither is read from a disk a session can write. The trusted side is read from
    the tree at `targetSha` (`configSha`, the commit the merge lock holds the main checkout
    at), not from that checkout's disk. The measured side is read from the pinned sha's tree
    (`measureSha`). Both trees are read from the main repo's object store, never from the
    gate checkout's disk: the branch's build and test stages ran code there before the split
    reads it, and could narrow the config the run read, then restore the committed one. The
    run itself read that disk, so the adapter's optional `testInputsIntact` checks it twice,
    once after the build and before any suite and once before the split. It compares the
    checkout's root files that decide the run with the sha's blobs: `package.json`, `.npmrc`,
    `.yarnrc`, `.yarnrc.yml`, `.env.yarn`, every `.pnp.*`, `pnpm-workspace.yaml`,
    `bunfig.toml`, every `vite.config.*`, `vitest.config.*`, `vitest.workspace.*` and
    `vitest.projects.*`, names folded to lower case. It also checks that each entry of the checkout's `node_modules` is still the link to
    the trusted checkout's entry that the gate made, apart from the `.cache` and `.vite*`
    caches vitest writes and a dot-named entry the trusted `node_modules` lacks, such as the
    `.tmp` a `tsc -b` with `tsBuildInfoFile: ./node_modules/.tmp/...` writes: no package can
    be named with a leading dot, so no run loads one. `.bin`, in any case, is the exception,
    since a script runs the binaries in it by name. One changed, added, removed, a link or named in another case at either check,
    or a `node_modules` entry replaced or linked elsewhere, counts no file as test.
    **TypeScript** answers from vitest. The `test` script must be plain `vitest` or `vitest
    run` in both checkouts, with no `pretest` or `posttest` beside it (the `coveredTest` rule
    of decision 95): `vitest run src/core`, another runner or a script around the run collects
    or does something else, and then nothing counts as test. The config is the
    first of `vitest.config.{ts,mts,cts,js,mjs,cjs}` then `vite.config.*` present, vitest's own
    order, read without following a link (a regular file's blob in a tree, a plain file on
    disk outside the gate) and parsed with the TypeScript compiler, never run, by
    `src/adapters/vitest-config.utils.ts`. Root names are matched folded to lower case: a
    case-insensitive disk opens `Vitest.config.ts` for `vitest.config.ts` and a
    case-sensitive one does not, so a config or manifest named in another case, or two names
    that fold to one, leaves the answer unknown, and `Vitest.Workspace.ts` is a workspace
    file. APFS also folds some names outside ASCII onto ASCII by tables no JavaScript case
    mapping reproduces (`ſ` onto `s`, the `NON_ASCII` rule of the split), so it opens
    `viteſt.config.ts` for `vitest.config.ts`: a root holding any name outside ASCII, on disk
    or in a tree, leaves the answer unknown. A root with no config leaves the answer
    unknown: vitest then loads the first config it finds in a directory above the checkout, which a session can write, since it
    runs unsandboxed (decision 5), and no read of the commit sees. The checkout sits in the
    temp directory, and a check of its parents after the run does not prove what they held
    during it. It is read statically: a
    default export that is an object literal, bare or through the `defineConfig` imported from
    `vitest/config` or `vite`, whose `test` holds `include` and `exclude` as arrays of at most
    64 string literals. Anything else that decides what one run collects leaves the answer
    unknown, and unknown collects nothing, the safe direction: a config with a syntax error
    the parser reports, a function config,
    `mergeConfig`, any other callee (a `defineConfig` of the config's own or imported from
    elsewhere included), an identifier, CommonJS, a spread or computed key in the config or its
    `test`, a non-literal `include` or `exclude` (so `[...configDefaults.exclude, 'e2e/**']`
    too), a `root` or a `__proto__` at either level (an object literal's `__proto__` hands it
    inherited keys the read never sees), `test.dir`, `test.projects`, `test.workspace` or
    `test.typecheck` (whose `only` runs type tests alone, so no test-named file runs), or a
    workspace file beside it, under either name vitest 2 and 3 look for, `vitest.workspace.*`
    or `vitest.projects.*`.
    The measured config is the branch's, and vitest runs it, so the run can collect what its
    lists name and still pass a file holding no test. A setup file can register a test in
    every collected file, and a reporter, runner or pool can pass a run that failed. So the
    measured config's lists are read only where the rest of it is the trusted one's: the same
    file name and the same text once each `include` and `exclude` list is cut out, with the
    whitespace and comments before it. A key the branch adds or changes, a value or an import
    leaves the answer unknown, and so does adding a list the trusted config lacks. What the two
    share runs the same code on both sides, so a config that calls
    `availableParallelism()` from `node:os`, as this repo's does, is read. What the shared code
    loads is not, since in the gate it is the branch's file. So these leave the answer unknown
    on either side: a statement that imports or re-exports a module by path (`./`, `../`,
    `/`); a top-level `plugins`; and, under `test`, `setupFiles`, `globalSetup`, `reporters`,
    `environment`, `runner`, `pool`, `poolOptions`, `execArgv` or `sequence`. This reverses
    the earlier rule that a measured config had to be data alone: that rule refused this
    repo's own config on every branch, and it did not stop a data key from naming a branch
    module. A config with no `include` collects vitest's default
    `**/*.{test,spec}.?(c|m)[jt]s?(x)`.
    The script runs under the npm, yarn, pnpm and bun configs at the root, `.npmrc`,
    `.yarnrc`, `.yarnrc.yml`, `pnpm-workspace.yaml` and `bunfig.toml`, with the `.env.yarn`
    Yarn 4 injects into every script's environment by default, and the branch may commit
    them: an `.npmrc` with `node-options=--import ./scripts/reg.mjs` loads a branch file into
    the run, as does a `NODE_OPTIONS` in `.env.yarn`, and `testInputsIntact` cannot see it,
    since a committed file matches its own blob. So those files, by name and text, are compared across the two sides as the
    rest of the config is, and a branch that adds, removes or changes one leaves the answer
    unknown. One the two share may still name a file the branch can rewrite, so on either
    side a config mentioning `yarnPath`, `yarn-path`, `plugins`, `node-options` or
    `nodeOptions`, `script-shell` or `scriptShell`, `preload`, or the
    `injectEnvironmentFiles` that names more env files, leaves the answer unknown, matched
    as text in any case and with `-`, `_` or nothing between the words, so `NODE_OPTIONS`
    and `YARN_YARN_PATH` too. Yarn's Plug'n'Play runtime, any `.pnp.*` at the root, leaves
    the answer unknown on either side: yarn loads it into every script, and it resolves
    packages from a cache the branch may commit, never the `node_modules` the gate links and
    checks. That costs a Yarn Berry repo whose `.yarnrc.yml` names its own binary (one
    corepack starts names none) the split, since its run is the binary's, which is the
    branch's to rewrite, and a Plug'n'Play repo too. Vitest 3's
    default `exclude` (a `node_modules`, `dist`, `cypress`, `.idea`, `.git`, `.cache`,
    `.output` or `.temp` directory, a tool's `*.config.*`), a superset of vitest 4's, applies
    whatever the config declares, since excluding more only counts more as source. A declared
    `exclude` pattern drops a path it matches or any directory above it, as an ignore names a
    directory. A pattern is read in one spelling only: segments of ASCII letters, digits, `_`,
    `-`, `.` and `*` joined by single `/`s, none of them `.` or `..`. Vitest's globber reads
    `./src/prod`, `src/prod/`, `src/./prod` and `src//prod` all as `src/prod`, and takes `?`,
    `\`, braces, classes, extglobs and `!` as glob syntax, which `globToRegExp` escapes, so
    a pattern spelled any other way, or holding whitespace or `@`, may name what the read does
    not: an `include` one collects nothing by it, and an `exclude` one leaves the answer
    unknown. Patterns come from config a
    session writes, or one merge earlier wrote, and are matched against every path on the
    branch inside the merge lock, so a pattern is read only when it runs in time linear in a
    path: each segment `**` or holding at most one `*`, at most one `**` before the last
    segment, at most 16 segments and 256 characters, no `..` and no absolute path, at most 64
    patterns (decision 31's cap; more leave the answer unknown). Each fixed segment after a
    `**` is re-walked every time the `**` gives back a segment, and a `*` gives back one
    character at a time to the literal after it, so a pattern's own length multiplies what a
    path costs: `**/` and two thousand `*/` cost a deep path seconds. Two inner
    `**` cost a path of k segments k squared (`**/b/**/c` against `b/b/b/…`), while a last
    `**` is a `.*$` that matches whatever reaches it. An `include` pattern outside that
    collects nothing; an `exclude` one leaves the answer unknown. An exclude is matched once
    against the whole path, extended to match it up to any `/`, not once per ancestor
    directory, which made a deep path cost its depth times over. A path holding a line break
    (`\n`, `\r`, U+2028, U+2029) is collected by nothing and never reaches a pattern: `.`
    stops at one, so the `.*(?:/.*)?$` an exclude ending `**` becomes would backtrack over
    every `/` before it, quadratically. A file in a
    nested package is its own runner's (decision 58) and is never a root test.
    APFS folds case (decision 78), and checkout writes each path into whichever spelling of a
    directory it created first, so a branch holding `Src/zzz.txt` beside `src/big.test.ts`
    checks the test out as `Src/big.test.ts`, which a case-sensitive `src/**/*.test.ts` does
    not collect, and `src/Fixtures/zzz` beside `src/fixtures/big.test.ts` drops the test
    under an exclude of `**/fixtures/**`. So a path the branch's tree also holds in another
    ASCII case, itself or through one of its directories, is never test, whatever its runner
    answers. The check is decision 139's, now on the branch tree the split reads.
    A collected test is named by its file name without whatever extension it has, no longer
    without `.ts` alone, so the reach check finds `./big.spec.js` naming `big.spec.tsx`.
    **Python does not answer**, and keeps decision 110's rule: every `.py`, `test_*.py`
    included, counts as source. Reading pytest's `python_files` the same way was weighed and
    refused. Vitest fails a collected file with no test in it, so collection proves a file is
    test code. Pytest collects a module with no test and passes it, so a `test_*.py` it
    collects can hold production code and pass the test stage. Counting it as test would
    loosen decision 110, not close its item. A repo whose primary adapter is Python's keeps
    the `*.test.ts` spelling for the TypeScript in it, since the Python adapter has no
    `testFiles`.
    Ceilings, stated. A vitest config that is a link collects nothing, and one named by
    `--config` is never read, as the script rule refuses the flag. In a repo whose `include`
    is wider than this one's, or whose config declares none and so takes vitest's default, more
    spellings than `.test.ts` count as test: `.spec.*`, `.tsx`, `.mts` and the rest the
    `include` names. Each still fails the run if it holds no test. Code loaded by convention or
    by a glob rather than by a specifier that spells its name escapes the reach check, so a
    collected test it loads still counts as test: a Next.js `pages/` or `app/` route, a
    `import.meta.glob('./**/*.spec.ts')`. That is the module-graph item decision 110 still
    owes. A config the two sides share that loads a file some other way than a static
    specifier, a dynamic `import()`, a `require` or a key this does not list, loads the
    branch's file unseen. Lint and a nested package's checks run beside the suites in the same
    writable checkout, so one that rewrites the config while vitest loads it and restores it
    before the last check is not seen. A `node_modules` entry the branch removes is not
    missed, since resolution then climbs to a parent directory's. A package manager reads
    config outside the checkout too, which no read of a commit sees: yarn a `.yarnrc` or
    `.yarnrc.yml` in every directory above it, npm the `.npmrc` of a directory above whose
    `package.json` names the checkout a workspace, pnpm a workspace root above a root
    without its own `pnpm-workspace.yaml`, and each the operator's own config and its global
    one, which the gate's environment leaves where they are. A session can write any of them
    during its merge, since it runs unsandboxed (decision 5), and one it writes reaches the
    run unseen, as it reaches the test stage itself. A root with no vitest config is refused
    for that reason only because a config at the root ends vitest's search, and nothing at
    the root ends yarn's or npm's.
    The gate's own branch is measured
    by the main checkout's adapter (the metric-scope lesson of decision 39), so this change
    first applies to the merge after it lands. Tests: in the config reader, an `include` of
    `src/**` collects `src/a.test.ts` and not `scripts/x.test.ts`, a config with no include
    collects the default spellings past the default exclude, no config at the root is unknown, `vitest.config` wins over `vite.config`, an
    exclude drops a file, a directory and what `**/fixtures/**` names, and an include pattern
    with two stars in a segment, two inner `**`, braces or a leading `./` collects nothing by
    it. Each of these is unknown: a function config, the
    config's own `defineConfig` wrapper, one imported from elsewhere, another import aliased to
    the name, a run-time include, an include or exclude over 64 patterns, an exclude over 16
    segments or 256 characters, a spread exclude, a
    braced exclude, an exclude with a `!`, a `..` or an absolute path, an exclude spelled
    `./src/prod`, `src/prod/`, `src/./prod`, `src//prod`, with a `?`, a backslash, whitespace
    or an `@`, an empty exclude pattern, a config that does not parse, a spread `test`, a
    shorthand, getter or twice-named include, `projects`, `test.workspace`, `dir`,
    `test.root`, `typecheck`, a `__proto__` under `test` or at the top, a top-level `root`,
    an import or re-export of a file, `plugins`, `setupFiles`, `globalSetup`, `reporters`, an
    `environment`, a `runner`, a `pool`, `poolOptions`, `execArgv` and a sequencer. A
    workspace file is unknown too, `vitest.workspace.*` or `vitest.projects.*` named in any
    case, and a config that is a
    symlink or named in another case is not read, nor a root holding a name outside ASCII,
    on disk or in a commit. Read from a commit, the config is the tree's whatever the disk holds, and one committed as a link or beside a name that folds
    to it is not read. A config that runs code and imports a package is read. Two configs
    that differ only inside their lists give one rest, while another key, another value, an
    assignment in a value, another import, an added exclude or another file name each give
    another. A path holding any of the four line breaks is collected by nothing, in linear
    time. In the adapter, a
    narrowing script, another runner, a `pretest`, a `posttest` and a manifest that is not
    JSON each collect nothing, and a nested package's test is not a root test. A branch whose
    config is the trusted one, though it runs code, collects. One that sets another key,
    changes a value or adds a setup file collects nothing. The same `.npmrc` on both sides
    collects; one only the branch commits or rewrites collects nothing, as does an
    `.env.yarn` only the branch commits, and so does a shared `.npmrc` with `node-options`,
    `node_options` or `script-shell`, `.yarnrc` with `yarn-path`, `.yarnrc.yml` with
    `yarnPath`, `plugins` or `injectEnvironmentFiles`, `.env.yarn` with `NODE_OPTIONS`,
    `pnpm-workspace.yaml` with `nodeOptions`, `bunfig.toml` with `preload`, or `.pnp.cjs`. A
    root with no config collects nothing, nor a branch root holding a name outside ASCII. A
    branch narrowing its include or excluding a file drops it. The measured config is read from the pinned sha and the trusted
    one from the target sha, whatever either checkout's disk holds. `testInputsIntact` holds
    for an untouched checkout, a build output beside it, a `node_modules` linked as the gate
    links it, holding a vite cache or holding a `.tmp` build output the trusted one lacks,
    and outside the gate. It fails for a rewritten config,
    an added `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.env.yarn`, `.pnp.cjs`, `pnpm-workspace.yaml`
    or `bunfig.toml`, an added name outside ASCII, a removed manifest, a config made a link,
    a manifest renamed into another case, a `node_modules` entry replaced by a package or linked elsewhere, a `.bin` of its own in
    either case, a dot-named link replaced by an entry of its own, and a `node_modules` that is
    itself a link. In the split, a collected test under a directory the tree also holds in
    another case, `src/` beside `Src/` or `fixtures/` beside `Fixtures/`, counts as source. In the gate,
    `scripts/x.test.ts` outside the trusted include counts as source while `src/a.test.ts`
    counts as test, with a second adapter claiming every file not asked, every file counts as
    source where only the branch's config imports its `defineConfig` from elsewhere, a
    collected `big.spec.tsx` production code imports by `./big.spec.js` counts as source while
    an uncollected `a.test.ts` does too, a file renamed and rewritten onto a collected name
    from one not collected counts as source, a deleted collected test counts as test, and every file counts as source where the build
    narrows the config and the test stage restores it, or the build adds an `.npmrc`.
