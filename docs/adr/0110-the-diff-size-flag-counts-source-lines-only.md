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
    code in under the test count. The rename is read from the branch's `--raw` diff with `-M`
    and `-l0`, never left to `diff.renames` or `diff.renameLimit`, which sit in the shared
    config a session can write: a limit of 1 skipped inexact pairing once a second file was
    added. A
    `*.test.ts` that non-test code reaches counts as source as well: one test behind `if
    (process.env.VITEST)` passes vitest, so 2000 lines of exports beside it, imported from
    production as `./big.test.js`, read as "0 source + 2000 test" (found on the second security
    review). A `git grep` on the branch lists the files naming a changed test, and every one is
    read but prose under `docs/`, whatever its extension: a Vue or Svelte component, a Vite
    `index.html`, a `package.json` or a serverless config loads a module as well as code does.
    Each token that, in any case, is a test's name, or is one up to a dot, where an extension
    (`big.test.js`) or a serverless handler's export (`src/big.test.handler`) starts, claims
    every test of that name, the safe direction: the grep runs with `-i`, as APFS, the gate's
    filesystem (decision 78), opens `./BIG.test.js` as `big.test.ts`. Each importer is read with
    `core.precomposeUnicode` pinned off, as decision 114 pins the gate's other per-file reads:
    on macOS an NFD `src/café.ts` naming `./big.test.js` was read as its NFC sibling holding
    `export {}`, and the test went unreached. A path git lists in bytes that are not UTF-8 reads
    back with `U+FFFD` in their place, so `src/\xe9.ts` read as a decoy committed at
    `src/\ufffd.ts`; such an importer names every test it was listed for, unread. A relative
    specifier is not
    resolved: `resolveImport` tried the literal path first, so a decoy `big.test.js` holding
    `export {}` took `./big.test.js` and hid `big.test.ts` behind it, and resolving only ever
    narrowed what the name already claims. A test file naming one is followed in turn, so a
    re-export chain through other test files reaches it too. The grep runs with colour pinned
    off (`--no-color`, `-c color.ui=never -c color.grep=never`): `color.grep=always` in the
    shared config wrapped each `-l` path in escapes, every importer then failed what was a
    source-file check, the reach check passed everything as test, and a listing entry that does
    not start with the branch now refuses the gate rather than being skipped. A token is a run
    of the characters a name may hold, a letter, a digit or `_ . $ + @ -`, and every other
    character ends one, so a name reads whole after a `/`, a quote or `=` and before a `?`, a
    `#`, a `>`, a script's `;`, `&&` or `)`, a list's `,` or a YAML `]`: `./big.test.js?raw`,
    `./x#y/big.test.js` (which `require` reads literally), an unquoted `src=./page.test.ts>`,
    `tsx src/big.test.ts;` and `[big.test.ts]` all spell it, with no list of delimiters to keep
    up (the fifth and sixth reviews each found one missing). One class with nothing after it to
    backtrack into matches the tokens in one pass, only dots within the longest name are tried,
    and each name a file spells is looked up once. A regex with an unanchored leading class
    backtracked quadratically on one long unspaced line and held the merge lock for minutes on a
    1 MB file (both found on the third security review), and weighing every token against every
    target made a million-token line naming 200 same-named tests cost 200 million lookups. A
    `*.test.ts` whose name holds any other character counts as source, since no token spells it
    whole: a space, `#`, `=`, Next's `[id].test.ts`, and a letter outside ASCII, whose other
    Unicode forms APFS opens alike and no byte search finds. Docs
    are prose under `docs/` at the repo root: `.md`, `.rst` and `.adoc`. Projects keep running
    code under `docs/` (Sphinx's `conf.py`, swag's `docs/docs.go`), `.mdx` compiles to a
    component, and `.txt` takes in `requirements.txt` and `CMakeLists.txt`, so those count as
    source. So does `.md` there when a `docusaurus.config.*` in any ASCII case sits anywhere on
    the branch, or a dependency file in any ASCII case names Docusaurus, since `docusaurus build
    --config site.config.js` takes a config under any name: a `package.json`, `package.yaml` or
    `package.json5` by its `@docusaurus/core` dependency or a `docusaurus` script, or a lockfile
    listing it. A symlink under one of those names counts as naming it, as no grep reads a
    link's blob, and so does any file named with a character outside ASCII: git's `icase`
    pathspec and a JavaScript `/i` without `u` fold ASCII only, while APFS opens `pacKage.json`,
    spelled with the Kelvin sign (U+212A), as `package.json` and `docuſaurus.config.ts` as
    `docusaurus.config.ts`. Docusaurus reads root `docs/` by default and compiles `.md` as MDX,
    so `docs/big.md` can export code `src/` imports from `@site/docs/big.md`. A symlink
    counts as source wherever it sits, and so does any changed doc or test a symlink on the
    branch reaches: `src/pkg/impl.py -> ../../docs/impl.md` ran 2000 lines of Python counted as
    docs, and `src/impl.ts -> big.test.ts` imported a test file no token names, as `git grep`
    never reads a link's blob. Each link's target is read from the branch tree up to its first
    NUL, as checkout's `symlink()` takes a C string (a blob `big.test.ts\0x` landed nowhere and
    left the test it reaches counted as test), resolved lexically from the link's directory and
    compared case-folded, as APFS opens `../../DOCS/impl.md` as `docs/impl.md`; it reaches the
    path it lands on and everything under it. One whose target is absolute, lands outside the
    repo, or has a `..` after a named segment may land anywhere and reaches every path:
    `l/../impl.md` lands on a decoy `src/impl.md` read lexically, which is how Node's
    `realpath`, and so the gate's link check, reads it, but on `docs/impl.md` through
    `l -> ../docs/sub`. So does one whose path or target holds a character outside ASCII, and a
    changed path holding one counts as source whatever reaches it: APFS folds `ſ` onto `s` and
    `ς` onto `σ` by its own tables, which no JavaScript case mapping or normalization
    reproduces, so `src/pkg/impl.py -> ../../docſ/impl.md` and `docſ/impl.py -> impl.md` landed
    on `docs/impl.md` unseen, as did `../docs/secret.md` on `docs/ſecret.md` (the non-ASCII and
    `U+FFFD` rules came from the eighth security review; the link's NUL cut, the lockfile,
    `package.yaml`, `package.json5` and linked-manifest rules and the `-l0` pin from the
    seventh; the name-character token, the dot rule and the importer's `core.precomposeUnicode`
    pin from the sixth; the case folding and the Docusaurus `package.json` rule from the fifth;
    the Vue, decoy, lookup, name, Docusaurus and reached-link rules from the fourth; the test
    name, rename, docs and link rules from the review of the first cut, which took every JS/TS,
    Python and Go test spelling and every path under `docs/`). Leaving them out of
    the size is not leaving them out of the gate: the scope audit and review still see every
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
    `imports` or tsconfig `paths` (`"#t/*": "./src/*.test.ts"` with `import '#t/big'`), a string
    or URL escape in a static one (`from './big\u002etest.js'`, `'./big%2Etest.js'`), and a
    character APFS folds onto an ASCII one of the name, which no byte search finds (`ſ` for `s`,
    the Kelvin sign for `k`). Prose loaded as code without a link still counts as docs: a
    textual include (`#include "../docs/impl.md"`, Rust's `include!`), a Markdown compiler other
    than Docusaurus (VitePress and VuePress run a page's `<script setup>`), and Docusaurus run
    under another config name where no dependency file on the branch names it plainly: a global
    install a Makefile drives, or dependency files naming it only through an escape
    (`"@docusaur\u0075s/core"`), which `package-lock.json`, being JSON, and `pnpm-lock.yaml`, in
    a double-quoted YAML string, take as a manifest does. The flag is per merge, so
    a test or doc landed in one merge and made source in a later one, by a rename, a copy or one
    new import, counts only that later merge's delta; closing it means counting an unchanged
    file a merge newly reaches at full size. The tab-in-path and `gitDiffNumstat` copy-pairing
    items this listed are closed by decisions 111 and 113. Tests: a 227/360/85 split passes with
    that detail, a 700-line test-only diff passes, 601 source lines flag whatever the tests add,
    every test spelling but `.test.ts` counts as source and so does a `.test.ts` named with a
    space, `#`, `=`, `é` or `[id]` while `+page.test.ts` stays a test, a test file production
    code names by a relative re-export, a `#` dynamic import, a specifier in another case, a
    `?raw` or `#x` suffix, a `#` in a directory, a Vue component, a Vite `index.html` with its
    `src` quoted or not, a script ending the name at `;`, `&&` or `)` or starting it after `,`,
    a YAML list with or without a directory, a serverless handler, an NFD importer beside an NFC
    sibling or an importer git lists by a path that is not UTF-8, beside a decoy at `U+FFFD`,
    counts as source, as does one reached through two other test files, one named with grep
    colour forced on in the shared config and one behind a decoy at the literal path, while one
    only tests or `docs/` prose name stays a test, a 1 MB unspaced line and a million-token line
    naming 200 same-named tests read without stalling, code, `.mdx`, `requirements.txt`, a
    symlink and a `src/docs/` file count as source while `.md` and `.rst` under `docs/` count as
    docs, `.md` there counts as source beside a `docusaurus.config.ts`, a
    `Docusaurus.config.js`, a `Package.json`, `package.yaml` or `package.json5` naming
    `@docusaurus/core`, a `pnpm-lock.yaml`, `package-lock.json` or `yarn.lock` listing it, a
    `package.json` that is a symlink, or a file named with the Kelvin sign or `ſ`
    (`pacKage.json`, `docuſaurus.config.ts`), the doc, test and directory a link reaches, in any
    case and with its target cut at a NUL, count as source, and so do a doc and a test named
    with `ſ` that ASCII links reach and a test under `λόγος` a `λόγοσ` link reaches, a link
    climbing past a named segment or holding `ſ` in its target or directory makes every path
    source, a source file renamed onto a test name counts as source with rename detection on and
    off and the rename limit at 1 in the shared config (where the numstat, which leaves the
    limit to that config, also counts the delete) while a test renamed onto a test stays a test,
    a root lockfile counts nothing and a lockfile-named file elsewhere still counts.
