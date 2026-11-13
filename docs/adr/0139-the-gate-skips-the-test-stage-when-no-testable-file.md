# 0139. The gate skips the test stage when no testable file changed (2026-11-07)

- Status: accepted

139. **The gate skips the test stage when no testable file changed (2026-11-07).**
    A one-line change to a `.github` workflow (t-mw4pvd2a-1) waited 10 minutes for the
    load (decision 88) and then ran the full suite past its 10-minute cap
    (`GATE_COMMAND_TIMEOUT_MS`). No test runs or reads that file, so the run could not have
    told the gate anything.
    *The rule.* `UNTESTED_PATH_GLOBS` in `merge-gate.constants.ts` is a fixed list of paths
    that no test runs or reads: Markdown under `docs/`, the Markdown, YAML and `CODEOWNERS`
    directly under `.github/`, the workflows under `.github/workflows/`, and the root
    `LICENSE`, `CONTRIBUTING.md`, `AGENTS.md` and `CLAUDE.md`. When every file the session
    changed is on the list, `measureBranch` does three things. It runs no test command,
    takes no test slot (decision 96), and waits for no load (decisions 88, 134). It reports
    the test stage as `skipped`, with the detail `no testable file changed (N files)`, where
    N is the scope audit's file count. It reports the coverage stage the same way, without
    measuring coverage, because coverage reads the test run's output (decision 95) and a
    separate measurement would run the suite. No coverage ratio is ratcheted. Build, lint,
    the scope audit, the diff size, dead code, duplication and complexity run as before. A
    change with one file off the list runs the full test stage, as before this decision.
    *What stays testable.* A path on the list still runs the tests when something else
    reads it, using the same branch tree reading that decision 110 uses for the diff-size
    split:
    - a file the `--raw -M -l0` entries name off the list, by either of a rename's paths.
      `--name-only` pairs renames as the shared config says and names only the new path,
      so the files checked are both readings together. A rename's old path on the list
      goes through every check below, since it is what a link or another case reached on
      the target;
    - a changed symlink, or a path a symlink on the branch can reach;
    - a changed gitlink, whose commit is code whatever its path is named. The raw entries
      are read with `--ignore-submodules=none`, so `diff.ignoreSubmodules` or a
      `submodule.<name>.ignore` cannot hide one;
    - a name outside ASCII, which the gate's filesystem can fold onto another name;
    - a path the branch's tree also holds in another ASCII case, itself or through one of
      its directories. APFS folds case (decision 78), so a changed `docs/x.md` is the
      off-list `docs/x.MD` or `Docs/x.md` a test may read, and on macOS the checkout
      replaces it;
    - Markdown under `docs/` on a branch where a Docusaurus config or dependency compiles
      it.

    The tree is read from its root (`ls-tree --full-tree`, `top` pathspecs), as decision
    157 reads the target's, so a `core.worktree` a session aims elsewhere in the shared
    config hides no link, spelling or dependency file. The raw entries are read with
    `--no-relative` and `diff.relative` pinned off, so `diff.relative` in that config,
    which with such a `core.worktree` would list only the files under the cwd's prefix,
    hides no changed file either.

    A change that touches a nested package always runs that package's suite (decision 59).
    A rename's old path counts toward that, so a file moved out of a nested package touches
    it too.
    *What is left off the list.* `README.md` is left off because Rust's `include_str!` and
    doctest globs read it. `skills/` is left off because a plugin's tests check its
    `SKILL.md`. `.github/actions/` is left off because an action's own tests live there.
    *Every repo, and the wrong skips.* The list is fixed in pupitre rather than read from
    the project, so a session cannot widen it, and it applies to every repo pup manages, not
    only to pupitre. The proof below covers pupitre's own suite only. In another repo, a test
    command that reads a listed file is skipped wrongly on a change of only listed files.
    Examples are a test that checks an ADR index under `docs/`, `pytest --doctest-glob` over
    Markdown, and a VitePress, MkDocs, Sphinx or MyST build run from the test script. An
    operator in such a repo turns the skip off for that project (see the amendment below).
    Another option is to run that check from the build or lint script, which the gate still
    runs on every change.
    *Amendment (2026-11-11): a per-project switch.* Setting `skipTestsOnUntestedChanges:
    false` in `.pupitre/project.yml` runs the full test and coverage stages on every change,
    a change of only listed files included. Without the file, with an empty one, or with the
    key left out, the skip stays on, as this decision first set it. The file is read from the
    main checkout that the merge lock holds at the target branch, the same checkout
    `.pupitre/adapter.yml` is read from (decision 29). `.pupitre/**` is a protected path, so a
    session cannot change the setting its own gate reads. The switch can only turn the skip
    off. The list itself stays fixed in pupitre, so a project still cannot widen it. A
    malformed file fails the gate instead of leaving the skip on: a key other than
    `skipTestsOnUntestedChanges`, a value that is not `true` or `false`, or a document that
    is not a mapping. The setting is read only when no nested package was touched, since a
    nested change already runs its suite.
    A stage that nothing could have measured keeps the reason it gives on any other change,
    because a change of only listed files does not explain why it is missing. With no test
    command, the test stage says `not measured — no command available`. With no adapter that
    measures coverage, the coverage stage keeps `not measured — adapter cannot measure
    coverage`. An adapter that measures coverage gets `no testable file changed` on its
    coverage stage, with or without a test command.
    *The proof.* Before the list was written, src/ was searched for every test that names
    `docs/adr`, `SKILL.md`, `.github` or a root prose file. `decision-record.test.ts`,
    `overlap.test.ts`, `routing-utils.test.ts`, `pre-commit.test.ts` and the gate tests
    name them only as paths in temp repos or as globs, and none reads the checkout's copy.
    `merge-gate-untested.test.ts` checks that against the code, so a later test that reads
    `CLAUDE.md`, a workflow or an ADR fails it. It scans every file the suite loads: the
    TypeScript under `src/`, whatever the vitest config's `include` collects, and that config.
    In each file it collects every path read from the real checkout, in these forms:
    - a call holding `process.cwd()`, `import.meta.dirname`, `__dirname` or a name declared
      as one: each literal in it, the path a `join` or `resolve` builds, and a spawn's
      `cwd:`;
    - a template string starting with one of those anchors;
    - a literal starting with `./` or `../`, resolved from the file, which covers every
      import, `?raw` import, dynamic `import()`, `require`, `vi.mock` and
      `new URL(…, import.meta.url)`;
    - `import.meta.glob` from the root;
    - an fs, glob or path call whose first argument is a relative literal: the `read*`,
      `access*`, `opendir*`, `stat*`, `exists*` and `open*` families, `fs.promises.*`,
      `glob` and `globSync`, and an unanchored `resolve` or `join`;
    - a spawn with no `cwd` and no `-C`, such as `git ls-files docs`, whose literals name
      paths from the root.

    It then asserts that no listed file in the checkout is one of those paths, lies under
    one, or matches one that is a glob. Each form has a row in a table test proving the
    scan finds it, and another test proves the paths a temp repo spells are not counted.
    The test also checks that the real search is not empty: it must find the hook read
    `scripts/pre-commit`, the walk of `src`, and `src/core/sandbox.utils.ts`. The walk that
    finds listed files is proven on a temp tree of concrete files, listed and not, rather
    than on the checkout's own: a change the gate lets skip this test could delete any
    listed file the test named. A read whose path is only an anchor plus a variable
    is not checked, because the variable's value comes from a read that is. The test file
    leaves itself out: its table names listed files on purpose.
    Tests: a change of only `.github/workflows/ci.yml` and an ADR merges under a test command
    that always fails. Its test and coverage stages are skipped with `no testable file changed
    (2 files)`, coverage is never measured, and build, lint, the scope audit and the diff size
    pass. A single workflow change is then gated under each other mix of a test command and
    a coverage capability. With no test command, the test stage says `not measured — no
    command available`; with one, it says `no testable file changed (1 files)`. With
    coverage, the coverage stage says `no testable file changed (1 files)` and coverage is
    never measured. Without coverage, the stage says `not measured — adapter cannot measure
    coverage`.
    After an untested merge, the coverage baseline keeps its old ratio while the other debt
    metrics ratchet. The full test stage runs, and fails, in nine cases: one source file is
    changed beside a workflow, a source file is renamed into `docs/`, a Docusaurus config
    compiles the changed Markdown, a symlink reaches the changed path, the tree holds the
    changed path in another case, and the tree holds one of its directories in another case.
    So do a rename whose old path a symlink reaches, a rename whose old path the tree holds
    in another case, and a deleted source file the raw entries name while `--name-only`
    leaves it out. The last stands in for the two readings disagreeing, by narrowing
    `gitDiffPaths`, because no config git reads makes `--name-only` pair a rename `-M -l0`
    does not. With `core.worktree` aimed at `/` in the shared config, the symlink, other
    case and Docusaurus dependency cases still run the full test stage, and so does a source
    change beside a `<repo>/docs/` file with `core.worktree` aimed at the repo's parent and
    `diff.relative` set. So do a gitlink on a listed path, a gitlink change the shared
    config's `diff.ignoreSubmodules=all` hides, and a rename that moves a Markdown file out
    of a nested package under `docs/`.
    For the amendment, a single workflow change is gated under a test command that always
    fails. With `skipTestsOnUntestedChanges: true` it merges with the test stage skipped. With
    `false` the full test stage runs, fails, and the merge is rejected. The reader keeps the
    skip on with no file and with an empty file, and refuses an unknown key, a value that is
    not a boolean, and a list.
