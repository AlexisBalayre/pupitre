# Pupitre

Control plane for parallel Claude Code sessions. CLI binary: `pup`.

Instructions for AI coding agents, whatever the tool. Tool-specific layers build on this file: Claude Code adds `CLAUDE.md` and `.claude/`.

**Core rule:** Before creating or modifying code, read 2-3 similar files in the same directory and match their patterns exactly.

## Design docs

`docs/00`–`08` are the design; `docs/09-decisions.md` records resolved decisions and **wins over
00–08 where they conflict**. Read 09 before implementing anything it touches.

## Module boundaries

- `src/cli/` stays thin; logic lives in `src/core/`.
- `src/claude/` is the ONLY module that touches Claude Code (tmux, hooks, `claude -p`).

## Conventions

`docs/conventions/` is the single source of truth. The conventions for every area covering a file must be in context before you touch it: Claude Code injects them through `.claude/rules/`; other tools read them from this table.

| Area | Paths | Conventions |
| --- | --- | --- |
| Core | `**/*.ts`, `**/*.tsx` | `docs/conventions/general.md`, `docs/conventions/naming.md` |
| Testing | `**/*.test.ts`, `**/*.integration.test.ts` | `docs/conventions/testing.md` |

Priority: correct > simple > readable > fast; no abstraction until third use; no new dependency
without checking `docs/08-roadmap.md` stack decisions.

## Comments

Default to no inline comment. Add one only for a non-obvious WHY (invariant, unit, ordering, gotcha), never to narrate WHAT the code does. If removing a comment wouldn't confuse a competent reader, delete it. A WHY comment that restates the callee's JSDoc is a duplicate: read the callee's docs before keeping it; if the seam already says it, delete the call-site copy.

```
retries += 1; // increment the retry counter           (BAD: restates the code)
retries += 1; // 429s are transient, so retry first    (GOOD: explains the why)
```

## Altitude

Build the smallest thing that works; the obligation lives in `docs/conventions/general.md` §Altitude / YAGNI. Before finishing a change that introduced any discretionary construct (new file, helper, wrapper, option, param, interface, generic, or defensive branch), list each one with a keep-or-inline verdict; keep means you can name a second caller or a real WHY. Default to inline/delete. Don't list constructs a convention prescribes, and skip the audit silently when a change added none. Unjustifiable bloat is a `/simplify` candidate.

## Git workflow (CRITICAL)

- NEVER work on or push to `main`. PRs only.
- ALWAYS use `pnpm worktree:create <name>` (creates `.worktrees/<name>` with `feature/<name>`). NEVER `git checkout -b` in the main worktree.
- `git branch --show-current` MUST NOT be `main` before committing.

## Key commands

Lint, typecheck, test and install commands live in `.claude/project.env` (`LINT_CMD`, `TYPECHECK_CMD`, `TEST_CMD`, `INSTALL_CMD`). `pnpm dev` runs the CLI from source. Use the Node in `.nvmrc`: the native modules are built for it, and `pnpm dev` segfaults on older Nodes while the tests still pass.

**Formatting/typechecking:** run the lint and typecheck commands before handing work back. (Claude Code only: don't run them manually; its `Stop` hook runs them automatically.)
