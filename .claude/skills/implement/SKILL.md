---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user by hand: one GitHub issue, one `pup plan` task, or the conversation. This is the console's path for a change too small to plan as tasks; a task pup launched is a worker's job, and `/to-tickets` plans the larger ones.

If the user passes an issue number or URL, read it in full with `gh issue view <n> --comments` and state its title before starting. If the reference is ambiguous, ask. For a `pup plan` task, `pup plan` lists only its goal headline and scope-in globs, not its acceptance criteria: ask the operator for those.

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run typechecking regularly (`TYPECHECK_CMD`), single test files regularly, and the full test suite (`TEST_CMD`) once at the end. Both commands live in `.claude/project.env`; an empty key means that check is off. Formatting, lint and typecheck also run automatically on the Stop hook.

Once done, review the diff against the issue or task: every acceptance criterion met, nothing built beyond them. If the work is a `pup plan` task, its scope-in globs bound the diff the same way the merge gate will; a file outside them is a scope decision for the operator, not something to slip in.

Commit your work to the current branch. If that branch is the trunk (`GIT_TRUNK` in `.claude/project.env`, default `main`), create a worktree with `pnpm worktree:create <name>` and commit there instead; the pre-commit hook runs the tests. Open the PR with `/pr-description`, writing `Closes #<n>` for an issue.
