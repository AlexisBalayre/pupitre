# 0037. Force-interrupt is its own command, and every tmux lookup is pinned to exact match (2026-08-03)

- Status: accepted

37. **Force-interrupt is its own command, and every tmux lookup is pinned to exact match
    (2026-08-03).** `pup interrupt <session> ["<message>"]` sends Escape to the session's
    pane, aborting the in-flight tool call, then optionally steers — the recovery decision 35
    left manual (a wedged tool call is unreachable by `pup steer`, whose messages queue until
    the turn ends; the alternatives were killing a paid-for context or hand-typed
    `tmux send-keys`). Decision 4 stands for `pup steer`: steers still queue; interrupting is
    a deliberate, separate act because Escape mid-turn discards the tool call's result.
    Landing it surfaced a transport bug the security review verified live on tmux 3.7b: tmux
    resolves a bare `-t` name exact → fnmatch → *prefix*, and session slugs mint prefix pairs
    (`t-abc`, `t-abc-1`), so once `pup-t-abc` died its steers, captures and kills would land
    in the living `pup-t-abc-1`. Every lookup now goes through one `pinned()` helper
    (`=pup-<id>:`; the `=` forces exact match, the trailing `:` is required for pane
    resolution), while `new-session -s` keeps the bare name — `=` and `:` are legal *in*
    session names, so a pinned name at spawn would create an orphan pane no pinned lookup
    could ever find again. `steer` and `interrupt` also refuse terminal sessions outright;
    their panes are gone, and a dead name is exactly what prefix matching would have
    mis-delivered. Deferred, found the same way: task scope is fixed at `pup new`, so a
    mid-session discovery that the correct fix lives one file outside scope (here:
    `EventType` gaining `'interrupt'`) forces either a cast past the type or a follow-up PR —
    a `pup scope add <session> <glob>` needs designing before the next scoped session hits it.
