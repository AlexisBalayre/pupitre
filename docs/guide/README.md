# Pupitre guide

For a developer new to pupitre. Each page is short and points to the design docs and the
[decision records](../adr/README.md) for the why. Where a design doc (`docs/00` to `08`) and a
decision disagree, the decision wins, and this guide follows the decisions and the source.

| Page | Read it to |
| --- | --- |
| [Getting started](getting-started.md) | Install `pup`, run `pup init`, take one task from `pup new` to a merged PR |
| [Concepts](concepts.md) | Session, worktree, conductor, gate, debt, profile, intent, ledger; how the pieces fit |
| [Command guide](commands.md) | Every command, grouped by workflow: plan, launch, steer, review, merge, land, fix, status, ui, dashboard, report |
| [The gate and debt](gate-and-debt.md) | What `pup merge` checks, in what order, what is refused and what can be accepted as debt |
| [Configuration and profiles](configuration.md) | Project settings, profile layers, what is compiled into each session |
| [Best practices](best-practices.md) | Using Claude Code well inside pupitre: fast, accurate, reliable, cheap |
| [Troubleshooting](troubleshooting.md) | The refusals and stuck states you will meet, and what to do |

Reference: [`pup --help`](commands.md#reading-the-help) is the source of truth for flags.
