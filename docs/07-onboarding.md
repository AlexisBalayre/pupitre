# Onboarding an existing project (`pup init`)

Pluggable means: no committed structure required, nothing blocked on day one, works on any repo. State lives in `~/.pupitre/<project-id>/`; only an optional `.pupitre.yml` (shared config, hot paths) touches the repo.

## Phase 1 — audit (read-only)

- Stack detection and adapter selection.
- Mechanical inventory via adapters: dependency graph, dead code, duplication clusters, complexity hotspots, untested files.
- Claude audit sessions (read-only worktree) produce what analysis cannot:
  - Inferred conventions: naming, error handling, layering, as actually practised.
  - Risk map: load-bearing modules, churn-heavy files, untested critical paths. Feeds review risk scoring from day one.
- Output: initial code map, debt inventory, draft conventions file, risk map.

## Phase 2 — baseline

- Snapshot every gate metric as-is. The project passes immediately, debt included.
- Ratchet armed: baselines tighten only when metrics improve.

## Phase 3 — review step (mandatory, human)

- Correct the draft conventions and risk map before any session runs. Inferred patterns are partly wrong on messy codebases; ten minutes here prevents fifty sessions replicating a misread pattern.
- Confirm adapter command resolution (build, test, lint).
- The natural place to do both is a Claude Code window with the `pup` skill loaded (`skills/pup/`, linked into `~/.claude/skills/`): it reads the findings back, drafts the first task specs from them, and runs every step of the loop in conversation (decision 70).

## Phase 4 — improve and continue

- Each audit finding becomes a pre-scoped task spec with origin `audit`: e.g. "remove dead exports in payments/", "add tests to core/session.ts", "deduplicate the three date formatters".
- These enter the normal `pup new` loop. Recommended standing practice: one or two parallel sessions permanently on debt tasks, which is what moves the ratchet.
- Greenfield repos are the degenerate case: audit finds nothing, conventions are drafted from your profile defaults, same code path throughout.

## Re-audit

- `pup audit` re-runs phase 1 incrementally at any time; diffs against the previous inventory become new task specs.
