# Architecture

## Components

- CLI (`pup`): the only interface in v1.
- Core library: session lifecycle, profile compiler, gate pipeline, knowledge layer.
- State store: SQLite at `~/.pupitre/<project-id>/state.db`.
- Adapters: per-language toolchain plugins (see 06-adapters.md).
- Watcher (v1.1): optional daemon for the conflict radar. v1 computes overlaps on demand at `pup status`.
- Dashboard (v2): local web UI. Not in v1.

## Layering

You (review, steer)
-> Orchestrator (scope hook, merge gate, conflict check)
-> Knowledge layer (code map, decision log, debt ledger)
-> Sessions (Claude Code, one git worktree each)

Sessions read the knowledge layer at compile time; the orchestrator writes it at merge time.

## Data model

- Project: id, repo path, adapters, baseline snapshot, config (`~/.pupitre/<id>/`, optional shared `.pupitre.yml` in repo root).
- Task: id, spec (goal, scope-in, scope-out, acceptance criteria), role, status, origin (human | audit | rejection).
- Session: task id, worktree path, branch, PID, state, profile hash, transcript path.
- Event: append-only log. Types: tool_call, scope_violation, gate_result, merge, steer, config_drift. All derived views come from this table.
- LedgerEntry: id, description, files, reason, accepted_by, review_by condition, status (open | closed).
- DecisionRecord: merge id, summary, alternatives rejected, conventions applied.

## Session state machine

planned (no session row) -> queued -> running -> awaiting-review -> merged
running -> killed -> planned (the task returns to the backlog)
awaiting-review -> rejected -> running (gate report injected as correction prompt)

`pup status` is a filter on state; the daily question is "which sessions need me now".

## Claude Code integration

- Launch: `claude -p` (headless) or interactive, inside the session worktree.
- Behaviour surface is files, all owned by the profile compiler: `CLAUDE.md`, `.claude/settings.json` (hooks), `.claude/agents/`, `.claude/skills/`, MCP config.
- PreToolUse hook enforces scope: Edit/Write outside scope-in, or touching `.claude/`, is blocked, not just logged.
- PostToolUse hook streams events to the store.

## Isolation

- One git worktree and branch per session, created and destroyed by Pupitre.
- No session runs on a shared checkout. Merges go through the gate only.
- Config drift check: periodic hash of the compiled `.claude/` directory against the recorded profile hash.
