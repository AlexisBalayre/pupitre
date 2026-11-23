# 0208. Three architecture-review candidates are set aside (2026-11-23)

- Status: accepted

208. **Three architecture-review candidates are set aside (2026-11-23).**
    The `/improve-codebase-architecture` review of 2026-11-23 scanned the files that changed most
    since 2026-10-20 and ranked six deepening candidates. The merge lock, extracted from
    `merge-gate.service.ts`, became a task; a single teardown module and a stage runner split out
    of `measureBranch` stay open candidates. This decision records three others so a later review
    does not re-suggest them without new evidence. Each says what would reopen it.
    *Landable head.* Land, regate, land-remeasure and the gate each rebuild the pinned-sha,
    `descendsFrom` and target-fetch checks (`land.service.ts`, `regate.service.ts`,
    `merge-gate.service.ts`). The review did not trace whether the copies are exact duplicates, and
    decisions 80 and 164 govern the pin. Reopen it when a bug is traced to two copies disagreeing.
    *Session-window adapter.* `fix-round`, the gate, the lifecycle and the handoff call
    `src/claude` directly and match the `tmux_target` update to the state transition by hand.
    Decisions 37 and 46 pin the pane recorded at launch, so a new seam must keep both. Reopen it
    when a second executor lands: decision 207's executor seam is the place that fixes the window
    race once, and a separate adapter now would be a hypothetical seam with one adapter.
    *Splitting `src/cli/index.ts`.* The file holds 45 command registrations that mostly delegate.
    Splitting it by command group reorganises the file and deepens nothing. Reopen it when a
    handler is shown to hold logic that belongs in `src/core/`; the two direct `execFileSync`
    calls for `tty` and `open` belong behind a core module regardless.
