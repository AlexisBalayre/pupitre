# Merge gate and debt

## Gate pipeline (`pup merge`)

Ordered stages; first hard failure stops the pipeline.

1. Build and tests (adapter commands). Hard fail.
2. Lint and format check. Hard fail.
   - Nested packages: a directory that commits its own `package.json` is its own measurement
     unit, left out of the root's debt metrics (decision 58). When the diff touches one, its
     own `test` and `typecheck` scripts run as hard stages, resolved from the trusted
     checkout's manifest and run in the package directory under the same sandbox. A script the
     manifest does not declare is flagged, not skipped (decision 59).
3. Scope audit: diff paths vs scope-in/scope-out; violations logged during the session are re-checked here. Hard fail.
4. Debt delta (soft fail: flags, mergeable only with `--accept-debt`):
   - Duplication: diff vs existing codebase (jscpd or adapter equivalent). Production code
     only — a block whose every location is a test file is reported as uncounted, not as debt
     (decision 39).
   - Dead code introduced (knip / ts-prune / vulture via adapter).
   - Complexity delta on touched files.
   - Coverage delta on touched files (no drop allowed).
   - Dead code, duplication and coverage each say how many changed files a nested package kept
     from them, and which packages: "not measured here" is never read as "nothing to measure"
     (decision 59).
   - Diff size vs task size (small task, large diff is flagged).
5. Reviewer subagent: mechanical review pass; findings attached to the review queue entry.
6. Knowledge transaction: regenerate code map for touched modules, write decision record, create or close ledger entries. A merge without this transaction is invalid.

On rejection the full gate report is injected into the session as a correction prompt: rejection is automatic re-steering.

## Baseline and ratchet

- `pup init` snapshots every metric as-is; day one blocks nothing.
- All gates measure deltas against the baseline, never absolutes.
- Ratchet: when a metric improves and the merge lands, the baseline tightens to the new value. Quality is monotonic.

## Debt ledger

- Entry: description, files, reason, accepted_by, review-by condition (date or event, e.g. "before adding a second payment provider"), status.
- Created only via `--accept-debt`; closed when a merge removes the shortcut (detected by gate stage 4 improving on the entry's files, confirmed by the human).
- Sessions touching files with open entries get the entries injected into their task layer.
- `pup debt` lists open entries oldest first. Entries past their review-by condition are surfaced in `pup status`.

## Performance policy

- No global performance gating: simplicity wins by default.
- Hot paths are declared explicitly in `.pupitre.yml` (path list). Only those carry benchmarks; the gate fails on regression there.
- Any complexity increase justified as "for performance" requires an attached benchmark, otherwise stage 4 flags it.
