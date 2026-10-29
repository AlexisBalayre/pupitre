# Architecture decision records

Outcome of the design review (2026-07-22) and every decision since. Where a decision contradicts
`docs/00`–`08`, the decision wins; folding the changes back into those docs is pending.

One file per decision, `NNNN-short-kebab-title.md`. The number is the decision's number, so every
"decision N" reference elsewhere stays valid. A file opens with `# NNNN. Title`, then
`- Status:` (`accepted`, or `superseded by [NNNN](...)`), then `- Amends:` / `- Amended by:` lines
for the cross-references the text states, then the decision itself.

## Reading and writing

- Read the decisions your change touches, found through the index below. Do not read the whole
  directory.
- Number a new decision by taking the highest `NNNN` on `origin/main` (after a fetch) and
  incrementing it: `git ls-tree --name-only origin/main docs/adr/ | grep -E '/[0-9]{4}-' | sort | tail -n 1`.
- Record a decision only when it is hard to reverse, surprising without context, and the result
  of a real trade-off.
- An open PR may still edit the decision it adds. Once a decision has landed, a later change
  appends an amendment section to it (dated, with the PR) or adds a new decision that links back
  through `Amends:`. It does not rewrite the landed text.
- Never edit the index by hand. `bash scripts/adr-index.sh` regenerates it, and `pnpm lint` fails
  when it is stale.

## Index

<!-- adr-index:begin -->
- [0001. Sessions are interactive `claude` in tmux panes](0001-sessions-are-interactive-claude-in-tmux-panes.md) (accepted)
- [0002. All session state comes from hooks and transcript JSONL](0002-all-session-state-comes-from-hooks-and-transcript.md) (accepted)
- [0003. Task completion is an explicit protocol](0003-task-completion-is-an-explicit-protocol.md) (accepted)
- [0004. Steering cannot force-interrupt a mid-turn agent](0004-steering-cannot-force-interrupt-a-mid-turn-agent.md) (accepted)
- [0005. Sessions run with permissions bypassed; compiled hooks are the enforcement layer](0005-sessions-run-with-permissions-bypassed-compiled-hooks-are.md) (accepted)
- [0006. Bash scope checking is best-effort](0006-bash-scope-checking-is-best-effort.md) (accepted)
- [0007. Rejection→re-steer is capped at 2](0007-rejection-re-steer-is-capped-at-2.md) (accepted)
- [0008. Fresh-base gating](0008-fresh-base-gating.md) (accepted)
- [0009. Sessions inherit the user's `~/.claude` (revised 2026-07-22, supersedes full `CLAUDE_CONFIG_DIR` isolation)](0009-sessions-inherit-the-user-s-claude.md) (accepted)
- [0010. Compiled profile is delivered per session via `--settings <compiled.json>`](0010-compiled-profile-is-delivered-per-session-via-settings.md) (accepted)
- [0011. Gate-time Claude work runs as one-shot `claude -p` utilities](0011-gate-time-claude-work-runs-as-one-shot.md) (accepted)
- [0012. No programmatic auth](0012-no-programmatic-auth.md) (accepted)
- [0013. Coverage = patch coverage vs a ratcheting baseline](0013-coverage-patch-coverage-vs-a-ratcheting-baseline.md) (accepted)
- [0014. v1 gate slims to](0014-v1-gate-slims-to.md) (accepted)
- [0015. Rebase-conflict re-steers count toward the reject cap](0015-rebase-conflict-re-steers-count-toward-the-reject.md) (accepted)
- [0016. Merge is `--ff-only` with full cleanup](0016-merge-is-ff-only-with-full-cleanup.md) (accepted)
- [0017. Diff-size flag blocks unless `--accept-debt`](0017-diff-size-flag-blocks-unless-accept-debt.md) (accepted)
- [0018. Context is optimized by handoff-respawn, not in-place compaction (2026-07-23)](0018-context-is-optimized-by-handoff-respawn-not-in.md) (accepted)
- [0019. Sessions do not load repo/local settings: `--setting-sources user` (2026-07-23)](0019-sessions-do-not-load-repo-local-settings-setting.md) (accepted)
- [0020. Conflict radar is a tmux-supervised watcher daemon (2026-07-23)](0020-conflict-radar-is-a-tmux-supervised-watcher-daemon.md) (accepted)
- [0021. Debt delta = three soft stages with a merge-time ratchet (2026-07-24)](0021-debt-delta-three-soft-stages-with-a-merge.md) (accepted)
- [0022. Python adapter ships the v1 gate surface only (2026-07-24)](0022-python-adapter-ships-the-v1-gate-surface-only.md) (accepted)
- [0023. Patch coverage lands as the fourth soft stage (2026-07-24), closing decision 13](0023-patch-coverage-lands-as-the-fourth-soft-stage.md) (accepted)
- [0024. Custom adapter escape hatch = `sh -c` commands with a JSON stdout contract (2026-07-24)](0024-custom-adapter-escape-hatch-sh-c-commands-with.md) (accepted)
- [0025. Python debt capabilities ship as declared-tool shell-outs (2026-07-24)](0025-python-debt-capabilities-ship-as-declared-tool-shell.md) (accepted)
- [0026. `pup merge --pr` = same gate, pull request instead of local merge (2026-07-25)](0026-pup-merge-pr-same-gate-pull-request-instead.md) (accepted)
- [0027. A failed `pup merge --pr` retries cleanly, and the ledger names the real acceptor (2026-07-25)](0027-a-failed-pup-merge-pr-retries-cleanly-and.md) (accepted)
- [0028. Gate and capability children get an env allowlist, and pup's git calls stop running repo hooks (2026-07-25)](0028-gate-and-capability-children-get-an-env-allowlist.md) (accepted)
- [0029. Capabilities take a two-path context and say why they measured nothing (2026-07-25)](0029-capabilities-take-a-two-path-context-and-say.md) (accepted)
- [0030. Changed code absent from the coverage report is flagged, not free (2026-07-25)](0030-changed-code-absent-from-the-coverage-report-is.md) (accepted)
- [0031. A Python file is exempt from coverage only if both checkouts call it a test (2026-07-25)](0031-a-python-file-is-exempt-from-coverage-only.md) (accepted)
- [0032. A coverage report holds only files coverage is expected for (2026-07-27)](0032-a-coverage-report-holds-only-files-coverage-is.md) (accepted)
- [0033. Duplication does not count import statements (2026-07-27)](0033-duplication-does-not-count-import-statements.md) (accepted)
- [0034. `pup audit` diffs the debt baseline too, not just stage status (2026-08-02)](0034-pup-audit-diffs-the-debt-baseline-too-not.md) (accepted)
- [0035. A running session is STALLED by events-file mtime, not a logged timestamp (2026-08-02)](0035-a-running-session-is-stalled-by-events-file.md) (accepted)
- [0036. Gate children run inside a pup-generated `sandbox-exec` profile, and `PUP_GATE_ENV` is replaced by `--gate-env` (2026-08-02)](0036-gate-children-run-inside-a-pup-generated-sandbox.md) (accepted)
- [0037. Force-interrupt is its own command, and every tmux lookup is pinned to exact match (2026-08-03)](0037-force-interrupt-is-its-own-command-and-every.md) (accepted)
- [0038. Baseline drift is a new append-only `baseline_history` table, not a reuse of `projects.baseline` (2026-08-03)](0038-baseline-drift-is-a-new-append-only-baseline.md) (accepted)
- [0039. Duplication does not count test-fixture duplication (2026-09-03)](0039-duplication-does-not-count-test-fixture-duplication.md) (accepted)
- [0040. A task can exist before a session; the backlog is derived, not stored (2026-09-04)](0040-a-task-can-exist-before-a-session-the.md) (accepted)
- [0041. A launch is refused when its scope collides with a live session; the backlog is visible where work is chosen (2026-09-04; the refusal is superseded by decision 99)](0041-a-launch-is-refused-when-its-scope-collides.md) (accepted)
- [0042. `pup launch` and `pup kill` are operator-only, so admission control is a control (2026-09-05)](0042-pup-launch-and-pup-kill-are-operator-only.md) (accepted)
- [0043. `pup` resolves its project through one rule, and the store decides only when it cannot be wrong (2026-09-05)](0043-pup-resolves-its-project-through-one-rule-and.md) (accepted)
- [0044. A session reports only its own state, and `merge` and `respawn` are operator-only (2026-09-06)](0044-a-session-reports-only-its-own-state-and.md) (accepted)
- [0045. A steer is submitted only once the pane shows it whole, and never in part (2026-09-06)](0045-a-steer-is-submitted-only-once-the-pane.md) (accepted)
- [0046. Every command that types into or reads a session goes to the pane recorded at launch, never to the session (2026-09-06)](0046-every-command-that-types-into-or-reads-a.md) (accepted)
- [0047. A conductor session is the operator's delegate for everything but the merge, and every session is addressable by its peer name (2026-09-12)](0047-a-conductor-session-is-the-operator-s-delegate.md) (accepted)
- [0048. `pup audit` is operator-only: the thing that moves the bar is not the thing being judged (2026-09-12)](0048-pup-audit-is-operator-only-the-thing-that.md) (accepted)
- [0049. A respawn kicks off on the document the session signalled for, or on nothing (2026-09-13)](0049-a-respawn-kicks-off-on-the-document-the.md) (accepted)
- [0050. Git will not run at all while a filter or merge driver is armed (2026-09-13)](0050-git-will-not-run-at-all-while-a.md) (accepted)
- [0051. A session's code graph is an external index served over MCP, one per worktree (2026-09-13)](0051-a-session-s-code-graph-is-an-external.md) (accepted)
- [0052. `pup ui` is Ink over one snapshot, and it renders rather than decides (2026-09-13)](0052-pup-ui-is-ink-over-one-snapshot-and.md) (accepted)
- [0053. A null numstat is a measurement, not a free skip (2026-09-17)](0053-a-null-numstat-is-a-measurement-not-a.md) (accepted)
- [0054. `pup merge --pr` pushes to origin's configured URL, from a git dir that reads no shared config (2026-09-17)](0054-pup-merge-pr-pushes-to-origin-s-configured.md) (accepted)
- [0055. A package manager that cannot load is a broken cache, not a baseline (2026-09-17)](0055-a-package-manager-that-cannot-load-is-a.md) (accepted)
- [0056. The push target is recorded at setup, and a merge whose config disagrees is refused (2026-09-17)](0056-the-push-target-is-recorded-at-setup-and.md) (accepted)
- [0057. A project has one brief, written by the operator, and it is split once: Destination and Constraints to every session, Priorities to the conductor (2026-09-18)](0057-a-project-has-one-brief-written-by-the.md) (accepted)
- [0058. A nested package is its own measurement unit (2026-09-21)](0058-a-nested-package-is-its-own-measurement-unit.md) (accepted)
- [0059. A nested package's own runner is a gate stage, and what the root leaves out is said (2026-09-21)](0059-a-nested-package-s-own-runner-is-a.md) (accepted)
- [0060. Outside a repo, `pup status` is the fleet: every project, what needs you in each (2026-09-21)](0060-outside-a-repo-pup-status-is-the-fleet.md) (accepted)
- [0061. `pup ui --all` is the fleet on one screen, and every key acts through its row's own project (2026-09-21)](0061-pup-ui-all-is-the-fleet-on-one.md) (accepted)
- [0062. A project can be put to sleep, and only the operator does it, only once nothing in it is live (2026-09-21)](0062-a-project-can-be-put-to-sleep-and.md) (accepted)
- [0063. Every Bash call is re-checked against the worktree after it runs (2026-09-21)](0063-every-bash-call-is-re-checked-against-the.md) (accepted)
- [0064. `pup init` is operator-only, like `pup audit` (2026-09-22)](0064-pup-init-is-operator-only-like-pup-audit.md) (accepted)
- [0065. The fleet and the registry's dormancy live in `src/core`, and the canonical-path refusal is the registry's (2026-09-22)](0065-the-fleet-and-the-registry-s-dormancy-live.md) (accepted)
- [0066. A session id is checked where it becomes a path, and the fleet readers skip a row whose id is not one (2026-09-23)](0066-a-session-id-is-checked-where-it-becomes.md) (accepted)
- [0067. The transcript directory is derived and the stored column only confirmed, and two more raw store strings are scrubbed at the fold (2026-09-23)](0067-the-transcript-directory-is-derived-and-the-stored.md) (accepted)
- [0068. Every store-read, repo-read and child-read string is scrubbed where it prints, and a source scan holds the line (2026-09-24)](0068-every-store-read-repo-read-and-child-read.md) (accepted)
- [0069. The profile readers scrub what they print, and the scan learned the layer fields (2026-09-24)](0069-the-profile-readers-scrub-what-they-print-and.md) (accepted)
- [0070. The operator console is a plain Claude Code window carrying the shipped `pup` skill, not a fourth tier and not a `pup` subcommand (2026-09-24)](0070-the-operator-console-is-a-plain-claude-code.md) (accepted)
- [0071. `parseProfileLayer` types `extends` and `contextBudget` at the parser, because a wrong `contextBudget` would disable the budget refusal in silence (2026-09-25)](0071-parseprofilelayer-types-extends-and-contextbudget-at-the-parser.md) (accepted)
- [0072. One debt module for `pup init`, `pup audit` and the merge gate, measuring every detected adapter (2026-09-29)](0072-one-debt-module-for-pup-init-pup-audit.md) (accepted)
- [0073. Git has one entry point: `runGit` in `git-diff.client.ts`, and a source scan holds the line (2026-10-06)](0073-git-has-one-entry-point-rungit-in-git.md) (accepted)
- [0074. A worker is kept off the screens pup cannot answer: AskUserQuestion, EnterPlanMode and ExitPlanMode are denied in every compiled settings.json (2026-10-06)](0074-a-worker-is-kept-off-the-screens-pup.md) (accepted)
- [0075. The conductor gates a branch with `pup merge --pr`, and accepted debt names its approver (2026-10-06)](0075-the-conductor-gates-a-branch-with-pup-merge.md) (accepted)
- [0076. A blocked worker asks with `pup session ask "<question>"`, and a steer answers it (2026-10-06, amends decision 74)](0076-a-blocked-worker-asks-with-pup-session-ask.md) (accepted)
- [0077. A profile layer can deny tools, and can only add to decision 74's denials, never remove one (2026-10-06)](0077-a-profile-layer-can-deny-tools-and-can.md) (accepted)
- [0078. Off macOS the gate refuses unless the operator declares the VM as the sandbox (2026-10-06)](0078-off-macos-the-gate-refuses-unless-the-operator.md) (accepted)
- [0079. `GIT_SAFE_CONFIG` turns off signature verification, not only signing, and `-z` listings are no longer trimmed (2026-10-06)](0079-git-safe-config-turns-off-signature-verification-not.md) (accepted)
- [0080. The gate fast-forwards a sha pinned once, with plumbing, and porcelain `git merge` is gone from it (2026-10-08, closes decision 79's accepted window)](0080-the-gate-fast-forwards-a-sha-pinned-once.md) (accepted)
- [0081. The gate's stages run on a private detached checkout of the pinned sha (2026-10-13, closes decision 80's stages gap)](0081-the-gate-s-stages-run-on-a-private.md) (accepted)
- [0082. Three edges the decision 80 review left open: git-lfs transfer agents, the PR head, and ledger truth (2026-10-13)](0082-three-edges-the-decision-80-review-left-open.md) (accepted)
- [0083. `pup status` opens with a needs-you inbox, and finished sessions move behind `--history` (2026-10-14)](0083-pup-status-opens-with-a-needs-you-inbox.md) (accepted)
- [0084. `pup land <session>` closes the GitHub half of a `--pr` merge, and the conductor may run it (2026-10-14)](0084-pup-land-session-closes-the-github-half-of.md) (accepted)
- [0085. `pup attach` hands the terminal to the conductor, and `pup conductor tell <message>` types into it (2026-10-14)](0085-pup-attach-hands-the-terminal-to-the-conductor.md) (accepted)
- [0086. `pup merge <session> --pr` re-gates a merged session whose open PR took a fix round, so `pup land` can land it (2026-10-16, amends 84)](0086-pup-merge-session-pr-re-gates-a-merged.md) (accepted)
- [0087. Pastes go through a buffer named for the call, every attach spawns tmux from the runtime with the scrubbed environment, a steer reads the box by its frame, and `pup attach <session>` enters a worker's window (2026-10-16, amends 45, 47 and 85)](0087-pastes-go-through-a-buffer-named-for-the.md) (accepted)
- [0088. The merge lock records its holder, survives every exit pup can catch, is reclaimed from a dead holder, and `pup merge` and `pup land` wait for a live one; the gate waits for the machine's load before its tests (2026-10-26, amends 8, 84, 95 and 96)](0088-the-merge-lock-records-its-holder-survives-every.md) (accepted)
- [0090. `pup fix <session>` hands the CI review's open threads on a merged session's PR back to its worker, through the one edge out of `merged` (2026-10-18, part 1 of the conductor/CI review loop; part 2 closed the loop 2026-10-26; amends 7, 40, 83, 84, 86 and 92)](0090-pup-fix-session-hands-the-ci-review-s.md) (accepted)
- [0091. `pup dashboard` serves a read-only live page on 127.0.0.1, behind a token minted per run, the UI-first surface (2026-10-16)](0091-pup-dashboard-serves-a-read-only-live-page.md) (accepted)
- [0092. pup routes every window's model and effort by its task's tier, climbs an explicit ladder one rung per failure, and never chooses Fable (2026-10-17)](0092-pup-routes-every-window-s-model-and-effort.md) (accepted)
- [0094. Worker windows run at nice 10, workers run related tests only, and the gate re-runs a failed test stage once (2026-10-16)](0094-worker-windows-run-at-nice-10-workers-run.md) (accepted)
- [0095. The gate, `pup audit` and `pup land` run the suite once with coverage on, run the read-only stages alongside it and print each stage's time, and an interrupt reaches every stage child (2026-10-17)](0095-the-gate-pup-audit-and-pup-land-run.md) (accepted)
- [0096. Test runs queue for a few machine-wide slots, the gate's first; launches stop at a per-project session cap and under 1.5 GB of available memory; the conductor fills the cap with tasks that share no source file (2026-10-18)](0096-test-runs-queue-for-a-few-machine-wide.md) (accepted)
- [0097. `pup ui` shows the fleet in the terminal tab: an OSC 2 title everywhere, iTerm2's Session Status where it is read (2026-10-18)](0097-pup-ui-shows-the-fleet-in-the-terminal.md) (accepted)
- [0098. `pup dashboard` is a set of sheets, figures and charts first, starting with Overview and Debt (2026-10-17)](0098-pup-dashboard-is-a-set-of-sheets-figures.md) (accepted)
- [0099. Workers share files and collaborate: a launch overlapping a live session is never refused, with no cap, and introduces the two (2026-10-18, supersedes decision 41's refusal)](0099-workers-share-files-and-collaborate-a-launch-overlapping.md) (accepted)
- [0100. Every temp directory a test makes is removed when the test finishes, and the gate's sandbox run ends with the gate, after killing what still writes in it (2026-10-18)](0100-every-temp-directory-a-test-makes-is-removed.md) (accepted)
- [0101. Git in a session worktree runs pinned to the admin and common dirs pup trusts (2026-10-18)](0101-git-in-a-session-worktree-runs-pinned-to.md) (accepted)
- [0102. While the project's conductor runs, a session awaiting review is left out of the needs-you inbox (2026-10-23)](0102-while-the-project-s-conductor-runs-a-session.md) (accepted)
- [0103. The idle prompt is a turn end, a turn ended on the session's own background shell reads `working on a background shell`, and workers commit and test in the foreground (2026-10-25)](0103-the-idle-prompt-is-a-turn-end-a.md) (accepted)
- [0104. Peer-joined introductions and main-landed notices go only to running sessions, and an overlap on this log alone introduces no one (2026-10-25)](0104-peer-joined-introductions-and-main-landed-notices-go.md) (accepted)
- [0105. A branch an open PR holds is never rebased: fresh-base merges the target into it, and the push does not force (2026-10-25)](0105-a-branch-an-open-pr-holds-is-never.md) (accepted)
- [0106. `pup init --session-env A,B` names the variables every session and conductor window gets from the launching shell, through the window's own `-e`, from a closed list (2026-10-26).](0106-pup-init-session-env-a-b-names-the.md) (accepted)
- [0107. Every compiled settings file turns off the Artifact and Workflow tools and prompt suggestions, and a worker's denies the tools and the skill listing it never uses (2026-10-27).](0107-every-compiled-settings-file-turns-off-the-artifact.md) (accepted)
- [0108. A sandbox grant is resolved up to its own name and never through it, and the folded coverage run's report directory sits inside a directory of the gate's own that no child is granted (2026-10-27).](0108-a-sandbox-grant-is-resolved-up-to-its.md) (accepted)
- [0109. One file per decision under docs/adr/, numbered as before, with a generated index (2026-10-27)](0109-one-file-per-decision-under-docs-adr-numbered.md) (accepted)
- [0110. The diff-size flag counts source lines only (2026-10-26)](0110-the-diff-size-flag-counts-source-lines-only.md) (accepted)
- [0111. `gitDiffNumstat` reads a path with a tab in it whole (2026-10-27).](0111-gitdiffnumstat-reads-a-path-with-a-tab-in.md) (accepted)
- [0112. A worker reads a tracked file with the Read tool: a Bash call whose cat, sed, head, tail or nl reads one is refused (2026-10-27)](0112-a-worker-reads-a-tracked-file-with-the.md) (accepted)
- [0113. Pup's git pins `core.bigFileThreshold`, a diff's path argument is a literal pathspec, and the gate's hunk and numstat reads pin their inter-hunk context, diff algorithm and rename detection (2026-10-27).](0113-pup-s-git-pins-core-bigfilethreshold-a-diff.md) (accepted)
- [0114. The gate's per-file git reads pin `core.precomposeUnicode` off (2026-10-27).](0114-the-gate-s-per-file-git-reads-pin-core-precomposeunicode.md) (accepted)
- [0116. Code is laid out in per-area folders with string enums, and tests mirror `src/` under `test/unit` (2026-10-28).](0116-code-layout-string-enums-and-a-mirrored-test-tree.md) (accepted)
- [0118. The conductor's security review runs a general-purpose subagent on Opus at high, which runs the pinned diff and no other git, within ten turns (2026-10-28, amends 92)](0118-the-conductor-s-security-review-runs-a-general-purpose.md) (accepted)
- [0121. `pup ui` never draws a frame as tall as the terminal (2026-10-28).](0121-pup-ui-never-draws-a-frame-as-tall-as-the-terminal.md) (accepted)
<!-- adr-index:end -->

## Implementation notes

- Shared SQLite store in WAL mode so concurrent hook writes from multiple worktrees don't contend.
- Node >= 22, TypeScript, commander, better-sqlite3, and ink + react for `pup ui` (per 08-roadmap
  stack decision, amended by decision 52; the Node floor is Ink 7's).
