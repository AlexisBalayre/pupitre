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
    - a rename whose old path is off the list (`--name-only` names only the new path, so
      the old one is read from the `--raw -M` entries);
    - a changed symlink, or a path a symlink on the branch can reach;
    - a name outside ASCII, which the gate's filesystem can fold onto another name;
    - a path the branch's tree also holds in another ASCII case, itself or through one of
      its directories. APFS folds case (decision 78), so a changed `docs/x.md` is the
      off-list `docs/x.MD` or `Docs/x.md` a test may read, and on macOS the checkout
      replaces it;
    - Markdown under `docs/` on a branch where a Docusaurus config or dependency compiles
      it.

    A change that touches a nested package always runs that package's suite (decision 59).
    *What is left off the list.* `README.md` is left off because Rust's `include_str!` and
    doctest globs read it. `skills/` is left off because a plugin's tests check its
    `SKILL.md`. `.github/actions/` is left off because an action's own tests live there.
    *Every repo, and the wrong skips.* The list is fixed in pupitre rather than read from
    the project, so a session cannot widen it, and it applies to every repo pup manages, not
    only to pupitre. The proof below covers pupitre's own suite only. In another repo, a test
    command that reads a listed file is skipped wrongly on a change of only listed files.
    Examples are a test that checks an ADR index under `docs/`, `pytest --doctest-glob` over
    Markdown, and a VitePress, MkDocs, Sphinx or MyST build run from the test script. There
    is no per-project switch. An operator in such a repo avoids the wrong skip in one of two
    ways. The first is to run that check from the build or lint script, which the gate still
    runs on every change. The second is to read a `skipped: no testable file changed` test
    stage in the gate report as untested, and run the suite by hand before `pup land`.
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
    `scripts/pre-commit`, the walk of `src`, and `src/core/sandbox.utils.ts`, and the list
    must match files the checkout holds. A read whose path is only an anchor plus a variable
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
    metrics ratchet. The full test stage runs, and fails, in six cases: one source file is
    changed beside a workflow, a source file is renamed into `docs/`, a Docusaurus config
    compiles the changed Markdown, a symlink reaches the changed path, the tree holds the
    changed path in another case, and the tree holds one of its directories in another case.
