---
name: to-tickets
description: Break an approved feature ticket, a plan, or the current conversation into tracer-bullet slices with their dependency edges, then plan one pup task per slice and launch the ones that are free.
disable-model-invocation: true
---

# To Tickets

Break a feature ticket, plan or conversation into **slices**: tracer-bullet vertical cuts, each naming the slices that block it. Then plan one pup task per slice (`pup plan add`) and launch the free ones. A slice is the unit of a worker session: one fresh session per slice, never steered after its PR merges (decision 176).

## Process

### 1. Gather context

Work from whatever is already in the conversation. If the user passes a reference, read it in full: an issue number or URL with `gh issue view <n> --comments`, a design note or spike path with Read. A feature ticket should carry `design-approved` (decision 176) before you slice it; if it does not, say so and stop, unless the user says it is a one-slice change that needs no design.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Slice titles and goals use the project's own vocabulary (the `SCHEMA` nouns in `src/core/db.client.ts`, the decisions in `docs/adr/`, found through `bash scripts/adr-index.sh`) and respect the decisions covering the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit one fresh session's context window
- Any prefactoring is its own slice, first

</vertical-slice-rules>

For each slice, write down:

- **Goal**: the end-to-end behaviour it makes work, and the decision number it records, if any.
- **Scope-in**: the globs the session may edit. Name every file the slice touches, including the test files that encode a contract it changes: a task that tightens a contract and leaves its old tests out of scope is blocked at commit.
- **Size**: small, medium or large, by files and tests touched.
- **Blocked by**: the slices that must land first. **Two slices whose scope-in overlap get an edge**, so one merges before the other starts. A slice with no blockers can start now.
- **Acceptance**: checkable sentences, one per criterion. A criterion starting with `--` parses as an option: reword it.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Sequence it as **expand-contract**: first expand (add the new form beside the old, so nothing breaks), then migrate the call sites in batches sized by blast radius, each its own slice blocked by the expand, and finally contract (delete the old form once no caller remains) in a slice blocked by every batch.

### 4. Quiz the user

Present the breakdown as a numbered list. For each slice show the title, what it delivers, its scope-in, its size and what blocks it. Ask:

- Does the granularity feel right (too coarse or too fine)?
- Does each slice only depend on slices that genuinely gate it, and does every overlap have its edge?
- Should any slices be merged or split?

Iterate until the user approves the breakdown. When the slice list belongs in a design note on the ticket, post it there with `gh issue comment <n> --body-file <file>` (a file outside the repo) so the design review sees the same list.

### 5. Plan and launch

Record one task per approved slice, blockers first:

```sh
pup plan add "<goal>" --scope <glob>... --accept "<criterion>"...
```

`pup plan` lists the backlog with each task's tier. Pass `--tier critical` only when the scope-in does not already imply it. Then launch the **frontier**, the slices whose blockers are all landed: `pup launch <task>`. It refuses while the merge lock's backlog is over budget, the load is above the allowance, memory is under the floor or the usage window is held; do not pass `--over-cap` or `--over-limit` yourself, and wait or tell the operator instead. For a purely linear chain, that means top to bottom.

From here the loop is pup's: the gate, `pup ci wait` and `pup fix` (the conductor runs them when it is up), then the merge. Read `skills/pup/LOOP.md` before your first gate or steer. When a slice lands, launch the next slice it unblocked. Never watch a PR's checks by hand (`gh pr checks --watch` is forbidden).

Do NOT close or modify the parent issue: a slice's PR closes it with `Closes #N`, and only the last slice should.

In every slice, avoid specific code snippets: they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype.
