# 0110. The diff-size flag counts source lines only (2026-10-26)

- Status: accepted
- Amends: [0017](0017-diff-size-flag-blocks-unless-accept-debt.md)

110. **The diff-size flag counts source lines only (2026-10-26).**
    Amends decision 17. The stage summed every changed line but lockfiles and binaries, so a
    session that wrote the tests its acceptance criteria asked for, or the decision record and
    doc fix its task named, was flagged as oversize for doing so: a 227-line change with 360
    lines of tests and 85 of docs read as 672 and refused to merge without `--accept-debt`. The
    flag is a proxy for how much production code one review has to hold, and tests and prose are
    not that. Now `countChangedLines` splits the count into source, test and docs, the 600-line
    flag (`DIFF_SIZE_FLAG_LINES`) applies to source alone, and the stage detail names the split,
    `227 source + 360 test + 85 docs changed lines`, on a pass and a flag alike. Lockfiles stay
    excluded and a forged binary is still recounted and flagged at any size (decision 53), into
    whichever part its path names. A test file is only a `*.test.ts`, the one spelling decision
    39 trusts: what a vitest `include` conventionally collects, so production code parked there
    fails the test stage. `*.spec.*`, `.test.mts`, `.test.tsx`, `.test.js` and pytest's
    `test_*.py` and `*_test.py` import as ordinary modules and fail nothing when they hold no
    tests, so they count as source. A file renamed onto a test name from a name that was not one
    counts as source too, or `git mv big.ts big.test.ts` plus a rewrite would carry production
    code in under the test count. The rename is read from the branch's `--raw` diff with `-M`,
    never left to `diff.renames`, which sits in the shared config a session can write. A
    `*.test.ts` that non-test code reaches counts as source as well: one test behind `if
    (process.env.VITEST)` passes vitest, so 2000 lines of exports beside it, imported from
    production as `./big.test.js`, read as "0 source + 2000 test" (found on the second security
    review). A `git grep` on the branch lists the files naming a changed test, and every one is
    read but prose under `docs/`, whatever its extension: a Vue or Svelte component, a Vite
    `index.html` or a `package.json` loads a module as well as code does. Each token whose last
    segment, less a `?` or `#` suffix (`./big.test.js?raw`) and a JS or TS extension, spells a
    test's name claims every test of that name, the safe direction. A relative specifier is not
    resolved: `resolveImport` tried the literal path first, so a decoy `big.test.js` holding
    `export {}` took `./big.test.js` and hid `big.test.ts` behind it, and resolving only ever
    narrowed what the name already claims. A test file naming one is followed in turn, so a
    re-export chain through other test files reaches it too. The grep runs with colour pinned
    off (`--no-color`, `-c color.ui=never -c color.grep=never`): `color.grep=always` in the
    shared config wrapped each `-l` path in escapes, every importer then failed what was a
    source-file check, the reach check passed everything as test, and a listing entry that does
    not start with the branch now refuses the gate rather than being skipped. A token is a run
    between quotes or whitespace, matched in one pass by a single class with nothing after it to
    backtrack into, and each name a file spells is looked up once. A regex with an unanchored
    leading class backtracked quadratically on one long unspaced line and held the merge lock
    for minutes on a 1 MB file (both found on the third security review), and weighing every
    token against every target made a million-token line naming 200 same-named tests cost 200
    million lookups. A `*.test.ts` whose name holds whitespace, a quote, `?` or `#` counts as
    source, since no token spells it whole. Docs are prose under `docs/` at the repo root: `.md`,
    `.rst` and `.adoc`. Projects keep running code under `docs/` (Sphinx's `conf.py`, swag's
    `docs/docs.go`), `.mdx` compiles to a component, and `.txt` takes in `requirements.txt` and
    `CMakeLists.txt`, so those count as source. So does `.md` there when a
    `docusaurus.config.*` sits anywhere on the branch: Docusaurus reads root `docs/` by default
    and compiles `.md` as MDX, so `docs/big.md` can export code `src/` imports from
    `@site/docs/big.md`. A symlink counts as source wherever it sits, and so does any changed
    doc or test a symlink on the branch reaches: `src/pkg/impl.py -> ../../docs/impl.md` ran
    2000 lines of Python counted as docs, and `src/impl.ts -> big.test.ts` imported a test file
    no token names, as `git grep` never reads a link's blob. Each link's target is read from the
    branch tree and resolved lexically from the link's directory; it reaches the path it lands
    on and everything under it. One whose target is absolute, lands outside the repo, or has a
    `..` after a named segment may land anywhere and reaches every path: `l/../impl.md` lands
    on a decoy `src/impl.md` read lexically, which is how Node's `realpath`, and so the gate's
    link check, reads it, but on `docs/impl.md` through `l -> ../docs/sub` (the Vue, decoy,
    lookup, name, Docusaurus and reached-link rules came from the fourth security review; the
    test name, rename, docs and link rules from the review of the first cut, which took every
    JS/TS, Python and Go test spelling and every path under `docs/`). Leaving them out of the
    size is not leaving them out of the gate: the scope audit and review still see every
    changed path, and the oversize ledger entry still names every changed file. The entry keeps
    its `Oversize diff (N lines)` wording, now with the source count, so a re-gate still reads
    an entry filed before this as the same kind (decision 86). The review queue's
    `changedLines` and risk keep counting every changed line: they estimate what a reviewer
    reads, tests and docs included. `docs/04-gates-and-debt.md` described the stage as "diff
    size vs task size", which the code never had; it now says what is counted. Owed, each its
    own task. A `*.test.ts` outside the runner's `include` (here anything outside `src/**`)
    still counts as test, and closing that needs the trusted checkout's runner config from the
    adapters (vitest's `include`, pytest's `python_files` from both checkouts, decision 31's
    pattern). Production code reaching a test file through a specifier that does not spell its
    name still counts it as test until the gate reads the module graph rather than names: one
    built at run time (`import('./big' + '.test.js')`), an alias mapped in package.json
    `imports` or tsconfig `paths` (`"#t/*": "./src/*.test.ts"` with `import '#t/big'`), and a
    string or URL escape in a static one (`from './big\u002etest.js'`, `'./big%2Etest.js'`).
    Prose loaded as code without a link still counts as docs: a textual include
    (`#include "../docs/impl.md"`, Rust's `include!`) and a Markdown compiler other than
    Docusaurus (VitePress and VuePress run a page's `<script setup>`). The flag is per merge, so
    a test or doc landed in one merge and made source in a later one, by a rename, a copy or one
    new import, counts only that later merge's delta; closing it means counting an unchanged
    file a merge newly reaches at full size. And `gitDiffNumstat` leaves copy detection to
    `diff.renames` in the shared config, where `copies` pairs a new file with the one it was
    copied from and counts only the delta; pinning `-M` there is `git-diff.client.ts`'s change.
    The tab-in-path item this listed is closed by decision 111. Tests: a 227/360/85 split
    passes with that detail, a 700-line test-only diff passes, 601 source lines flag whatever
    the tests add, every test spelling but `.test.ts` counts as source and so does a
    `.test.ts` named with a space or `#`, a test file production code names by a relative
    re-export, a `#` dynamic import, a `?raw` or `#x` suffix, a Vue component or a Vite
    `index.html` counts as source, as does one reached through two other test files, one named
    with grep colour forced on in the shared config and one behind a decoy at the literal path,
    while one only tests or `docs/` prose name stays a test, a 1 MB unspaced line and a
    million-token line naming 200 same-named tests read without stalling, code, `.mdx`,
    `requirements.txt`, a symlink and a `src/docs/` file count as source while `.md` and `.rst`
    under `docs/` count as docs, `.md` there counts as source beside a Docusaurus config, the
    doc, test and directory a link reaches count as source and a link climbing past a named
    segment makes every path source, a source file renamed onto a test name counts as source
    with rename detection on and off in the shared config while a test renamed onto a test
    stays a test, a root lockfile counts nothing and a lockfile-named file elsewhere still
    counts.
