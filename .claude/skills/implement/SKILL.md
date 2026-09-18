---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets (a `docs/plans/<slug>/` file, a `pup plan` task, or the conversation).

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run typechecking regularly (`TYPECHECK_CMD`), single test files regularly, and the full test suite (`TEST_CMD`) once at the end. Both commands live in `.claude/project.env`; an empty key means that check is off. Formatting, lint and typecheck also run automatically on the Stop hook.

Once done, review the diff against the spec or tickets: every acceptance criterion met, nothing built beyond them. If the spec is a `pup plan` task, its scope-in globs bound the diff the same way the merge gate will; a file outside them is a scope decision for the operator, not something to slip in.

Commit your work to the current branch. If that branch is the trunk (`GIT_TRUNK` in `.claude/project.env`, default `main`), create a worktree with `pnpm worktree:create <name>` and commit there instead; the pre-commit hook runs the tests.
