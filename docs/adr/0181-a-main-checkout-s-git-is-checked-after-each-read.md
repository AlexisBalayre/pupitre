# 0181. A main checkout's .git is checked after each read, at gh and at CLI resolution (2026-11-13)

- Status: accepted
- Amends: [0172](0172-git-refuses-a-main-checkout-s-git-a-session-rewrote.md)

181. **A main checkout's .git is checked after each read, at gh and at CLI resolution (2026-11-13).**
    Amends decision 172 and closes part of its *What remains*. The review of the decision 172
    fix, at b4e3aa87, rated as HIGH the identity being recorded on first use. It also found
    (finding 3) that the lstats run before git reads `.git`. In that window a process left
    behind by a session-controlled gate stage can swap `.git` for a symlink or a gitfile, or
    plant a commondir, and git follows them under `--git-dir`.
    *Checked after the read.* `runGit` and the byte read in `blobIsBinary` run
    `assertGitDirUnplanted` again once git ends (`checkedAfter`), whether git succeeded or
    failed. A refusal then outranks git's own failure, so a catch that reads a failed git as
    "no such ref" sees the `RewrittenGitDirError` instead. Decision 172's source test still
    holds: each spawn's argv is built by `safeArgv`, inline.
    *gh.* `github.client.ts` checks the main checkout before and after each gh spawn
    (`ghInCheckout`), as `runGit` does. gh runs git there with no `--git-dir` of pup's, so a
    planted commondir or a symlinked `.git` is refused before gh starts. A gitfile is
    refused at a checkout `assertMainCheckout` has passed in the process, and gh always
    runs after that, at the gate and through the CLI.
    *CLI resolution.* The CLI's one project resolver, `project()` in `src/cli/index.ts`,
    calls `assertMainCheckout` on the repo it resolves before any command reads it, so a
    gitfile, a symlink or a commondir there refuses every command, `pup init` included. The
    path is then held for every later spawn in that process. `fatalExitCode` prints a
    `RewrittenGitDirError` as one line and exits 1, as it does for `ProjectResolutionError`.
    `pup project dormant|wake` resolves on its own and reads no git, so it is left alone.
    *The identity.* It now holds the device, inode and birth time of `.git`, `objects/` and
    `refs/`. The birth time tells a reused inode from the one pup saw. `HEAD` and
    `packed-refs` are left out because git replaces both by rename on every ref update, so
    their inodes change with no session involved. Writes there by a gate stage are already
    denied: the gate profile denies `file-write*` (unlink and rename included) on every
    `/.git` path under a checkout it grants. `assertMainCheckout` records the identity only
    after its checks pass, so a decoy that fails them is never the one held.
    *The env and the argv.* The scrubbed env drops `GIT_OBJECT_DIRECTORY` and
    `GIT_ALTERNATE_OBJECT_DIRECTORIES` beside `GIT_DIR` and `GIT_COMMON_DIR`, so no
    inherited variable points git at an object store no check looked at. A caller still
    sets them through `opts.env`, as the gate's quarantined write does. `safeArgv`'s env is
    a required argument, and `blobIsBinary` passes its spawn's env, so no spawn skips the
    pinned-`GIT_DIR` rule.
    *What remains.* The identity is still the one the first `assertMainCheckout` in a
    process saw. Now that the CLI holds the checkout at resolution, that is the first thing
    a process does, but a `.git` swapped before a gate process starts is still recorded as
    the real one. Recording it on the project row at `pup init`, and refusing when it is
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
    In `github-client.test.ts`, gh is refused before it runs on a planted commondir, a
    gitfile or a symlink, and its answer is refused when `.git` became a symlink while it
    ran. In `index.test.ts`, `--project <id> status` on a registered repo whose `.git`
    became a gitfile or a symlink throws the refusal, which `fatalExitCode` prints and exits
    1 on. An untouched checkout runs.
