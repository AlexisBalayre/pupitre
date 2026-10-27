# 0016. Merge is `--ff-only` with full cleanup

- Status: accepted

16. **Merge is `--ff-only` with full cleanup.** After the auto-rebase the branch is a
    descendant of the target, so the merge fast-forwards (linear history). On pass:
    session → `merged`, tmux killed, worktree removed, branch deleted — everything is in main.
