# 0172. Git refuses a main checkout's .git a session rewrote (2026-11-09)

- Status: accepted
- Amends: [0101](0101-git-in-a-session-worktree-runs-pinned-to.md)

172. **Git refuses a main checkout's .git a session rewrote (2026-11-09).**
    Amends decision 101, which checks the pointers of a session worktree's admin dir but
    never the main checkout's own `.git`. The t-mvry2clj security re-review found the
    commondir gap on 2026-10-28 and reproduced it on the conductor's review diff. The
    conductor's review of the first fix, at 059be44, found the gitfile and symlink gaps. Its
    re-review at 4a4a18a found the bare-checkout fallback, reproduced on Git 2.54. Its
    re-review at 91f2fd3 found that `chmod a-x <repo>/.git/refs` passed the check, and that
    the gate's catches then read git's refusal as an absent ref.
    *The hole.* A session can write `<repo>/.git`: the shared config, `info/attributes`, tags.
    Through that it can point the main checkout at a decoy repo in four ways:
    - It plants `<repo>/.git/commondir`. A main checkout's git dir never holds that file.
      With the file there, git takes the repo it names as the common dir, so every ref, the
      shared config and `info/` come from that repo. Git does this under `-C <repo>`, under
      `--git-dir`, and with `GIT_COMMON_DIR=<repo>/.git` set. That was reproduced on Git
      2.39.5 and on 2.54, so pinning the variable is no fix.
    - It swaps `<repo>/.git` for a gitfile reading `gitdir: <decoy>`.
    - It swaps `<repo>/.git` for a symlink to the decoy. The decoy then needs no commondir.
    - It writes junk into `<repo>/.git/HEAD` (`ref: x`) and plants a bare repo in the
      checkout root: `HEAD`, `refs/heads/main`, and `objects/info/alternates` naming
      `<repo>/.git/objects`. Git's discovery under `-C <repo>` rejects the broken `.git` and
      falls back to `<repo>` itself as a bare repo, because `safe.bareRepository` defaults to
      `all`. Here `.git` is still a real directory with no commondir. HEAD can stay valid
      while `refs/` or `objects/` loses its search bit (`chmod a-x`), with the same result.
      With a non-bare root, git walks up to a parent repo instead.
    The decoy is a bare repo that borrows the real objects through `objects/info/alternates`.
    It can name any commit as `refs/heads/<target>` and `refs/heads/pup/<id>`, and the gate's
    `resolveCommit`, every other ref read in `merge-gate.service.ts`, the conductor's tip read
    and the `git-diff.client` reads would all see the decoy's answer. A pinned
    session-worktree git is unaffected: its `GIT_DIR` is the admin dir, whose pointers
    decision 101 already verifies.
    *The rule, on every spawn.* `assertGitDirUnplanted(cwd)` in `git-diff.client.ts` lstats
    `<cwd>/.git` without following it, and refuses in these cases:
    - `.git` is a symlink. No main checkout and no pup worktree has one.
    - `.git` is something other than a directory or a regular file.
    - `.git` is a directory that holds a `commondir`, whatever its kind: a file, a symlink
      (dangling or not), or a directory.
    - `.git` is a directory git would not take as a repo: its HEAD, read without following a
      link or blocking on a fifo, is unreadable or is neither `ref: refs/...` nor a sha-1 or
      sha-256, or `objects/` or `refs/` is not a directory pup can search (`accessSync`
      X_OK). These are the checks git's own `is_git_directory` makes before it moves on to
      the bare fallback or a parent repo.
    - `.git` is a gitfile, or is missing, at a path `assertMainCheckout` has passed in this
      process. Missing is refused too, because git would then discover a parent repo.
    - An lstat fails with anything but ENOENT or ENOTDIR.
    Otherwise a gitfile passes. That is how a session worktree or a gate checkout runs git,
    pinned or not. The CLI resolves its project from a session worktree unpinned, so a
    gitfile cannot be refused across the board.
    *No discovery.* When `<cwd>/.git` is a directory that passed the check, `safeArgv` names
    it to git outright: `--git-dir=<cwd>/.git --work-tree=<cwd>`. Git then discovers
    nothing, so a `.git` broken between the check and the spawn makes git die "not a git
    repository" rather than fall back to the root or a parent. A gitfile is left to git.
    *The pin.* `GIT_SAFE_CONFIG` now carries `safe.bareRepository=explicit`, so no pinned
    git, gh's included through `pinnedGitEnv`, takes a directory it discovered for a bare
    repo ("cannot use bare repository"). A repo named by `--git-dir` or `GIT_DIR` still opens:
    pup's scratch dir and the pinned worktrees are named that way. The key needs Git 2.38 or
    later; an older git ignores it, and the HEAD check above still refuses the fallback.
    *The rule, for the main checkout.* `assertMainCheckout(repoPath)` refuses unless
    `<repo>/.git` is a directory of its own, not a gitfile or a symlink, and then applies the
    check above. It also records the path by its real path (`realpathSync.native`), so that
    `repo/`, `./repo`, a symlink to it or a case-folded spelling are one entry, and every
    later spawn there holds it to the same rule. A gitfile alone cannot tell a decoy from a
    worktree, because a decoy can mimic
    `<x>/.git/worktrees/<name>`. Only a caller that knows the path is the main checkout can
    refuse one, so the check is called where pup knows that:
    - `runMergeGate`, before `planMerge` and again first thing under the lock.
    - `resolveCommit`, so `land`, `regate` and fix rounds resolve no ref without it.
    - The conductor's `refreshConductorCheckout`, before it reads the target's tip.
    A gitfile is accepted only where no main checkout is expected. The launch check
    `assertNoWorktreeConfig` now uses lstat, so a symlinked `.git` is refused at launch as it
    is at the gate.
    *Where the spawn check runs.* `safeArgv` calls it first, and `safeArgv` builds the argv of
    both git spawns in `git-diff.client.ts`: `runGit` and the byte read in `blobIsBinary`.
    Decision 73's test already fails the suite on any git spawn outside that module. A test
    now also fails it in two cases:
    - Inside the module, any `node:child_process` binding is used other than as a call whose
      argv `safeArgv` builds. This holds whatever the binary, `'git'`, `'/usr/bin/git'` or
      a variable, and through an aliased named import, a namespace or default import, a value
      alias of the binding, a `require` or a dynamic import of the module.
    - `safeArgv` stops making the check its first statement.
    The check runs on every spawn, so a file planted or a `.git` swapped mid-gate is refused
    at the next read of the main checkout. Some of the gate's catches read a failed git as
    "no such ref": `resolveCommitIfPresent`, which fix rounds and `regate` use too, and
    `commitsPastPin`, and the symbolic-ref probe in `resolveCommit`. Each passes the error to
    `rethrowIfNoUsableRepo` first. It lets a `RewrittenGitDirError` through, and turns git's
    own "cannot use bare repository" or "not a git repository" into one, so a rewritten
    `.git` the check missed or that changed after it never reads as an absent branch.
    *What remains.* The window between an lstat and git's own read, which no pre-spawn check
    closes. A process whose first main-checkout spawn comes before any `assertMainCheckout`,
    for example a CLI read outside the gate: there, only the symlink and commondir cases are
    refused. A git run from a subdirectory of the checkout, which no pup call makes. And
    `gh`, which runs git in the main checkout under `pinnedGitEnv` and takes no argv from pup.
    Within a gate it runs after the explicit checks, but nothing checks before each of its
    spawns. Closing that means `github.client.ts` checking its cwd, which was outside this
    task's scope.
    *Not taken.* Pinning `GIT_COMMON_DIR` on main-repo calls, as decision 101 does for
    worktrees: git still follows the commondir file. Resolving the file and accepting one
    that names `<repo>/.git` itself: git never writes one there, so no legitimate file exists
    to accept. Accepting a gitfile whose target looks like `<x>/.git/worktrees/<name>`:
    a decoy can take that shape. Setting `GIT_CEILING_DIRECTORIES`: where `safeArgv` names
    the git dir, git discovers nothing, so a ceiling adds nothing. Where it does not, git
    must discover: a session worktree's gitfile, or the CLI resolving its project from a
    subdirectory, and a ceiling would break those.
    *Tests.* In `merge-gate.test.ts`, a decoy repo borrows the real objects and holds a `main`
    and a `pup/s1` that differ from the real ones, and plain git is shown reading them. The
    gate throws before any git spawn, and the session stays awaiting-review, in five cases:
    - The commondir is planted as a file.
    - The commondir is a symlink to a file.
    - `.git` is swapped for a gitfile naming the decoy.
    - `.git` is swapped for a symlink to the decoy.
    - `.git/HEAD` is junk and the checkout root holds a bare decoy.
    - `.git/refs` loses its search bit and the checkout root holds a bare decoy.
    Mid-gate, a commondir planted by the adapter's `gateCommands` is refused, and `main` does
    not move. A `.git` swapped there for a gitfile stops every later spawn on the main
    checkout. `resolveCommitIfPresent` throws the refusal rather than answering undefined,
    and so does it when git itself dies "cannot use bare repository" or "not a git
    repository", on the rev-parse or on the symbolic-ref probe behind it.
    In `git-diff-client.test.ts`:
    - `runGit`, `gitDiffPaths`, `currentBranch` and `assertMainCheckout` refuse each kind of
      commondir.
    - A gitfile `.git` at a checkout `assertMainCheckout` passed is refused on spawn and as a
      main checkout.
    - A symlinked `.git` is refused on every spawn.
    - A linked worktree runs git as before but is never taken for a main checkout.
    - A checkout passed as `repo/` or through a symlink is held under its real path.
    - A `.git` directory is named to git outright, and a worktree's gitfile is left to git.
    - The bare-checkout decoy is refused on every spawn and as a main checkout when
      `.git/HEAD` is junk, missing or unreadable, when `refs/` is gone, and when `refs/`
      cannot be searched. Plain git is shown reading the decoy each time. Git with only
      `GIT_SAFE_CONFIG`'s argv refuses the fallback on its own.
    - The source test, with a planted sample, checks the spawn rule above.
