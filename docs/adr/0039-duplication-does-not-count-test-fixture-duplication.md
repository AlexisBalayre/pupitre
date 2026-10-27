# 0039. Duplication does not count test-fixture duplication (2026-09-03)

- Status: accepted

39. **Duplication does not count test-fixture duplication (2026-09-03).** `findDuplication`
    now skips any block whose *every* location is a test file, tallying it as
    `excludedTestBlocks` instead. Decision 33's sibling, reached the same way: a metric the
    author cannot act on teaches the operator to wave the gate through.
    Measured over the 11 days of dogfooding, four of the six duplication flags the gate ever
    raised were pure test-setup repetition — `python-adapter.test.ts` against itself,
    `index.test.ts` against itself, `session-runtime.test.ts` against `git-diff-client.test.ts`,
    and `audit.test.ts` against `init.test.ts`. Each cost a session a rework cycle to get back
    under the bar, and t-msc3oe6k's own note records it as "duplicated debt-test scaffolding
    the merge gate flagged (184->210)". The most-flagged block is the `GIT_ENV` scrub, which
    `docs/conventions/testing.md` **publishes verbatim** as the thing every git-touching test
    must write, and which is itself exactly six lines against a six-line window. The gate was
    failing merges for obeying the repo's own written convention, and that convention is
    deliberate: testing.md prescribes a real store and repo *per test* over shared setup,
    because shared setup couples suites and hides what each one depends on.
    On this repo the rule moves duplication 220 → 62 and blocks 23 → 6; 17 of the 23 were
    test↔test. The 6 that survive are production and all genuine (the `NoAdapterError` guard
    in `cli/index.ts`, the `gh` exec options in `github.client.ts`, two windows in
    `session-handoff.service.ts`, and `report.service.ts` against `session-dossier.service.ts`).
    Four sub-decisions, three of them sharpened by the security review this change went
    through — the first cut of the predicate opened two holes that did not exist before it.
    *Every location, not any* — a block mixing test and production files still counts in full,
    so a clone cannot be hidden by relocating one copy out of the metric's sight. Closed by a
    discriminating test: flipping `every` to `some` fails exactly that test and nothing else.
    *`isTestFile` is the `*.test.ts` suffix and nothing else* — in
    `typescript-source.utils.ts`. Two earlier cuts of this predicate were wider and both were
    wrong, which is the useful part of the record. An exemption is only safe when something
    forces the file to actually hold tests: `vitest.config.ts` here collects `src/**/*.test.ts`,
    so parking production code under that name hard-fails the test stage with "No test suite
    found in file" — which is why the pre-existing inline `file.includes('.test.')` was harmless.
    A `*.spec.ts`, a nested `src/core/__tests__/`, and a rooted `tests/` are collected by
    *nothing*, so each would have bought exemption from duplication, dead exports and coverage
    for free on ordinary importable code: `git mv` two flagged files in (no `PreToolUse` hook
    sees a Bash rename) and the stage passes naming no file. A genuine test under any of those
    layouts is still `foo.test.ts`, already covered by the suffix, so a directory arm only ever
    added the unsuffixed files — the attack and nothing else. The cost is a repo that names or
    places its tests differently: its fixture repetition gets counted rather than hidden, the
    safe direction. Widening this means corroborating against the trusted checkout's runner
    config, decision 31's pattern, not a longer regex. `findDeadExports` now uses the shared
    predicate instead of its own inline check — a no-op here, and a tightening in general, since
    `.includes('.test.')` also matched mid-name.
    Deliberately **not** `isCoverageExcluded`, which answers "should a coverage report mention
    this?" and so also swallows `dist/`, `build/` and named tool configs — duplication between
    two `tailwind.config.ts` files is still duplication.
    *The gate says what it left out* — the stage detail appends `; N test-fixture block(s) not
    counted`, per decision 29's rule that a capability explains what it did not measure. The
    field is optional, so a custom adapter that omits it makes the gate fall silent rather than
    claim it counted none. Being optional made it a new injection sink: `matchesShape` probed
    only for `duplicatedLines`' presence, so a custom adapter's `sh -c` stdout could return a
    string carrying newlines and backticks that lands in the terminal, the fenced PR body and
    the re-steer prompt — on the *passing* path, where `duplicatedLines` at least coerces to
    `NaN` and gets flagged. Both numbers are now type-checked at that boundary and re-checked
    finite at the sink, per decision 29's "sanitized where they are consumed".
    *A stored count carries the rule that produced it* — `DebtBaseline.duplicationRule`, stamped
    by `initProject` and every merge, and `knownLines` resolves only when it matches
    `DUPLICATION_RULE_ID`. This closes what was first written here as a temporary ceiling and is
    not: 62 measured against a stored 220 does not merely pass on 158 lines of slack until an
    audit, it lets the *next* merge ratchet `62 + smuggled` in as the new floor, and `pup audit`
    then blesses it, because by then the smuggled duplication is main. No flag, no
    `--accept-debt`, no ledger entry — a silent permanent write-off through the artifact that
    exists to record accepted debt. A mismatch now routes to the existing `skipped` path saying
    the baseline counts duplication a different way — and, the correction that matters, it does
    not move the bar either. Stamping the fresh number on the mismatch path was the first
    attempt and was worse than the problem it fixed: the merge that skipped the compare would
    have written its own unvalidated measurement in as the permanent floor, so a session merging
    in that one window could store *any* number — 5 000 duplicated lines the old rule would have
    flagged and refused — with every later merge gating against it and `pup audit` confirming
    it. Decision 30's lesson applies directly: a baseline is re-stamped from the trusted
    checkout by `pup audit`, never from the worktree under judgement. So a mismatched baseline
    stays mismatched and the stage stays `skipped` until an operator audits; in `--pr` mode —
    this repo's actual workflow, where the merge-time ratchet never runs — that was the only
    path anyway. Decision 33 (206 → 182) had the identical mechanic and went unnoticed, which is
    what a version stamp is for. `pup audit` also stops diffing `duplicatedLines` across rules,
    since reporting the rule change as an improvement would mask a real rise underneath it —
    decision 34's rule, applied to a metric present on both sides but not comparable.
    Three ceilings, stated plainly. **Unenforceable for custom adapters:** decision 24 has them
    self-reporting `duplicatedLines` over `sh -c`, so docs/06 states the rule as contract and
    trusts it exactly as far as it already trusts those numbers — the stamp constrains only
    pup's own captures. **A gate-measurement change cannot be validated by the gate:** `pup
    merge` runs the adapter from the main checkout while measuring the worktree's files, so a
    branch that changes the measurement is judged by the old one — the same trap as validating a
    sandbox-policy change with the test suite. This change therefore lands as a plain PR, with
    `pup audit` on main afterwards to capture 62 under the new rule.
    **Fixture duplication is now invisible beyond a count:** a 400-line copy-pasted test helper
    would not be flagged, only tallied.
