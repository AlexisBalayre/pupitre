# 0201. Pup's git reads past submodule config a session planted (2026-11-18)

- Status: accepted
- Amends: [0073](0073-git-has-one-entry-point-rungit-in-git.md)
- Amends: [0101](0101-git-in-a-session-worktree-runs-pinned-to.md)

201. **Pup's git reads past submodule config a session planted (2026-11-18).**
    The gate, `pup land` and the diff client run git outside any sandbox, in the main checkout,
    over a branch a session wrote. A session can plant submodule config that such a run reads:
    - a `.gitmodules` on its branch or in its index, carrying `submodule.<name>.url`,
      `.update`, `.ignore` or `.fetchRecurseSubmodules`;
    - a submodule repo at `.git/modules/<name>`, whose own config arms `diff.external`, a
      textconv, a clean filter or `core.fsmonitor`, and which no driver check (decision 73)
      reads, since it is not the project's config;
    - recursion and diff keys in the shared config, where decision 41's exposure leaves a
      session able to write: `submodule.recurse`, `fetch.recurseSubmodules`,
      `push.recurseSubmodules`, `diff.submodule`, `diff.ignoreSubmodules`,
      `status.submoduleSummary`, and `submodule.<name>.url` or `.update`.
    *Probe.* On Git 2.54 (Apple Git-157), on 2026-11-18, against a gitlink bumped on a branch:
    - a tree-to-tree `diff --name-only` drops the gitlink under a shared
      `diff.ignoreSubmodules=all`, or under `ignore = all` in a `.gitmodules` git reads from the
      checkout, the index or HEAD. `-c diff.ignoreSubmodules=none` does not bring it back; only
      the command-line `--ignore-submodules=none` outranks the `.gitmodules` entry, as decision
      101 found for status;
    - with `diff.submodule=diff`, a patch over the gitlink runs a child git in
      `.git/modules/<name>`, and that repo's `diff.external` or textconv runs. At `short` no child
      starts;
    - a rebase over a branch whose `.gitmodules` says `update = !<command>` stops with
      `fatal: invalid value for 'submodule.<name>.update'`, with `submodule.recurse` pinned or
      not. Git honours a `!command` update only from local config, and only `git submodule
      update` reads one.
    *Pins.* `GIT_SAFE_CONFIG` (decision 73), so every `runGit` child, `pinnedGitEnv` and the hooks'
    `safe_git`, now also carries:
    - `fetch.recurseSubmodules=false` and `push.recurseSubmodules=no`, beside decision 80's
      `submodule.recurse=false`, so the scratch dir's fetch and push recurse into nothing
      whatever order git reads the keys in;
    - `diff.submodule=short`, so no diff starts a git in a submodule's repo.
    The diff client's `DIFF_SAFE_FLAGS` now carry `--ignore-submodules=none`, so `gitDiffPaths`,
    `gitDiffNumstat` and `gitDiffAddedLines` list a gitlink change whatever the config or a
    `.gitmodules` says. The gate's scope audit, the overlap check, `pup land`'s steer of the
    sessions it overlaps and the review all read that listing, and a gitlink a `.gitmodules` hid
    from it would have passed the scope audit unseen. Every diff the client runs compares two
    commits or two blobs, so `none` starts no git in a submodule. The gate's worktree status
    keeps decision 101's `--ignore-submodules=all`: that one runs over a worktree, where `none`
    would read each submodule's own worktree.
    *Never read.* No pup git run uses a `.gitmodules` `url` or `update`, or their config forms:
    pup runs no `git submodule`, clone or sync, and recursion is pinned off everywhere.
    *Rejected.* `-c protocol.file.allow=never`. `GIT_ALLOW_PROTOCOL=none` (decision 73) already
    refuses every transport on every child that does not reach a remote, and on the scratch
    dir's fetch and push, which do, it would refuse the local file remotes an operator's
    `insteadOf` can name. With recursion off, those two never clone a submodule anyway.
    *Tests.* Each plants all of the above with the `ext::` url and `!` update aimed at a marker,
    first shows plain git honour the plant (the bump dropped, the module's driver run), then
    shows pup's run list the bump and leave the marker unwritten:
    - `git-diff-client.test.ts`, for `gitDiffPaths`, `gitDiffNumstat` and `gitDiffAddedLines`;
    - `merge-gate-regate.test.ts`, for a gate that rebases and merges the bump, and for one whose
      `.gitmodules` update command stops the rebase, which it rejects at `fresh-base`;
    - `land.test.ts`, for a land that fetches, moves main and steers past the bump.
