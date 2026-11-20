# 0012. No programmatic auth

- Status: accepted

12. **No programmatic auth.** Sessions and gate utilities use the user's existing interactive
    login (Max subscription); Pupitre never handles tokens, API keys, or credential files.
    Trust for new worktree paths is pre-seeded in `~/.claude.json` at `pup new` (same
    mechanism Claude Code itself uses when the user accepts the dialog). Claude Code keys
    the dialog on the git common-dir ROOT, not the launch cwd (verified on 2.1.218), so
    the worktree's main repo root is seeded alongside the worktree path (2026-07-23).

## Amendment (2026-11-20, #407)

Remote workers. A worker in a remote sandbox cannot use the operator's interactive
subscription login, so the rule above cannot hold there as written. It narrows as follows.

- *The key.* The operator creates a separate API key for sandboxes, with a low spending limit
  and a short lifetime, and exports it in their own shell. Pupitre never creates, stores or
  asks for it.
- *Where it may be written.* pup reads it from its environment when it launches a remote
  worker and passes it into that sandbox's environment, and nowhere else.
- *Where it may not be written.* Never to the store, events, logs, PR bodies, the gate
  report or the repo.
- *The gate and CI check.* The merge gate refuses a branch whose diff contains the key. It
  recognises the key because pup holds its value in its own environment at gate time. The CI
  review is told never to quote the key.
- *Local workers.* They keep the interactive login and are unchanged.
- *Who launches.* Launching a remote worker is operator-only, like every launch.
- *Rotation and leaks.* The operator rotates the key. A leak is handled by revoking it; its
  low limit and short lifetime bound what a leak costs until then.

Open question, a later option: an injecting proxy that adds the key to the sandbox's API
requests on the way out, so the key never enters the sandbox at all.
