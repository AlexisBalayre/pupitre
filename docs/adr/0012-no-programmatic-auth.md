# 0012. No programmatic auth

- Status: accepted

12. **No programmatic auth.** Sessions and gate utilities use the user's existing interactive
    login (Max subscription); Pupitre never handles tokens, API keys, or credential files.
    Trust for new worktree paths is pre-seeded in `~/.claude.json` at `pup new` (same
    mechanism Claude Code itself uses when the user accepts the dialog). Claude Code keys
    the dialog on the git common-dir ROOT, not the launch cwd (verified on 2.1.218), so
    the worktree's main repo root is seeded alongside the worktree path (2026-07-23).
