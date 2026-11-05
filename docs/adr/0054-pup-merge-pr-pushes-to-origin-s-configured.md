# 0054. `pup merge --pr` pushes to origin's configured URL, from a git dir that reads no shared config (2026-09-17)

- Status: accepted

54. **`pup merge --pr` pushes to origin's configured URL, from a git dir that reads no shared
    config (2026-09-17).** Decision 41 left this open: "`url.<base>.insteadOf` or a rewritten
    `remote.origin.url` in the shared config sends `pushBranch` and `gh pr create` wherever the
    session says". Reproduced against Apple Git 2.39.5 before anything was written: `remote
    get-url origin` answers with the rewritten URL, and both `git push origin` and the gh
    `--repo` pin derived from that answer follow it.
    *The literal URL is not enough on its own.* The fix decision 41 named was to push to the
    literal URL instead of the remote name. Git rewrites a literal URL through `insteadOf` and
    `pushInsteadOf` exactly as it rewrites a remote's, verified by pushing to one. Nothing on
    the command line outranks it either: git picks the longest matching prefix, and on a tie
    the rule it read first, which is the local config, since `-c` is read last. So a
    `-c url.<origin>.insteadOf=<origin>` loses to a session's rule matching the whole URL.
    That is decision 50's situation, but here there is a way out that filters did not have:
    the push does not need the shared config at all. `pushBranch` runs `git push` from an
    empty scratch bare repo with `GIT_OBJECT_DIRECTORY` pointed at the repo's objects, so
    `url.*`, `remote.*` and `core.sshCommand` in the shared config are never read, while the
    operator's global and system config still are. An operator's own ssh-for-https rewrite
    keeps working, and the test fixture relies on exactly that to stay offline.
    *Read once, raw.* The URL comes from `git config --get remote.origin.url` in the main
    checkout, not from `remote get-url`, which applies the rewrites. It is read before the
    stages run and carried to the push, so the pushed-to URL and the `--repo` slug are one value.
    A rewrite written while the stages run cannot move it.
    *The lease names its value.* A push to a URL neither reads nor updates a remote-tracking
    ref, so a bare `--force-with-lease` has nothing to lease against. The lease is now `refs/heads/<branch>:<sha>`, read from
    `refs/remotes/origin/<branch>`, and pup moves that ref itself after the push. The test for
    a retry after the rebase rewrote the pushed branch covers this. `--set-upstream` went: the
    branch is deleted when the merge ends, so an upstream pointing at a URL served nothing.
    *The functional cost, stated.* `remote.origin.pushurl` is no longer honoured, and neither
    are `url.*`, `core.sshCommand`, `http.*` or `credential.helper` set in the repo's local
    config. The push goes to `remote.origin.url` with the operator's global config, and a
    read-over-https, push-over-ssh split has to move there as a `pushInsteadOf`. It is the same
    trade as clearing the sign flags in decision 41 and refusing local filters in decision 50.
    The shared config is session-writable, so a setting there cannot be told apart from a
    redirect.
    *Ceilings.* **A rewritten `remote.origin.url` still redirects the push and the PR**
    (closed by decision 56). The
    value is read from the same shared config a session can write, and there is no trusted
    copy to compare it against. The honest fix is to record origin's URL when the project is
    set up and refuse a merge where the two differ, which is its own change. What this change
    narrows: the push and the PR can no longer disagree, which `pushurl` allowed, and a target
    that names no host, owner and repo, like a local path, is refused by `originRepoSlug`
    before anything is pushed. The adoption probe and every gh call still carry the pinned
    `--repo`, and gh itself never pushes.
