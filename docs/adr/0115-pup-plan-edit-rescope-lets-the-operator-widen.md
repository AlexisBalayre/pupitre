# 0115. `pup plan edit --rescope` lets the operator widen a claimed task's scope-in, appending only, once no session is at work on it (2026-10-28)

- Status: accepted
- Amends: [0040](0040-a-task-can-exist-before-a-session-the.md)

115. **`pup plan edit --rescope` lets the operator widen a claimed task's scope-in,
    appending only, once no session is at work on it (2026-10-28).** Decision 40 froze a
    spec once a session claims its task, so the store never disagrees with what the agent
    was told. A CI review round (decision 90) can still ask for an edit outside scope-in,
    and the re-gate then fails scope-audit with no way out: on #161 the operator edited
    `tasks.spec` in `state.db` by hand.
    *The command.* `pup plan edit <task> --rescope --scope <glob...>` appends the globs not
    already there to the task's scope-in. It never removes one and takes no other field, so
    it can only let a session commit more, never less, and the goal and acceptance the
    session was told stay as they were. The widened spec passes `assertPlannableSpec`, as
    every stored spec does.
    *Who.* The operator only. A session is refused by `pup plan`'s existing rule (decision
    40), and the conductor here too: the conductor runs the fix rounds that hit the scope
    failure, and a scope the gate-failing side widens for itself is no scope at all.
    *When.* Refused while a session on the task is `queued`, `running` or `rejected`: its
    hooks were compiled from the old scope, and a rejected session is being steered back to
    work. `awaiting-review`, `merged`, `blocked` and `killed` are fine. The guard is in the
    `UPDATE` statement itself, so a launch or fix round that starts after the check still
    wins. A task no session claims is refused too: plain `pup plan edit --scope` edits it.
    *What reads it.* The gate's scope-audit, `pup review` and `pup fix`'s recompiled
    profile all read `tasks.spec` through `readTaskSpec`, so the next re-gate and the next
    round's hooks see the widened scope with nothing else changed. Scope-out still wins
    over scope-in at the gate, so a glob added under a scope-out one opens nothing.
    *The record.* In the same transaction as the write, a `rescope` event on the claiming
    session names the task, the added globs and `by: 'operator'`, and a decision record on
    that session lists the added globs as its files, so `pup log` (and `pup log <module>`)
    shows the rescope beside the merges it changes.
    *Tests.* In `task-rescope.test.ts`, a rescope on a merged, awaiting-review or blocked
    session's task appends, writes the event and the record; a queued, running or rejected
    one writes nothing; a re-gate's scope-audit then passes the added path and still fails
    a scope-out one. `session-repository.test.ts` holds the statement's guard to each
    state, and `index.test.ts` refuses a session and the conductor.
