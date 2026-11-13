# 0181. A main checkout's .git is checked after each read, at gh and at CLI resolution (2026-11-13)

- Status: accepted
- Amends: [0172](0172-git-refuses-a-main-checkout-s-git-a-session-rewrote.md)

181. **A main checkout's .git is checked after each read, at gh and at CLI resolution (2026-11-13).**
    Amends decision 172 and closes part of its *What remains*. The review of the decision 172
    fix, at b4e3aa87, rated as HIGH the identity being recorded on first use. It also found
    (finding 3) that the lstats run before git reads `.git`. In that window a process left
    behind by a session-controlled gate stage can swap `.git` for a symlink or a gitfile, or
    plant a commondir, and git follows them under `--git-dir`.
    *Checked after the read.* `runGit` and `runGitBytes`, the module's only git spawns, run
    `assertGitDirUnplanted` again once git ends (`checkedAfter`), whether git succeeded or
    failed. A refusal then outranks git's own failure, so a catch that reads a failed git as
    "no such ref" sees the `RewrittenGitDirError` instead. Decision 172's source test still
    holds: each spawn's argv is built by `safeArgv`, inline.
    *gh.* `github.client.ts` checks the main checkout before and after each gh spawn
    (`ghInCheckout`), as `runGit` does. gh runs git there with no `--git-dir` of pup's, so a
    planted commondir or a symlinked `.git` is refused before gh starts. A gitfile is
    refused at a checkout `assertMainCheckout` has passed in the process, and gh always
    runs after that, at the gate and through the CLI.
    *CLI resolution.* `held` in `src/cli/index.ts` calls `assertMainCheckout` on a resolved
    project's repo before any command reads it, and closes the store when that refuses. It
    covers every path a command takes to one project's repo: the shared resolver
    `project()`, and the repo around cwd that `pup status` and `pup ui` read without it.
    `pup ui` hands that repo to the keys that write through it. A gitfile, a symlink or a
    commondir there refuses the command, `pup init` included, and the path is then held for
    every later spawn in that process. The fleet views, `pup status --all` and
    `pup ui --all`, run git in each project they read, so `heldFleet` holds each of those
    first: every project whose repo exists, is its own path, and is awake or shown with
    `--dormant`. One that refuses stops the view, as it stops a command run in that repo.
    `fatalExitCode` prints a `RewrittenGitDirError` as one line and exits 1, as it does for
    `ProjectResolutionError`. `pup project list|dormant|wake` reads no git, so it is left
    alone.
    *The identity.* It now holds the device and inode of `.git`, `objects/` and `refs/`: a
    directory swapped in has others while the one pup saw still exists, and no git
    operation changes either. The birth time is left out: where `statx` fails (a seccomp
    filter, an old kernel, some network filesystems) Node fills it with the ctime, which
    git's own writes in `.git` change, so pup would refuse a repo after its own
    `update-ref` or an operator's commit. `HEAD` and
    `packed-refs` are left out because git replaces both by rename on every ref update, so
    their inodes change with no session involved. Writes there by a gate stage are already
    denied: the gate profile denies `file-write*` (unlink and rename included) on every
    `/.git` path under a checkout it grants. `assertMainCheckout` takes the identity before
    its checks and again after they pass, and holds it only when the two agree. So a decoy
    that fails the checks is never the one held, and neither is a directory swapped in
    while they ran.
    *The env and the argv.* The scrubbed env, which `runGit`, `runGitBytes` and gh (through
    `pinnedGitEnv`) all start from, keeps only the `GIT_*` variables in an allowlist: the
    operator's config locations (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`,
    `GIT_CONFIG_NOSYSTEM`), commit identity (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`), and how a
    fetch or push reaches the remote (`GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT`,
    `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT`, `GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`). It replaces
    a denylist that the re-review of 751cf8dd showed still passed `GIT_SHALLOW_FILE`
    (rewrites parents), `GIT_NAMESPACE` (the refs read), `GIT_REPLACE_REF_BASE`,
    `GIT_EXEC_PATH` (git's subcommands from a session's directory) and `GIT_ATTR_SOURCE`.
    pup's environment is a session's when pup runs inside one, and an allowlist also drops
    any variable a later git adds. What pup sets on purpose is the call site's `opts.env`,
    laid over the scrubbed env, as the gate's quarantined write sets `GIT_OBJECT_DIRECTORY`.
    `safeArgv`'s env is a required argument, and both spawns pass it their spawn's env, so
    no spawn skips the pinned-`GIT_DIR` rule.
    *What remains.* The identity is still the one the first `assertMainCheckout` in a
    process saw. Now that the CLI holds the checkout at resolution, that is the first thing
    a process does, but a `.git` swapped before a gate process starts is still recorded as
    the real one. Likewise, inside a repo, a gitfile shaped like a worktree's, naming
    `<x>/.git/worktrees/<n>` of a decoy checkout `<x>`, resolves the command to `<x>`,
    which passes as a main checkout of its own. Recording the identity on the project row at
    `pup init`, and refusing when it is
    missing or differs, needs the schema in `db.client.ts`, `init.service.ts`, and seeding
    in every gate, land, fix-round and conductor test. That was outside this task's scope,
    and is a follow-up task, together with asserting `error.cause` or the lost-lock warning
    in `merge-gate.test.ts`'s mid-gate decoy-directory case. The check after a read does
    not see a swap put back before it runs. Only killing the gate stages' process group
    before any later main-repo read closes that window, which needs `sandbox.utils.ts`.
    *Tests.* In `git-diff-client.test.ts`:
    - A git read during which `.git` becomes a symlink, or gains a commondir, is refused.
      A git alias run by git itself stands in for the leftover process.
    - A read the swap made fail throws the `RewrittenGitDirError`, not git's error.
    - A `refs/` swapped for another is refused.
    - A first check that refused holds no identity.
    - An inherited `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY` or
      `GIT_ALTERNATE_OBJECT_DIRECTORIES` does not change what `runGit` reads.
    - An inherited `GIT_SHALLOW_FILE` does not change the parents `runGit` reads, and
      neither it nor `GIT_NAMESPACE` reaches the git it spawns. `GIT_CONFIG_GLOBAL` and
      `GIT_AUTHOR_NAME` still do.
    In `github-client.test.ts`, gh is refused before it runs on a planted commondir, a
    gitfile or a symlink, and its answer is refused when `.git` became a symlink while it
    ran. gh is spawned with neither `GIT_SHALLOW_FILE` nor `GIT_NAMESPACE`. In `index.test.ts`, `--project <id> status` on a registered repo whose `.git`
    became a gitfile or a symlink throws the refusal, which `fatalExitCode` prints and exits
    1 on. So does `pup status` or `pup ui` run inside a repo whose `.git` became a
    gitfile, and `pup status --all` or `pup ui --all` over a registered one. An untouched
    checkout runs.
