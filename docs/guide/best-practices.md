# Best practices: Claude Code inside pupitre

Each practice names the decision behind it; the reasoning and the measurements are in the
[decision records](../adr/README.md), not repeated here. Figures quoted are the ones those
decisions record from `pup usage` and `pup retro`.

## Size the task, and scope it narrowly

- **One task, one reviewable slice.** The gate refuses a diff over 600 source lines and a touched
  file that gains more than 15 decision points (50 for a new file), and `--accept-debt` no longer
  clears either. Oversize PRs drew the most review findings, so split before launching
  ([173](../adr/0173-the-diff-size-and-complexity-caps-are-hard-and.md), [110](../adr/0110-the-diff-size-flag-counts-source-lines-only.md)).
- **Scope-in is the smallest set of globs that does the job.** The hook enforces it, and the
  kickoff lists the tracked files the globs match (at most 40), so a wide glob is also a longer
  context on every request ([128](../adr/0128-a-kickoff-names-the-tracked-files-its-scope-in-matches.md)). A glob that can reach the gate, store, sandbox or
  profile compiler makes the task *critical* and routes it to a costlier model
  ([92](../adr/0092-pup-routes-every-window-s-model-and-effort.md)). Widen a claimed task later with `pup plan edit --rescope`, append-only
  ([115](../adr/0115-pup-plan-edit-rescope-lets-the-operator-widen.md)).
- **Overlap is allowed, not free.** Two live sessions on the same files are introduced to each
  other rather than refused ([99](../adr/0099-workers-share-files-and-collaborate-a-launch-overlapping.md)); `pup watch` shows the overlaps. Prefer disjoint scopes.

## Write acceptance criteria you can check

Pass each as `--accept "<criterion>"`; without any, a task defaults to "goal met and committed",
which a reviewer cannot test. Write observable outcomes (a command's output, a test that exists).
For work whose point is your understanding, write an [intent](concepts.md#glossary) first: it
carries two or three questions you must answer after review ([126](../adr/0126-an-intent-is-a-file-under-docs-intent-the.md)). A review finding that
claims a defect needs a failing scenario ([174](../adr/0174-review-runs-in-stages-and-an-important-finding-needs.md)); hold your criteria to the same bar.

## Model tiers and the rung ladder

pup picks the model and effort from the tier ([92](../adr/0092-pup-routes-every-window-s-model-and-effort.md), `src/claude/constants/model-ladder.constants.ts`):

| Tier | Ladder, one rung per failure |
| --- | --- |
| standard | sonnet medium, sonnet high, opus high, opus xhigh |
| critical | opus high, opus xhigh |

A turn that died, a gate rejection or a stall climbs one rung; a block does not. Past the top rung
the task goes to you, except a security or wrong-result review finding, which the conductor runs
once more at the top ([202](../adr/0202-the-conductor-runs-a-fix-round-past-the-top-rung-for.md)). pup never picks a Fable model or `max` effort. A worker's
subagents are pinned to Haiku at low effort ([152](../adr/0152-a-worker-s-settings-pin-its-subagents-to-haiku-at-low.md)). Override a launch with `--model` and
`--effort` only with a reason: the ladder exists so cheap runs are the default and failures pay for
the climb.

## Context hygiene

- **Compaction is the default reset.** Blind-graded, compaction kept 78% of the facts and a
  handoff respawn 80%, and resetting near 120k to 150k instead of 267k would have cut 23% of
  spend ([200](../adr/0200-compaction-is-the-default-context-reset-respawn-is.md), [192](../adr/0192-pup-retro-replays-each-transcript-under-lower-compaction.md)). Keep `autoCompactWindow` at its 150000 default unless
  you measure otherwise ([configuration](configuration.md#project-settings-pupitreprojectyml)).
- **After a compaction the session re-reads live state** (branch, commits, gate result) from a
  hook, not from the summary ([199](../adr/0199-a-compaction-restarts-from-live-state-read-by-a.md)).
- **Respawn for a change of model or topic, or a wedged window.** `pup respawn <session>` asks
  for a handoff and relaunches on a fresh context that starts from that document
  ([49](../adr/0049-a-respawn-kicks-off-on-the-document-the.md), [200](../adr/0200-compaction-is-the-default-context-reset-respawn-is.md)); `pup kill <session> --respawn` skips the handoff.
- **`/clear` inside a pup window is not a pup path.** No decision covers it, and it drops the task
  context the kickoff built. For a new topic, start a new session ([below](#one-fresh-session-per-task)).
- **Keep tool output small.** Workers are told to batch commands, ask for quiet output and not
  re-read output already in context, since every result is re-sent on each later request; the
  retro called this its largest finding ([189](../adr/0189-workers-keep-tool-output-small-and-pup-s-worker.md)).

## Parallelism and load

The merge lock, not the number of windows, is the limit: over seven days 73 sessions took it for
126 gates and 135 lands at about 6 to 7 minutes of tests each, and one land's timing test failed at
a load average of 37 on 8 cores ([197](../adr/0197-launches-follow-the-merge-lock-s-backlog-and-the.md)). So launches follow the lock's backlog and the
machine's load, not a fixed count. Tune with `lockBacklogBudgetMinutes` and
`loadAllowanceFactor` in `.pupitre/project.yml`. Related details:

- Test runs queue for a few machine-wide slots and a gate's test run takes the machine
  ([96](../adr/0096-test-runs-queue-for-a-few-machine-wide.md), [140](../adr/0140-a-merge-gate-s-test-run-takes-the-machine-no.md)); workers run only related tests, at nice 10 ([94](../adr/0094-worker-windows-run-at-nice-10-workers-run.md)).
- Launches also hold while the plan's usage windows run low ([156](../adr/0156-launches-hold-while-the-plan-s-usage-windows-run-low.md)).
- A session awaiting review does not count against the limits ([144](../adr/0144-the-session-cap-counts-working-sessions-not-those.md)). Review promptly.
- `--over-cap` and `--over-limit` are overrides for you, not defaults.

## CLAUDE.md, AGENTS.md and conventions: keep them lean

A compiled context is paid for on every request of every worker ([189](../adr/0189-workers-keep-tool-output-small-and-pup-s-worker.md)), and a profile's
`contextBudget` is checked, so a wrong value would disable the check ([71](../adr/0071-parseprofilelayer-types-extends-and-contextbudget-at-the-parser.md)). The built-in
base layer is four lines of conventions. Put rules the machine can enforce in the gate, not in prose,
and per-task facts in the task spec. Point to documents instead of pasting them: this repo's own
[CLAUDE.md](../../CLAUDE.md) is 12 lines importing [AGENTS.md](../../AGENTS.md). The project brief
splits once so sessions get only Destination and Constraints ([57](../adr/0057-a-project-has-one-brief-written-by-the.md)).

## Hooks and sandboxing

Sessions run with permissions bypassed, so the compiled hooks are the enforcement layer
([5](../adr/0005-sessions-run-with-permissions-bypassed-compiled-hooks-are.md)): scope on Edit and Write, a text check on Bash that is best-effort
([6](../adr/0006-bash-scope-checking-is-best-effort.md)) and a re-check of the worktree after each Bash call ([63](../adr/0063-every-bash-call-is-re-checked-against-the.md)), and Read for
tracked files rather than `cat` ([112](../adr/0112-a-worker-reads-a-tracked-file-with-the.md)). Interactive prompts a worker cannot answer
are denied; it asks with `pup session ask` and you answer with `pup answer` ([74](../adr/0074-a-worker-is-kept-off-the-screens-pup.md),
[76](../adr/0076-a-blocked-worker-asks-with-pup-session-ask.md), [93](../adr/0093-a-question-offers-numbered-options-and-pup-answer.md)). Gate children run in a generated `sandbox-exec` profile
([36](../adr/0036-gate-children-run-inside-a-pup-generated-sandbox.md)); `workerSandbox: true` also sandboxes a worker's Bash on macOS ([191](../adr/0191-a-worker-s-bash-calls-can-run-in-claude-code-s.md)).
Do not add hooks of your own to a profile that weaken these: `deny` can only add
([77](../adr/0077-a-profile-layer-can-deny-tools-and-can.md)).

## Subagents and skills

Send where-is and how-does questions to an Explore subagent, which runs no git or shell and is
pinned to Haiku at low effort: 38% of 3,218 worker turns were search or read turns, mostly on Opus
([152](../adr/0152-a-worker-s-settings-pin-its-subagents-to-haiku-at-low.md), [129](../adr/0129-workers-and-the-conductor-learn-the-code-through-an-explore.md)). Dispatch independent work to subagents in their own worktree
(`isolation: worktree`, see [workflow](../workflow.md)). In your own Claude window, link the shipped
`pup` skill so you drive pup in conversation ([70](../adr/0070-the-operator-console-is-a-plain-claude-code.md)).

## Prompt caching and where the spend goes

A worker's prompt cache lives an hour. One week had 93 worker requests after a longer idle that
re-wrote the whole context at the write price: 8.6M tokens, about 84 USD. `pup watch` therefore
holds a waiting worker's cache from 50 minutes of quiet ([179](../adr/0179-pup-watch-holds-a-waiting-worker-s-prompt-cache.md)); run `pup watch --start`
whenever sessions wait on you. To see the spend:

```bash
pup usage --since 2026-11-01   # per class, model, effort: calls, cost, cache hit rate, context sizes
pup retro --since 7            # ranked findings with a candidate fix; writes under ~/.pupitre/<id>/retro/
```

Both are operator-only and read transcripts locally ([122](../adr/0122-pup-usage-reports-where-the-claude-usage-went-from-the.md), [150](../adr/0150-pup-retro-reads-the-claude-code-traces-locally-and.md)). Judge any
change to routing, compaction or the kickoff by the numbers it moves ([178](../adr/0178-each-rework-step-ships-behind-a-project-setting-and.md)).

## Review rounds: when to stop

A rejected session is re-steered with the gate report, at most twice before it is blocked for you
([7](../adr/0007-rejection-re-steer-is-capped-at-2.md), [15](../adr/0015-rebase-conflict-re-steers-count-toward-the-reject.md)): at that point steer with a different instruction or split the task
rather than a third retry. For the PR, the CI review runs at opening and on demand
([151](../adr/0151-ci-review-runs-at-opening-and-on-demand-only.md)); `pup fix` hands open threads back to the session's worker ([90](../adr/0090-pup-fix-session-hands-the-ci-review-s.md)). Once a project turns on the staged review of [174](../adr/0174-review-runs-in-stages-and-an-important-finding-needs.md), round 2 is the last and leftovers become follow-up tickets, but a Security or Data Protection high is never deferred. Count every unresolved thread as open
([163](../adr/0163-every-unresolved-non-outdated-review-thread-counts-as-open.md)), and do not trade a thread for a flag with `--accept-debt` ([173](../adr/0173-the-diff-size-and-complexity-caps-are-hard-and.md)).

## One fresh session per task

A session is one task ([40](../adr/0040-a-task-can-exist-before-a-session-the.md)); it finishes with `pup session done` and stays at
awaiting-review ([3](../adr/0003-task-completion-is-an-explicit-protocol.md)). Start the next task with `pup new` or `pup launch`, not by steering
the finished session: a new window starts with a small, current context and the cheapest rung,
while a long one re-reads its history on every request. `pup fix` uses a fresh window for the same
reason ([90](../adr/0090-pup-fix-session-hands-the-ci-review-s.md)).
