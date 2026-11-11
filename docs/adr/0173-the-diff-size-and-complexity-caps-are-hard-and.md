# 0173. The diff-size and complexity caps are hard, and an oversize slice is split, not accepted as debt (2026-11-11)

- Status: accepted
- Amends: [0017](0017-diff-size-flag-blocks-unless-accept-debt.md)
- Amends: [0021](0021-debt-delta-three-soft-stages-with-a-merge-time.md)

173. **The diff-size and complexity caps are hard, and an oversize slice is split, not accepted as debt (2026-11-11).**
    Amends decisions 17 and 21 for two of the gate's flags. A merge past the diff-size cap or the
    per-file complexity cap is refused, and `--accept-debt` no longer clears either.
    *The numbers do not change.* The caps stay at the values the gate holds today: 600 source
    lines per merge, +15 decision points per touched file, and 50 lines for a new file. They are
    a starting point, not tuned values, and moving one needs a new decision.
    *Why.* Oversize PRs draw the most findings. In the last 60 merged PRs the three with the most
    first-review findings were also the largest: #262 (6 findings, 866 lines), #293 (4, 1100) and
    #286 (3, 1258). Five open tasks have needed the operator to accept diff-size or complexity
    debt one by one.
    *What replaces the override.* The design stage (decision 176) lists a slice's files and an
    estimated size, and a slice over a cap is split before it launches. A slice that overruns
    its cap in the work is split by a new session. It is not accepted as debt, and the cap never
    widens for one slice.
    *What does not change.* `dead-code` and `duplication` stay soft and keep `--accept-debt`,
    with one ledger entry per flag. Debt already accepted stays valid and keeps its
    `--review-by` condition. The hard caps apply to tasks launched after the rollout flag of
    decision 178 is on for the project.
