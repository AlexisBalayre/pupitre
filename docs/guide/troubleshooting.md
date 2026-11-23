# Troubleshooting

Start with `pup status`: it lists what needs you first. Then find the symptom.

| Symptom | Cause and fix |
| --- | --- |
| `pup <command>` says it is operator-only | You ran it from a session or the conductor. Run it from your own shell or a Claude window you opened by hand ([concepts](concepts.md#glossary)) |
| `pup init` fails: no adapter | No TypeScript or Python adapter matched. Declare a custom one ([06 Adapters](../06-adapters.md), [decision 24](../adr/0024-custom-adapter-escape-hatch-sh-c-commands-with.md)) |
| `pup init` refuses a changed origin | The push target is recorded at setup. If origin legitimately moved, run `pup init --origin-moved` ([56](../adr/0056-the-push-target-is-recorded-at-setup-and.md)) |
| `pup new` or `pup launch` refuses | The merge lock's backlog, the machine's load, or the plan's usage windows are over their limits ([197](../adr/0197-launches-follow-the-merge-lock-s-backlog-and-the.md), [156](../adr/0156-launches-hold-while-the-plan-s-usage-windows-run-low.md)). Wait, review a session awaiting you, or tune `.pupitre/project.yml` ([configuration](configuration.md#project-settings-pupitreprojectyml)). You alone may pass `--over-cap` or `--over-limit` |
| `pup session test` exits 75 | The test slots stayed busy and nothing ran. It is not a test failure; retry ([96](../adr/0096-test-runs-queue-for-a-few-machine-wide.md)) |
| A session is flagged stalled | Its events file went quiet. Look with `pup attach <session>`; steer it, `pup interrupt` a stuck tool call, or `pup kill <session> --respawn` for a wedged window ([35](../adr/0035-a-running-session-is-stalled-by-events-file.md), [37](../adr/0037-force-interrupt-is-its-own-command-and-every.md)). Run `pup watch --start` so dead turns are revived |
| A session is blocked | It asked you something or was rejected twice. Read it with `pup status`; answer with `pup answer <session> <reply>`, or deal with the cause and `pup unblock <session> --reason "..."` ([7](../adr/0007-rejection-re-steer-is-capped-at-2.md), [76](../adr/0076-a-blocked-worker-asks-with-pup-session-ask.md)) |
| A steer seems to do nothing | A steer is submitted only once the pane shows it whole, and cannot stop a turn in flight. Use `pup interrupt <session> "<message>"` ([4](../adr/0004-steering-cannot-force-interrupt-a-mid-turn-agent.md), [45](../adr/0045-a-steer-is-submitted-only-once-the-pane.md)) |
| `pup merge` rejects on diff size or complexity | These caps are hard; `--accept-debt` does not clear them. Split the task ([173](../adr/0173-the-diff-size-and-complexity-caps-are-hard-and.md)) |
| `pup merge` rejects on fresh-base or ADR number | The rebase conflicted, or the number is taken by the target or another open branch. Steer the session to fix it; it counts toward the two-reject cap ([15](../adr/0015-rebase-conflict-re-steers-count-toward-the-reject.md), [146](../adr/0146-the-gate-refuses-an-adr-number-the-target-or.md)). A worktree mid-rebase or mid-merge is refused ([204](../adr/0204-fresh-base-and-pup-land-refuse-a-worktree-mid-rebase-or-merge.md)) |
| A test stage times out under load | The merge is refused rather than the session rejected; retry when the machine is quieter ([138](../adr/0138-a-test-stage-that-times-out-under-load-refuses.md)) |
| Another merge holds the lock | The lock records its holder and is reclaimed from a dead one ([88](../adr/0088-the-merge-lock-records-its-holder-survives-every.md)). Wait for the stage line pup prints |
| `pup merge --pr` failed halfway | It retries cleanly ([27](../adr/0027-a-failed-pup-merge-pr-retries-cleanly-and.md)); run it again |
| `pup merge` refuses: push target differs | Config disagrees with the recorded target ([56](../adr/0056-the-push-target-is-recorded-at-setup-and.md), [54](../adr/0054-pup-merge-pr-pushes-to-origin-s-configured.md)) |
| The gate refuses on a non-macOS machine | Declare the VM as the sandbox ([78](../adr/0078-off-macos-the-gate-refuses-unless-the-operator.md)) |
| `pup land` refuses | PR still open with a different head: `--accept-head <sha>` or `--remeasure`. PR closed unmerged: `--abandon-closed`, or `pup retire --superseded-by <pr>` if another PR re-landed it ([164](../adr/0164-pup-land-takes-a-moved-head-on-the-operator-s-word.md), [185](../adr/0185-pup-land-remeasure-takes-a-moved-head-on-the.md), [141](../adr/0141-pup-retire-closes-out-a-session-whose-pr-another.md)) |
| `pup fix` refuses | The session must be merged and its PR must have an open review thread ([90](../adr/0090-pup-fix-session-hands-the-ci-review-s.md)) |
| `pup profile edit` or `stale` | Not implemented. Edit the YAML in `~/.pupitre/<id>/profiles/` ([configuration](configuration.md#profiles)) |
| `.pupitre/project.yml` errors | An unknown key, or `workerSandbox: true` off macOS, is an error |
| A window shows a `BLOCKED` message from a hook | The hook refused a scope violation or a Bash read of a tracked file. Use the Read tool, or widen the task's scope ([6](../adr/0006-bash-scope-checking-is-best-effort.md), [112](../adr/0112-a-worker-reads-a-tracked-file-with-the.md), [115](../adr/0115-pup-plan-edit-rescope-lets-the-operator-widen.md)) |

## Looking closer

- `pup review <session>` shows one branch's diff, scope and gate results.
- `pup attach <session>` shows the window; detach with Ctrl-b d.
- `pup audit` tells you whether main drifted from the baseline.
- State is in `~/.pupitre/<id>/state.db`; do not edit it by hand.
