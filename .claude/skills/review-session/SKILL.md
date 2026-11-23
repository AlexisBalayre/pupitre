---
name: review-session
description: Review a worker session's branch before the gate on a Standards axis and a Spec axis, and report a must-fix list for one pup steer.
disable-model-invocation: true
---

# Review a session before the gate

LOOP.md §2 as a skill. Run it from the main checkout on a session that reads `awaiting-review`, whether you are the console or the conductor. It reviews one branch before `pup merge --pr` and ends in one `pup steer`. It sits beside `/pr-ci-review`, not over it:

| | review-session | pr-ci-review |
| --- | --- | --- |
| When | before `pup merge --pr` | on the PR, in CI, after the gate |
| Who runs it | console or conductor, locally | `claude-code-action` |
| Output | a must-fix and nice-to-have list for one `pup steer` | inline threads that `pup fix` hands back |
| Cost | two subagents | the area roster plus a consolidator and validators |

It never gates and never merges: those stay the operator's or the conductor's next command.

## Process

### 1. Pin the fixed point

The diff is `main...HEAD` (three-dot, against the merge-base) in `.worktrees/<task>`: `git -C .worktrees/<task> diff main...HEAD`, with the commits from `git -C .worktrees/<task> log main..HEAD --oneline`. Before going on, confirm both refs resolve (`git rev-parse`) and the diff is not empty: a bad ref or an empty diff fails here, not inside two parallel subagents.

### 2. Find the spec

`pup review <session>` prints the task's `goal:`, `scope-in:`, `scope-out:` and `acceptance:`, and the ticket's slice criteria when the task carries a ticket (decision 187; no command writes tickets yet, so most tasks print none). Do not use `pup plan`: it lists only unclaimed tasks, and this session's is claimed. `gh issue view <n>` reads an issue the commits or the goal name. If there is no spec, the Spec subagent is skipped and the report says "no spec available".

### 3. Find the standards

`docs/conventions/*.md` for the areas the diff touches, and the decisions it touches, found through `bash scripts/adr-index.sh`. On top of them the Standards axis carries the smell baseline below, a fixed set of code smells (Fowler, _Refactoring_ ch.3) that applies even where the repo documents nothing. Two rules bind it: **the repo wins** where it endorses what the baseline would flag, and **every smell is a judgement call** ("possible Feature Envy"), never a hard violation. Skip anything tooling already enforces (lint, typecheck, the gate's stages).

- **Mysterious Name**: a name that does not say what it holds or does. Rename it.
- **Duplicated Code**: the same logic shape in more than one hunk. Extract it.
- **Feature Envy**: a method that reaches into another object's data more than its own. Move it.
- **Data Clumps**: the same few fields or params travelling together. Bundle them.
- **Primitive Obsession**: a string or number standing in for a domain concept. Give it a type.
- **Repeated Switches**: the same `switch` or `if` cascade on the same type, recurring. Share one map.
- **Shotgun Surgery**: one logical change scattered across many files. Gather it.
- **Divergent Change**: one file edited for several unrelated reasons. Split it.
- **Speculative Generality**: abstraction or options for needs the spec lacks. Inline it back.
- **Message Chains**: long `a.b().c().d()` walks. Hide them behind one method.
- **Middle Man**: a function that only delegates onward. Call the target direct.
- **Refused Bequest**: an implementer that ignores most of what it inherits. Use composition.

### 4. Spawn two subagents in parallel

Start each with a fresh context, in the foreground, both calls in one message. Use the agent types the CI review uses, so the local and CI reviews judge by the same rules.

- **Standards**: the `review-conventions` agent. Give it the diff command, the commit list, the standards files from step 3 and the smell baseline pasted in full (it has no other access to it). Ask for each place the diff breaks a documented standard (cite the file and rule), and each baseline smell (name it, quote the hunk), keeping hard violations apart from judgement calls. Under 400 words.
- **Spec**: the `review-spec` agent. Give it the diff command, the commit list and the spec text. Ask for requirements missing or partial, behaviour nobody asked for, and requirements that look implemented but wrong, quoting the spec line for each. Under 400 words.

When the diff touches hook generation, profile compilation, the gate or anything that shells out (`git`, `gh`, `tmux`, `claude -p`), add the `security-reviewer` agent as a third subagent, as LOOP.md §2 asks.

### 5. Report

Aggregate under `## Must fix` and `## Nice to have`, each finding with its file and line as evidence and the axis it came from (`Standards`, `Spec`, `Security`). Do not rerank across axes: a change can pass one and fail the other, and merging them lets one mask the other. End with one line: the count per axis and the worst finding within each.

Suggest a mutation probe for every new test: plant a regression in a **backup copy** of the file, run the test, restore from the copy, never `git checkout --`.

### 6. Steer

Send the must-fix items as ONE `pup steer <session> "<message>"`. Name only files inside the task's scope: a new file outside `scopeIn` fails the scope audit, so say so in the steer. Then wait for the fix commit and the next `awaiting-review`. With nothing to fix, say so and let the gate run.
