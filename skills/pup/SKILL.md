---
name: pup
description: Drive pupitre (`pup`), the control plane for parallel Claude Code sessions, from any shell. Use when the user says "use pup", asks about their pupitre projects, sessions, backlog, conductor, gate or debt, or wants a task planned, launched, steered, reviewed or merged through pup.
---

# pup: operate pupitre from a Claude Code session

You are the operator's hands. A Claude Code window the human opened themselves carries neither
`PUP_SESSION_ID` nor `PUP_CONDUCTOR`, so every `pup` command you run is the operator's, including
the ones refused to sessions and conductors. Explain before you act on anything irreversible
(merge, kill, debt close) and never merge a pull request on GitHub: that click is the human's.

## Scope follows the current directory

- Inside a registered repo: every command acts on that project.
- Outside any repo: `pup status` and `pup ui` show the fleet (every project, what needs you in
  each). Every other command needs `--project <id>`; the ids are what the fleet view prints.
- `pup --project <id> <command>` drives any project from anywhere.
- Start every conversation with `pup status` (or `pup status --all`) and read it back to the
  human in one or two lines: blocked and stalled first, then awaiting-review, then planned.
- `pup` not on PATH: run `pnpm dev <command>` from the pupitre checkout, or `pnpm link --global` there.
- Check `echo "$PUP_SESSION_ID $PUP_CONDUCTOR"` once. Both empty: you are the operator's console and
  this skill applies. Either set because `pup launch` or `pup conductor start` opened your window:
  you are a session or the conductor, the operator stance above does not apply, and the commands
  refused to you are refused by design. Set in a shell the human opened by hand: it leaked from
  an earlier launch; ask, then prefix `env -u PUP_CONDUCTOR` rather than exporting anything.

## Vocabulary

| Want | Command |
| --- | --- |
| Onboard a repo (operator only) | `pup init` in the repo; `pup init --gate-env A,B` for gate env vars |
| Record a task, no session | `pup plan add "<goal>" --scope <glob>... --accept "<criterion>"...` |
| Backlog | `pup plan` (list), `pup plan drop|edit <task>` |
| Start a session for a task | `pup launch <task> [--model m]`; `pup new "<goal>" --scope ...` plans and launches |
| Who needs me | `pup status`, `pup ui` (live), `pup watch` (conflict radar) |
| Talk to a session | `pup steer <session> "<message>"`; `pup interrupt <session>` for a hung tool |
| Stop or restart one | `pup kill <session> [--respawn]`, `pup respawn`, `pup unblock` |
| Review a branch | `pup review` (risk-ordered queue), `pup review <session>` |
| Gate and open the PR | `pup merge <session> --pr`; add `--accept-debt "<reason>" --review-by "<condition>"` for flagged stages |
| Debt and decisions | `pup debt`, `pup debt close <n>`, `pup log [module]`, `pup audit` |
| Delegate the whole loop | `pup conductor start [--model m --worker-model m]`, `pup conductor stop` |
| Project brief and registry | `pup brief show|edit`, `pup project list|dormant|wake <id>` |
| Reports | `pup report --open`, `pup map [module] --open` |

A goal names files, mechanism and the decision number it records; acceptance criteria are
checkable sentences. A criterion or goal starting with `--` is parsed as an option: reword it.

## Tiers you must respect

- Sessions edit code inside their scope and nothing else. The conductor plans, launches, steers
  and kills, edits nothing, and is refused `pup merge`, `pup respawn`, `pup debt close` and
  `--project`. Only the operator gates, closes debt and registers projects. Do not work around a
  refusal for a session or conductor; report it.
- The conductor runs in tmux on its own socket. `pup status` prints the attach line when it is
  up. Hand it an order by attaching, or paste into its pane with `tmux -L <socket> send-keys`
  followed by two Enters.
- `pup merge` runs from the project's main checkout, never from inside a `.worktrees/<task>`
  directory, which is refused as "sessions cannot merge sessions".

## The per-task loop

Worker done -> security review of `main...HEAD` in `.worktrees/<task>` -> one steer with the
must-fix items -> gate with `pup merge <task> --pr` -> address the CI review -> human merges ->
pull, `pnpm worktree:clean`, `pup audit`, next task. Details, the gate's flags and the gotchas
that bite every project are in [LOOP.md](LOOP.md); read it before your first gate or steer.
