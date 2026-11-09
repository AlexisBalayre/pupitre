# 0161. The gate refuses a shared-config core.worktree and reads every listing from the root (2026-11-09)

- Status: accepted
- Amends: [0073](0073-git-has-one-entry-point-rungit-in-git.md)

161. **The gate refuses a shared-config `core.worktree` and reads every listing from the root (2026-11-09).**
    A session can write the main checkout's `.git/config`, and no diff shows it. With
    `core.worktree` aimed at a parent of the checkout, every git the gate runs there runs from
    the subdirectory `<name>/`. A plain `ls-tree`, a pathspec or a `git grep` then reads that
    prefix alone, and `diff.relative` empties every diff. The scope audit, diff-size,
    duplication, complexity and coverage would each measure an empty branch and pass.
    *No pin reaches the key.* Git reads `core.worktree` from `$GIT_DIR/config` alone while it
    finds the repository, before any `-c` applies. It takes the key from no include, no global
    config and no `GIT_CONFIG_*`, and `-c core.worktree=` leaves it in force (verified on Git
    2.54). So `GIT_SAFE_CONFIG` gets no entry for it, since one would read as protection and
    give none.
    *Refused.* `planMerge` calls `assertNoSharedWorktreeKey` before any git runs in the main
    checkout: an empty value stops every git in the repo, the driver check's included. It then
    calls `assertNoWorktreeConfig`, since per-worktree config can carry the key and a live
    session can turn it on after its launch was asked. `cutGateCheckout` asks about the key
    again under the lock, right before the stage listings, as it does for the drivers. The key
    is read with `git -C / config --file <repo>/.git/config`, so an empty value cannot stop
    the read. Any failure other than "no such key" refuses too. After the last stage the gate
    asks once more, right before the fast-forward or the PR push, so a key a session set while
    the stages ran is refused, not merged.
    *Narrower than before.* `assertNoWorktreeConfig` already ran before the session's own
    commit check; at `planMerge` it now stops a gate in a main checkout with
    `extensions.worktreeConfig` on (as `git sparse-checkout` turns on) or whose `.git` is a
    gitfile (a `--separate-git-dir` checkout or a submodule). The gate refuses both now, where it
    ran before; the error names the fix.
    *Anchored.* A live session can still set the key after the last check, so each listing a
    stage reads is anchored at the root:
    - `diff.relative=false` in `GIT_SAFE_CONFIG`;
    - `--no-relative` on every gate diff (`DIFF_SAFE_FLAGS`, `rawDiffEntries`), each it and the
      pin tested without the other;
    - `:(top,literal)` for a file's hunks, where a plain path under `--literal-pathspecs`
      found none, so patch coverage read "no instrumentable changed lines";
    - `:(top,glob,icase)` for the Docusaurus grep, and `:(top)` with `--full-name` for the
      grep of a test file's importers;
    - `--full-tree` on `readBranchTree`'s `ls-tree`, and on the target-tree listing the
      complexity stage reads (decision 157), whose test now sets the key after the checks;
    - `--full-tree` on the nested-package `ls-tree` in `src/adapters/git-tree.client.ts`,
      which reads the trusted checkout at the measured sha and at `HEAD`.
    *Renames.* `gitDiffPaths` passes `--no-renames`: under rename detection `--name-only` lists
    a rename's new path alone, so a file moved from outside scope-in into it passed the audit.
    *`GIT_GRAFT_FILE`* stays `/dev/null/no-grafts`, laid over every `runGit` caller's env
    (decision 89). `/dev/null` itself opens as an empty file, and git prints its graft
    deprecation hint on every call.
    *Open gap.* `ls-files` in `overlap.service.ts` (the conflict radar) and
    `profile-compiler.service.ts` (the launch profile) run unanchored in the main checkout.
    Neither is a gate stage; a follow-up anchors them. The ADR-number stage (decision 146)
    anchors its own reads.
