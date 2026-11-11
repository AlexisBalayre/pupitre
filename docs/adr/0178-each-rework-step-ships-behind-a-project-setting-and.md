# 0178. Each rework step ships behind a project setting and is judged on its numbers (2026-11-11)

- Status: accepted

178. **Each rework step ships behind a project setting and is judged on its numbers (2026-11-11).**
    *Flags.* Every step of the factory rework (kickoff rubrics, tests first with self-review and
    per-commit review, intake and design with hard caps, the merge queue with budgets and briefs,
    the Profiling and Data Protection reviewers) ships behind a project setting that defaults off.
    The operator turns a step on for one new ticket at a time. The old gate stays until the step shows
    its numbers. A change to the gate is first checked by a separate copy of it, never by itself.
    Tasks already launched, and the open PRs with their accepted debt, finish under the gate they
    started with.
    *Targets.* Each step is measured over 30 merged PRs after it is on: the first-review clean rate
    from 41% toward 60%, review rounds per PR from 1.7 toward 1.2, and the cost per merged PR, which
    is recorded and has no target yet. A step that misses its target for two windows in a row is
    rolled back or reworked.
    *The baseline.* The start values are the last 60 merged PRs, #240 to #310, from 2026-11-07 to
    2026-11-11. They span two CI regimes, because #267 limited the review to opening and on demand,
    and four days is a thin window. The 60% and 1.2 targets are the operator's first bar, not
    measured limits, and are re-set after the first step has run.
