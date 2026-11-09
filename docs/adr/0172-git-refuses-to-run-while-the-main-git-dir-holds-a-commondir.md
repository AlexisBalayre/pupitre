# 0172. Git refuses to run while the main git dir holds a commondir (2026-11-09)

- Status: accepted
- Amends: [0101](0101-git-in-a-session-worktree-runs-pinned-to.md)

172. **Git refuses to run while the main git dir holds a commondir (2026-11-09).**
    Amends decision 101, which checks the `commondir` in a session worktree's admin dir but
    never the main checkout's own git dir. The t-mvry2clj security re-review found the gap on
    2026-10-28 and reproduced it on the conductor's review diff.
    *The hole.* A session can write `<repo>/.git`: the shared config, `info/attributes`, tags.
    It can therefore write `<repo>/.git/commondir` too. A main checkout's git dir never holds
    that file. When the file is there, git takes the repo it names as the common dir, which
    means every ref, the shared config and `info/` come from that repo. Git does this under
    `-C <repo>`, under `--git-dir`, and with `GIT_COMMON_DIR=<repo>/.git` set. That was
    reproduced on Git 2.39.5 and on 2.54, so pinning the variable is no fix. Picture a decoy
    bare repo that borrows the real objects through `objects/info/alternates`. It can name any
    commit as `refs/heads/<target>` and `refs/heads/pup/<id>`, and the gate's
    `resolveCommit`, every other ref read in `merge-gate.service.ts`, and the `git-diff.client`
    reads would all see the decoy's answer. A pinned session-worktree git is unaffected: its
    `GIT_DIR` is the admin dir, whose `commondir` decision 101 already verifies.
    *The rule.* `assertNoPlantedCommondir(cwd)` in `git-diff.client.ts` lstats
    `<cwd>/.git/commondir` without following it. When anything is there, it refuses. That
    covers a regular file, a symlink (dangling or not), a directory, and any error other than
    ENOENT or ENOTDIR. ENOTDIR is the case where `<cwd>/.git` is a gitfile, as in a session
    worktree or the gate's checkout. The refusal names the file and asks the operator to
    inspect it, remove it, and treat the session as compromised. Nothing repairs it
    automatically.
    *Where it runs.* `safeArgv` calls it, and `safeArgv` builds the argv of both git spawns in
    `git-diff.client.ts`: `runGit` and the byte read in `blobIsBinary`. Decision 73's test
    already fails the suite on any git spawn outside that module. A new test also fails it if
    a spawn in the module builds its argv any other way, or if `safeArgv` stops calling the
    check first. So no call site can read a ref of the main repo without the check:
    `resolveCommit`, the conductor's review-checkout cut, `land`, `regate` and fix rounds all
    reach git through `runGit`. Checking on every spawn means a file planted
    mid-gate, while the stages run, is refused at the next read. A check made once at the
    start would miss it.
    `runMergeGate` also calls the check explicitly, before `planMerge` and again first thing
    under the lock. Some of the gate's catches read a failed git as "no such ref"
    (`resolveCommitIfPresent`, `commitsPastPin`). A refusal there would not slip through,
    because git never ran and never handed back a decoy answer. Still, it would read as an
    absent ref, so the gate refuses outright before reaching any of them.
    *What remains.* The window between the lstat and git's own read of the file, which no
    pre-spawn check closes. A git run from a subdirectory of the checkout, which no pup call
    makes: every main-repo call passes the repo root. And `gh`, which runs git in the main
    checkout under `pinnedGitEnv` and takes no argv from pup. Within a gate it runs after both
    explicit checks, but nothing checks before each of its spawns. Closing that would mean
    `github.client.ts` checking its cwd, which falls outside this task's scope.
    *Not taken.* Pinning `GIT_COMMON_DIR` on main-repo calls, as decision 101 does for
    worktrees: git still follows the file. Resolving the file and accepting one that names
    `<repo>/.git` itself: git never writes one there, so no legitimate file exists to accept.
    *Tests.* In `merge-gate.test.ts`, a decoy repo borrows the real objects and holds a `main`
    and a `pup/s1` that differ from the real ones. Plain git reads the decoy's refs. With the
    plant as a file, and again as a symlink to one, the gate throws before any git spawn, and
    the session stays awaiting-review. In a second test, a file planted by the adapter's
    `gateCommands` mid-gate is refused, and the real `main` does not move. In
    `git-diff-client.test.ts`, `runGit`, `gitDiffPaths` and `currentBranch` refuse each kind of
    plant: a file, a symlink, a dangling symlink, a directory. A linked worktree and an
    unplanted repo run as before. A source test pins `safeArgv` as the one argv builder and
    the check as its first statement.
