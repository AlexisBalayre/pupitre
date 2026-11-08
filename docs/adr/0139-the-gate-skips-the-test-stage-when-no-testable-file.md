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
    A stage that nothing could have measured keeps the usual `not measured — no command
    available`, because a change of only listed files does not explain why it is missing. The
    test stage is such a stage when the adapter declares no test command. The coverage stage
    is one when there is neither a test command nor an adapter that measures coverage. An
    adapter that measures coverage without a test command still gets `no testable file
    changed` on its coverage stage.
    *The proof.* Before the list was written, src/ was searched for every test that names
    `docs/adr`, `SKILL.md`, `.github` or a root prose file. `decision-record.test.ts`,
    `overlap.test.ts`, `routing-utils.test.ts`, `pre-commit.test.ts` and the gate tests
    name them only as paths in temp repos or as globs, and none reads the checkout's copy.
    `merge-gate-untested.test.ts` checks that against the code. It collects every path a
    TypeScript file under `src/` reads from the real checkout, in three forms:
    - `process.cwd()`, `import.meta.dirname` or `__dirname` joined with literal segments,
      or used as the start of a template string;
    - `new URL(…, import.meta.url)`;
    - a relative literal passed to an fs call.

    It then asserts that no listed file in the checkout is one of those paths or lies under
    one. The test also checks that its search is not empty: it must find the hook read
    `scripts/pre-commit`, the walk of `src`, and `src/core/sandbox.utils.ts`, and the list
    must match files the checkout holds. A read whose path is only an anchor plus a variable
    is not checked, because the variable's value comes from a read that is.
    Tests: a change of only `.github/workflows/ci.yml` and an ADR merges under a test command
    that always fails. Its test and coverage stages are skipped with `no testable file changed
    (2 files)`, coverage is never measured, and build, lint, the scope audit and the diff size
    pass. With no test command, a single workflow change reports the test stage as `not
    measured — no command available`. Its coverage stage says `no testable file changed (1
    files)` when the adapter measures coverage, without measuring it, and `not measured` when
    the adapter does not.
    The full test stage runs, and fails, in four cases: one source file is changed beside a
    workflow, a source file is renamed into `docs/`, a Docusaurus config compiles the changed
    Markdown, and a symlink reaches the changed path.
