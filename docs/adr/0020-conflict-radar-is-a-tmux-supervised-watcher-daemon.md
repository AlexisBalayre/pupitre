# 0020. Conflict radar is a tmux-supervised watcher daemon (2026-07-23)

- Status: accepted

20. **Conflict radar is a tmux-supervised watcher daemon (2026-07-23).** `pup watch`
    scans on a 15s cadence: every live session's branch is merge-base-diffed against the
    target (identical to the gate and review queue), and pairs whose diffs touch the same
    file are stored as the current overlap set, replaced atomically each sweep. Overlap =
    same file actually changed, not scope-glob intersection (globs like `src/**` would
    flag every pair forever). `pup watch --start/--stop` run it detached under tmux —
    tmux is already pup's supervisor and makes the radar log attachable; a heartbeat row
    lets `pup status` mark overlaps `(stale)` and point at `pup watch --start` when the
    radar is off while 2+ sessions are live.
