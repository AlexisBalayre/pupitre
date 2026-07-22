# Pupitre

Control plane for parallel Claude Code sessions. CLI binary: `pup`. Single-package TypeScript
ESM app (Node >= 20, commander, better-sqlite3).

## Role

Expert TypeScript / Node.js architect.

**Core rule:** Before creating or modifying code, read 2-3 similar files in the same directory and match their patterns exactly.

## Design docs

`docs/00`–`08` are the design; `docs/09-decisions.md` records resolved decisions and **wins over
00–08 where they conflict**. Read 09 before implementing anything it touches.

## Layout

| Path            | What it is                                                            |
| :-------------- | :-------------------------------------------------------------------- |
| `src/cli/`      | commander commands, thin; logic lives in core                         |
| `src/core/`     | session lifecycle, profile compiler, gate pipeline, knowledge, store  |
| `src/claude/`   | the ONLY module that touches Claude Code (tmux, hooks, `claude -p`)   |
| `src/adapters/` | per-language toolchain plugins (interface in `docs/06-adapters.md`)   |

## Conventions

Path-scoped rules in `.claude/rules/*.md` auto-load the matching `docs/conventions/<area>.md`
when you touch a file in that area. Priority: correct > simple > readable > fast; no abstraction
until third use; no new dependency without checking `docs/08-roadmap.md` stack decisions.

## Git workflow (CRITICAL)

- NEVER work on or push to `main`. PRs only.
- ALWAYS use `pnpm worktree:create <name>` (creates `.worktrees/<name>` with `feature/<name>`). NEVER `git checkout -b` in the main worktree.
- `git branch --show-current` MUST NOT be `main` before committing.

## Key commands

| Command                       | Purpose                                        |
| :---------------------------- | :--------------------------------------------- |
| `pnpm dev`                    | Run the CLI from source (tsx)                  |
| `pnpm test`                   | Vitest; tests live next to sources (`*.test.ts`) |
| `pnpm worktree:create <name>` | Create worktree at `.worktrees/<name>`         |
| `pnpm worktree:clean`         | Remove worktrees with deleted remote branches  |

**Formatting/typechecking:** Biome + tsc run automatically via the `Stop` hook. Don't run them manually.

## Subagents (invoke proactively via Agent tool)

- `convention-checker` — before commit, or after ≥3 files changed in `src/`.
- `security-reviewer` — after editing hook generation, profile compilation, or anything that shells out.
- `architecture-explainer` — for *why*/*how* questions about module boundaries or the gate pipeline.
