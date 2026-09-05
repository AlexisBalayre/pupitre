# CLI surface

Binary: `pup`. Every command resolves its project through one rule (decision 43): `--project <id>`
wins from anywhere, even inside another repo; otherwise the repo around the current directory;
outside any repo, the store under `~/.pupitre` decides only when exactly one project is
registered — with several it lists them as `id  repo_path` (a deleted repo is marked `(missing)`)
and refuses until `--project <id>` picks one, with none it says so and points at `pup init`. A
project whose repo no longer exists on disk is reported, never used. Each refusal is one line,
exit 1.

## Global options

- `--project <id>` — control a registered project by id; the ids are the directory names under
  `~/.pupitre`, and `pup status` from outside any repo lists them when more than one exists.
  Operator-only, as is the store's auto-select outside a repo: a session reaches only the
  project around its cwd, whose store is where its guards live (decision 43).

## Lifecycle

- `pup init` — onboard a repo: detect stack, run audit, snapshot baseline, draft conventions, open review step (see 07-onboarding.md).
- `pup plan add "<goal>" --scope <glob>...` — record a task with no session. `pup plan` lists the
  backlog; `pup plan drop <task>` removes one; `pup plan edit <task> [--goal|--scope|--accept]`
  rewrites one. A task is in the backlog until a session claims it (decision 40).
- `pup launch <task>` — compile a profile, create the worktree and branch, and start a session for
  a task already in the backlog. Refuses when the task's scope-in claims tracked files a live
  session's scope already claims, naming the session and the shared files; `--allow-overlap`
  launches anyway and records what it waved through (decision 41). Operator-only: refused when
  run from inside a session, like `pup new`, `pup plan add|drop|edit` and `pup merge --pr`
  (decisions 26, 42).
- `pup new "<goal>" --scope <glob>...` — plan and launch in one step; the daily path. Takes
  `--allow-overlap` for the same reason `pup launch` does.
- `pup status` — all sessions by state, the backlog under `planned`, pending reviews, live scope
  overlaps between running sessions.
- `pup steer <session> "<message>"` — inject a correction into a running session.
- `pup interrupt <session> ["<message>"]` — abort the in-flight tool call (Escape to the pane), optionally steering a message after; the hung-tool escape hatch steer cannot reach (decision 37).
- `pup kill <session> [--respawn]` — stop; `--respawn` relaunches on a fresh context window. A
  killed session's task returns to the backlog, so `pup launch` can retry it. Operator-only for
  the same reason `pup launch` is: killing releases the holder's scope (decision 42).

## Review and merge

- `pup review` — the queue: pending branches ordered by risk score, each with generated diff summary, gate results, debt delta.
- `pup review <session>` — full detail for one branch.
- `pup merge <session>` — run the gate pipeline; on pass, merge and write knowledge layer in the same transaction; on fail, move to rejected and inject the report.
- `pup merge <session> --accept-debt "<reason>" --review-by "<condition>"` — merge despite a flagged shortcut, creating a ledger entry.

## Knowledge

- `pup map [module]` — code map: text tree by default, `--open` renders the interactive mind-map view.
- `pup report [--open]` — render the project report into the project dir: `report.html` (the backlog of planned tasks, sessions newest first with the goal that launched them, baseline drift from capture history, open debt, decision records) plus one `session-<id>.html` dossier per session — the full intent with acceptance criteria, the complete event timeline with every gate run, what merged (files and PR), and the session's decision records. The index links each session to its dossier. `--open` also launches the index in the browser (best-effort).
- `pup debt` — open ledger entries, oldest first, with review-by conditions.
- `pup log [module]` — decision records, filterable by module or file.

## Configuration

- `pup profile list | show <name> | edit <name>` — manage base and role layers.
- `pup profile stale` — running sessions whose profile version is behind current.
- `pup audit --sweep` — spawn a deletion-only session (dead code, unused deps) from the latest audit findings.

## Risk score (used by `pup review`)

Weighted sum of: diff size vs task size, scope violations logged, debt delta, hot-path or architectural-boundary files touched, overlap with another live session, coverage delta. High risk means deep human review; low risk means skim. A random sample of low-risk merges is periodically flagged for deep review to keep the gate honest.
