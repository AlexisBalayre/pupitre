# 0034. `pup audit` diffs the debt baseline too, not just stage status (2026-08-02)

- Status: accepted

34. **`pup audit` diffs the debt baseline too, not just stage status (2026-08-02).** Observed
    live: an ungated GitHub merge raised duplicated lines from 182 to 196, and `pup audit`
    printed only `Baseline refreshed.` — `compareBaselines` diffed `stages[].status`
    (build/test/lint) but the debt numbers (`deadExports`, `duplicatedLines`, `coverageRatio`)
    were re-measured and written into the stored baseline without ever being compared against
    what they replaced. A regression of exactly the kind the merge-gate's dead-code/
    duplication/coverage stages exist to catch was invisible the moment it landed outside the
    gate, because `pup audit` is the only thing that can still see it after the fact.
    `auditProject` now also runs `compareDebt`, one `DebtTransition` per metric measured on
    both the old and fresh baseline — a metric missing from either side has nothing to diff
    against, so it is left out rather than guessed at, mirroring how `pup audit`'s existing
    stage diff already treats a stage absent from the old baseline as `skipped`. Direction is
    metric-specific: `deadExports` (compared by count, not by diffing which exports are dead
    — that identity diff is what the merge-gate's dead-code stage already does, at merge time,
    per decision 21) and `duplicatedLines` regress on a rise; `coverageRatio` regresses on a
    fall past decision 23's `COVERAGE_RATIO_EPSILON`, reused here so the same float noise that
    would not flag a merge does not flag an audit either.
    `pup audit`'s output now prints every measured metric as `label  before -> after  MARKER`
    next to the existing stage-transition lines, and a debt regression sets `hasRegression`
    alongside a stage regression — so `pup audit --sweep` now refuses on a debt rise exactly
    as it already refused on a failing stage, instead of launching a deletion-only sweep on
    top of debt nobody was told about.
    Ceiling, deliberately not closed here: a plain `pup audit` (no `--sweep`) still refreshes
    the baseline to the fresh, worse numbers regardless of `hasRegression` — ratchet semantics
    are unchanged, matching how a regressed stage was already handled before this change. The
    command now *says* duplication rose 182 → 196; it does not refuse to store 196 as the new
    floor. Nothing short of a human (or `--sweep`, which does refuse) stands between an
    observed regression and it becoming the baseline the next audit compares against.
