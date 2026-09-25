# Pupitre

**Run many Claude Code sessions in parallel without losing the plot.**
One `pup` CLI to launch agents in isolated git worktrees, watch them for conflicts, gate every merge on build, tests, scope and technical-debt deltas, and keep a code map and decision log that a human can still read.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-5.9-3178c6.svg)](tsconfig.json)
[![Builds itself](https://img.shields.io/badge/dogfood-every%20PR%20through%20its%20own%20gate-8a2be2.svg)](docs/09-decisions.md)

*Pupitre* is French for a conductor's music stand: one human at the stand, many sessions playing from the same score.

```
$ pup status
conductor running (attach: tmux -L pup-conductor-ff2f27df5be3 attach -t pup-conductor-ff2f27df5be3)
running          t-mu5pi7e7                   pup/t-mu5pi7e7  ctx ~82k
awaiting-review  t-mtni8c6t                   pup/t-mtni8c6t
merged           t-mtnhzefj                   pup/t-mtnhzefj
planned          t-mu5q4mss                   Close the scope layer's write-route gap: re…  (from conductor)
planned          t-msak5t7t                   In pushBranch in src/core/merge-gate.servic…
```

## Why

Parallel agentic coding moves the bottleneck from writing code to human attention. Four things go wrong, quietly:

- **Divergence.** Sessions solve overlapping problems three different ways.
- **Review saturation.** Generation outruns review, so you either block or rubber-stamp.
- **Context drift.** Long sessions forget the intent and the codebase's conventions.
- **Invisible debt.** Shortcuts land unreviewed and nobody remembers taking them.

Pupitre exists so that an engineer can still *master* a codebase that agents are writing, and challenge the AI instead of nodding it through. Understanding is the product. The gate and the ledger are how it stays true.

## What you get

| Concern | What `pup` does |
| --- | --- |
| Isolation | One git worktree and branch per session, created and destroyed by the tool. Nothing runs on a shared checkout. |
| Context | A profile compiler builds each session's `CLAUDE.md`, hooks, agents and skills from versioned layers (base, role, task), hashed and recorded. |
| Scope | A PreToolUse hook refuses edits outside the task's scope. Violations are events, not surprises. |
| Conflict radar | `pup watch` scans live diffs for same-file overlaps and revives sessions whose turn died. |
| Merge gate | `pup merge` runs build, tests, lint, a scope audit, then debt deltas: duplication, dead code, complexity, coverage, diff size. Deltas against a baseline, never absolutes, with a ratchet so quality only tightens. |
| Debt ledger | A flagged shortcut merges only with `--accept-debt <reason>` and a review-by condition. `pup debt` lists what is open, `pup status` shows what is overdue. |
| Knowledge | Every merge writes a decision record. `pup log`, `pup map --open` and `pup report --open` show what exists and why. |
| Conductor | `pup conductor` starts one Claude Code session that plans, launches, steers and reports on the workers. It holds every power except the merge. The merge stays yours. |
| Dashboard | `pup ui` is a live terminal dashboard: sessions, backlog, debt and the conflict radar in one place. |
| Console | Any Claude Code window you open is the operator's hands. The shipped `pup` skill teaches it the commands, the tiers and the loop, so you drive everything in conversation, from inside a repo or across the fleet. |

All state lives under `~/.pupitre/<project-id>/`. Adopting Pupitre commits nothing to your repo.

## Quickstart

Requirements: Node 22+ (24 recommended), git, [tmux](https://github.com/tmux/tmux), the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI. Optional: [`gh`](https://cli.github.com/) for `pup merge --pr`, [CodeGraph](https://github.com/colbymchenry/codegraph) so sessions query a code graph instead of grepping.

```bash
git clone https://github.com/AlexisBalayre/pupitre.git
cd pupitre
pnpm install
pnpm build
pnpm link --global      # puts `pup` on your PATH
```

Then, in the repo you want to work on:

```bash
pup init                                    # detect the stack, snapshot a baseline, draft conventions
pup new "Add retry to the payments client" --scope src/payments/**
pup status                                  # who needs you now
pup review                                  # risk-ordered queue of branches awaiting review
pup merge <session> --pr                    # gate, then push and open the pull request
pup log payments                            # the decisions that landed, newest first
```

Day one blocks nothing: `pup init` records every metric as it is, debt included, and the gate only refuses regressions from there.

## Talk to it

You do not have to learn the commands. Link the shipped skill once:

```bash
ln -s "$(pwd)/skills/pup" ~/.claude/skills/pup   # from the pupitre checkout
```

Then open `claude` anywhere and say "use pup". Inside a registered repo the conversation is about
that project: "what needs me", "plan a task for the dead exports init found", "steer t-abc to add a
test for the empty case", "gate it and open the PR". Outside any repo it is about the fleet: every
project, what needs you in each, and `--project <id>` to act on one. The skill carries the
vocabulary, the tiers (a session edits inside its scope, the conductor plans and steers but never
merges, the operator gates and closes debt), and the per-task loop from a finished branch to a
merged pull request. The one thing it will not do is merge on GitHub. That click stays yours.

Every window you open by hand is the operator, so the console can do what the conductor is
refused: gate, close debt, reach another project. It explains before it merges, kills or closes
debt.

## The loop

```
pup plan add / pup new ──▶ session in .worktrees/<task>, compiled profile, scope hook armed
        │
        ▼
pup status · pup ui · pup watch ──▶ stalled, blocked or overlapping sessions surface first
        │
        ▼
pup steer · pup interrupt · pup respawn ──▶ correct without restarting from zero
        │
        ▼
pup review ──▶ pup merge [--pr] ──▶ gate: build → tests → lint → scope → debt delta → knowledge transaction
        │                                   │
        │                              rejected? the report is injected back into the session
        ▼
pup log · pup map · pup report · pup debt ──▶ what exists, why, and what is still owed
```

Or let the conductor drive: `pup conductor start` and it plans the backlog, launches workers on the model you choose, reads their idle notices, steers them, and hands you a verified summary when a branch is ready for your review.

## How it differs

Most tools in this space help you run *more* sessions: a multiplexer, a kanban board, an IDE with a worktree per agent. They stop at the branch. Pupitre starts there.

| | Session managers and agent IDEs | Pupitre |
| --- | --- | --- |
| Unit of work | A pane, a card, a tab | A task spec with scope-in, scope-out and acceptance criteria |
| What the agent can touch | Whatever it decides | The scope, enforced by a hook before the edit lands |
| What merges | Whatever you approve | What passes build, tests, lint, scope audit and a debt delta against a baseline |
| Shortcuts | Forgotten | Refused, or recorded in a ledger with a review-by condition |
| What you keep afterwards | Branches | A decision record per merge, a code map, an HTML report |
| Who runs the fleet | You | You, or one conductor session that plans and steers while you keep the merge |

If you only want to see six terminals at once, one of the multiplexers is lighter. If you want to still understand the codebase in three months, this is the bet Pupitre makes.

## Built on itself

Pupitre has been developed with Pupitre since its second week. Its own pull requests go through its own gate, its backlog is driven by its own conductor, and every design choice that mattered is a numbered entry in [`docs/09-decisions.md`](docs/09-decisions.md), including the ones that went wrong first. If you want to see what a session-hardened merge gate looks like, read the decisions on scope hooks, push-target pinning and the debt ratchet.

## Design docs

| | |
| --- | --- |
| [00 Overview](docs/00-overview.md) | Problem, goals, non-goals, principles |
| [01 Architecture](docs/01-architecture.md) | Components, data model, session state machine |
| [02 CLI](docs/02-cli.md) | Every command and what it refuses |
| [03 Profiles](docs/03-profiles.md) | The profile compiler and its layers |
| [04 Gates and debt](docs/04-gates-and-debt.md) | Gate stages, baseline, ratchet, ledger |
| [05 Knowledge layer](docs/05-knowledge-layer.md) | Code map, decision records, report |
| [06 Adapters](docs/06-adapters.md) | Per-language toolchain plugins |
| [07 Onboarding](docs/07-onboarding.md) | `pup init` on an existing repo |
| [08 Roadmap](docs/08-roadmap.md) | Stack decisions and what comes next |
| [09 Decisions](docs/09-decisions.md) | Numbered decisions; wins over 00 to 08 where they conflict |

## Status

Early and opinionated. Single user, single machine, TypeScript adapter first. Claude Code is the only agent it drives today. Expect the CLI surface to move; the decisions log says when and why.

## Contributing

Issues and pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the setup, the worktree loop, the conventions and the pull request format; [`AGENTS.md`](AGENTS.md) is the same brief the project's own sessions get. Work happens on a branch, never on `main`, and the pre-commit hook you install once lints, typechecks and runs the tests before every commit.

## License

[MIT](LICENSE)
