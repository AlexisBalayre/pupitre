# 0059. A nested package's own runner is a gate stage, and what the root leaves out is said (2026-09-21)

- Status: accepted

59. **A nested package's own runner is a gate stage, and what the root leaves out is said
    (2026-09-21).** Decision 58 took nested packages out of the root's metrics on the claim that
    their own runner covers them, and stated the ceiling: nothing invoked that runner, so
    `tools/review` was measured by scope-audit and complexity alone while the review workflow
    executed the PR head's copy of it with a write token. This closes the four gaps it named.
    *The runner runs.* When the diff touches a file inside a nested package, the gate runs that
    package's `test` and `typecheck` scripts as hard stages, after the root's build, test and
    lint and before the scope audit, named `test (<dir>)` and `typecheck (<dir>)`. They
    resolve from the trusted checkout's `<dir>/package.json` through its own package manager,
    decision 11's manifest-wins rule as `gateCommands` applies it to the root, so a session that
    deletes its package's test script fails the stage rather than skipping it. They run with
    the package directory as cwd through the same `runGateChild` the root stages use, one
    shared closure in the gate, so the sandbox, the timeout, the env scrub and the
    failure-detail cleaning are the root's by construction. A file belongs to its innermost
    nested package. Any changed file triggers the stages, a deletion or a README included,
    since a deleted test is a change the package's tests are for. The adapter answers through
    one optional capability, `touchedNestedPackages`, reusing decision 58's resolver and
    predicate, so the packages the gate runs are exactly the ones the root measurements drop;
    an adapter without it has no nested packages, which is Python's position under decision 58.
    *A missing script is a flag, not a skip.* A nested package whose trusted manifest declares
    no `test` or no `typecheck` gets a flagged stage per missing script, with a ledger entry
    when accepted. A root with no test script is skipped as "not measured", but that is a
    whole-repo configuration; here the diff has changed code that no stage of any kind
    measures, which is decision 30's "changed source plus no measurement is a flag". The
    scripts are required by name, with no `tsc` fallback: the package's own manifest is the
    only statement of how it is checked. A flagged stage now sits among the hard ones, so
    `flaggedDebt` and its detail builder moved above them; its text is pup's own plus a
    `quotePath`-sanitized directory, so steering it after a later hard failure is safe.
    *What was left out is said (decision 29).* Dead code, duplication and coverage append
    "; N changed file(s) in a nested package not measured here (<dirs>)" to every detail they
    print, pass, skip or flag, ahead of the accept hint, the way duplication already names its
    uncounted fixture blocks. N counts changed source files that still exist, the ones the
    root walk and `coverableFiles` would otherwise have seen; directories past three are
    elided. Before this, a PR touching only `tools/review` read "no instrumentable changed
    lines" on coverage, a pass that described an exclusion as an absence.
    *The duplication rule id is bumped* to `tests-excluded+nested-packages`, so a baseline
    stamped before decision 58 skips with "run `pup audit`" instead of comparing (decision
    39's mechanism). Decision 58 left the id unchanged with a gap of zero; the bump makes the
    check real rather than coincidental, at the cost of one skipped duplication stage until the
    operator re-stamps.
    *The workflow runs the base's tooling.* `claude-code-review.yml` extracts `tools/review`
    at the merge base into `.review-tooling/` with `git archive`, installs it there, and runs
    every script step from it. Restoring in place, as AGENTS.md is restored, would dirty the
    tree before the preflight, which refuses a dirty tree, and would hide the head's copy from
    the reviewers who are meant to read it; the directory is added to `.git/info/exclude` so
    it never reads as dirt. **The operator's security review of the first cut found it
    bypassable,** and three guards now hold it. pnpm walks up from `--dir` to find a workspace
    root, and `.review-tooling/` sits inside the head's checkout, so a head-committed root
    `pnpm-workspace.yaml` listing the directory had its root `preinstall` run by the
    token-carrying install and its `nodeOptions: --require` injected into every script step
    (reproduced with the pinned pnpm 10.34.5); the install and all four run steps pass
    `--ignore-workspace`, verified to suppress both. `tar -x` never removes a file the base
    archive lacks, so a head that commits `.review-tooling` itself is refused before the
    archive is unpacked. And the pnpm binary was chosen by `packageManager` in the merge ref's
    `tools/review/package.json`, the head's copy; `pnpm/action-setup` now pins `version:
    10.34.5` and reads no manifest for it (it still compares the root manifest's field, so a
    head that changes it fails the run rather than choosing the binary). The restore runs
    under `pipefail`, so a failed `git archive` is not masked by `tar`. The early install from
    the merge ref is gone, so a run that dies at the head checkout now leaves no metrics
    record. **The remaining ceiling:** on `pull_request` the head's own copy of this workflow
    file is what runs, so a PR that edits the workflow can drop every guard above; those runs
    are reviewed as workflow changes, not protected by them. An `@claude review` comment runs
    `main`'s copy, which is the only run the guards bind.
    *Moved outside the checkout (2026-10-18, template sync).* The base's archive now unpacks
    to `$REVIEW_TOOLING`, a sibling of the checkout, and every script step runs `node
    node_modules/tsx/dist/cli.mjs` with that directory as its working directory, as the
    template does, instead of `pnpm run` in `.review-tooling/`. The review's Bash sandbox may
    write anywhere inside the checkout, so a copy outside it is one the model cannot touch; no
    walk up from the copy reaches the head's tree, so the committed-directory refusal and the
    `.git/info/exclude` entry go, and node reads the base's `package.json`, never the head's.
    The install keeps `--ignore-workspace`. Scripts that run git or gh point them back at the
    checkout through `GITHUB_WORKSPACE`. The template copies the trigger's checkout instead,
    which on `pull_request` is the merge ref and carries the head's edits; the merge-base
    extract stays.
    *Nothing the head controls reaches the copy or a credential (2026-10-18).* The head's
    content never reaches the tooling copy or a credential: what the workflow takes from the
    head is written from the object store, never through a path the head controls. The
    "Restore AGENTS.md" step copied `AGENTS.md` onto `.claude-pr/AGENTS.md`, which the head can
    commit as a symlink into `$REVIEW_TOOLING`, so the `cp` overwrote the poster that runs
    after the model with the job's token. The step now writes `git show HEAD:AGENTS.md` into a freshly made
    `.claude-pr-agents/` (the action clears `.claude-pr/` before the model starts, so a snapshot
    there never reached a reviewer), and the tooling copy is made read-only once installed, since no later
    step writes there. The checkout persists no credential (`persist-credentials: false`): its
    extraheader sat in `.git` for the whole job, readable by the model. The preflight's fetch of
    `ci/review-metrics` borrows gh's credential helper for that one command, `gh pr checkout`
    authenticates through gh, and the metrics are appended through the contents API, so no git
    call needs a stored token. The one credential left in `.git` while the model runs is the
    action's own app token in the origin URL, which the model already holds as `GH_TOKEN` and the
    action revokes before the poster runs. The poster's `git diff`, which runs after the model has
    had the checkout, turns off fsmonitor, hooks, an external diff and textconv drivers, and every
    transport through `GIT_ALLOW_PROTOCOL=none` and `GIT_NO_LAZY_FETCH`, which config cannot
    override, so nothing the head or the model configured runs with the token. `--text` keeps a
    head's `-diff` attribute from hiding the hunks the comments anchor to.
    *Tests, and the mutation.* Unit tests on temp repos, never the gate run on itself (decision
    39): a nested test script that exits non-zero refuses the merge with its output in the
    detail; removing the stage loop from the gate fails five of the nested-package tests,
    including that one, with the file restored from a backup copy. Others assert the stage
    order and pass, the package directory as cwd, the env scrub, the trusted manifest winning
    in both directions, no stage for a diff outside every package, the flag and its ledger
    entries, the note on all three debt stages and its elision, the innermost-package rule, and
    the rule-id skip. The first full-suite run also exposed a test-isolation leak: a test whose
    gate never steered left a throwing once-implementation queued on `steerPane`, which
    `clearAllMocks` keeps, and the suite now resets that mock before each test.
    *Ceilings.* The stages run the scripts the trusted manifest names, but the bodies come from
    the worktree's manifest, as the root's do. Nothing installs the nested package's
    dependencies in the worktree, so a package whose runner needs them fails its stage until
    they are installed there: a loud failure, the safe direction, and an environment question
    rather than a gate one. The flag fires for any touched package, so a package that means to
    have no typecheck has to be accepted as debt each time it changes, or declare the script.
