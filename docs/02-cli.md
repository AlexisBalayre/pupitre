# CLI surface

Binary: `pup`. All commands run from the target repo or with `--project <id>`.

## Lifecycle

- `pup init` — onboard a repo: detect stack, run audit, snapshot baseline, draft conventions, open review step (see 07-onboarding.md).
- `pup new <task> [--role <role>] [--scope <glob>...]` — create task spec (opens editor with template), compile profile, create worktree and branch, launch session.
- `pup status` — all sessions by state, pending reviews, live scope overlaps between running sessions.
- `pup steer <session> "<message>"` — inject a correction into a running session.
- `pup interrupt <session> ["<message>"]` — abort the in-flight tool call (Escape to the pane), optionally steering a message after; the hung-tool escape hatch steer cannot reach (decision 37).
- `pup kill <session> [--respawn]` — stop; optionally restart with the same or edited spec.

## Review and merge

- `pup review` — the queue: pending branches ordered by risk score, each with generated diff summary, gate results, debt delta.
- `pup review <session>` — full detail for one branch.
- `pup merge <session>` — run the gate pipeline; on pass, merge and write knowledge layer in the same transaction; on fail, move to rejected and inject the report.
- `pup merge <session> --accept-debt "<reason>" --review-by "<condition>"` — merge despite a flagged shortcut, creating a ledger entry.

## Knowledge

- `pup map [module]` — code map: text tree by default, `--open` renders the interactive mind-map view.
- `pup report [--open]` — render the project report into the project dir: `report.html` (sessions newest first with the goal that launched them, baseline drift from capture history, open debt, decision records) plus one `session-<id>.html` dossier per session — the full intent with acceptance criteria, the complete event timeline with every gate run, what merged (files and PR), and the session's decision records. The index links each session to its dossier. `--open` also launches the index in the browser (best-effort).
- `pup debt` — open ledger entries, oldest first, with review-by conditions.
- `pup log [module]` — decision records, filterable by module or file.

## Configuration

- `pup profile list | show <name> | edit <name>` — manage base and role layers.
- `pup profile stale` — running sessions whose profile version is behind current.
- `pup audit --sweep` — spawn a deletion-only session (dead code, unused deps) from the latest audit findings.

## Risk score (used by `pup review`)

Weighted sum of: diff size vs task size, scope violations logged, debt delta, hot-path or architectural-boundary files touched, overlap with another live session, coverage delta. High risk means deep human review; low risk means skim. A random sample of low-risk merges is periodically flagged for deep review to keep the gate honest.
