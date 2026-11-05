# 0038. Baseline drift is a new append-only `baseline_history` table, not a reuse of `projects.baseline` (2026-08-03)

- Status: accepted

38. **Baseline drift is a new append-only `baseline_history` table, not a reuse of
    `projects.baseline` (2026-08-03).** `pup report --open`'s drift section (docs/08) needs a
    trend, and the store could not produce one: only one baseline ever exists —
    `projects.baseline`, overwritten in place on every capture — and `AuditReport.previous`
    lives in memory only during a mutating ~36s audit, so rendering drift from the existing
    schema meant either showing a single point or re-running the audit at render time, both
    of which break the report's rendering-only constraint. `baseline_history` (`project_id`,
    `captured_at`, `stages` JSON, `debt` JSON nullable, indexed on `(project_id,
    captured_at)`) is appended in `initProject` — the one choke point both `pup init` and
    `pup audit` capture through — so history starts with the project's very first baseline,
    not one audit late. Three sub-decisions:
    *Every capture appends, not only on change* — an unchanged measurement is a data point (a
    flat trend segment is information), and content-diffing to suppress it buys nothing:
    captures happen once per init/audit (pupitre's own 11 days produced far fewer audits than
    its 24 gate reports), each row is a few KB of JSON, so even years of daily audits stay in
    the hundreds of rows. Nothing prunes; if a future caller wires captures into a loop, that
    caller adds pruning. *Amended 2026-10-14 (PR #142):* the append lives in `persistBaseline`,
    which `initProject` and `auditProject` both call, so it stays the one choke point. Every
    capture also records which (adapter, capability) pairs went unmeasured
    (`ProjectBaseline.gaps`, empty included), because `deadExports` is one flat array across
    adapters and the figure alone cannot say whose share is missing. An audit with a gap that is
    new against that record does not call `persistBaseline`: the baseline and its history stay
    whole, a plain audit prints the drift first, `--sweep` refuses at once, and both exit 1
    saying "Baseline kept". A gap the record already holds (no coverage runner declared, no
    vulture beside the TS adapter) does not block, since the refusal would protect a figure that
    was never there, and neither does a dead-code gap from an adapter the stored capture did not
    run, which added no share to the flat figure. A baseline stored before gaps were recorded is
    judged by the figures it holds, and the refusal names `pup init` as the way to put a metric
    that never measured here on record. `pup init` is unchanged.
    *Backfill* — the first capture on an upgraded store seeds a row from the outgoing
    pre-table baseline before `saveProjectBaseline` discards it, so the numbers already
    ratcheted over 11 days of dogfooding are the trend's first point rather than lost. The
    seed is guarded by a `(project_id, captured_at)` existence check, so re-running captures
    seeds it exactly once.
    *Duplicate `captured_at`* — possible only for two captures in the same millisecond
    (realistic in tests, not in a ~36s audit); both rows are kept and `listBaselineHistory`
    orders by `(captured_at, id)` so insertion order breaks the tie. The index is
    deliberately not UNIQUE: a capture path must record, never throw.
    Ceiling, stated plainly: the merge-gate debt ratchet (decisions 21, 26) mutates
    `projects.baseline`'s debt in place *keeping the old `capturedAt`*, and those bar moves
    get no history row — the backfill guard sees the timestamp already recorded and skips.
    Between audits the trend is audit-to-audit only; a ratchet move surfaces in the next
    audit's row. Recording ratchets would mean duplicate-timestamp rows dated to the wrong
    moment or changing what `capturedAt` means, so it waits until the rendered report proves
    the audit-to-audit trend too sparse.
