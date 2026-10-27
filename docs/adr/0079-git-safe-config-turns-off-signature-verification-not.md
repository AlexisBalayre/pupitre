# 0079. `GIT_SAFE_CONFIG` turns off signature verification, not only signing, and `-z` listings are no longer trimmed (2026-10-06)

- Status: accepted

79. **`GIT_SAFE_CONFIG` turns off signature verification, not only signing, and `-z` listings
    are no longer trimmed (2026-10-06).** Both from the security review of decision 73's PR.
    *Verification runs `gpg.program` too.* Decision 41 cleared `commit.gpgsign` and
    `tag.gpgsign` because the gate's rebase would sign with whatever program a session named,
    but git also runs that program to check a signature, on any commit whose object carries a
    `gpgsig` header, and the header is just text a session can write with `git hash-object`.
    With `gpg.program`, `log.showSignature=true` and `merge.verifySignatures=true` set in the
    shared `$GIT_COMMON_DIR/config`, the gate's `git log` (`commitSubjects` in
    `merge-gate.service.ts`, and the code map's) and `git merge --ff-only` ran it in the main
    checkout, outside the sandbox; reproduced on Apple Git 2.39.5. `merge.verifySignatures`
    runs it and then refuses the unsigned-by-a-real-key commit, so the merge failing is no
    comfort. `GIT_SAFE_CONFIG` now adds `-c log.showSignature=false -c
    merge.verifySignatures=false`, which turns both checks off rather than defanging the
    program, for the same reason as the sign flags: `gpg.program` has no safe empty value.
    A third path, found on review: `rebase.instructionFormat` formats every commit the gate's
    rebase replays, and a `%G?` in it verifies each one; pinned to `%s`, a literal git never
    resolves through a `pretty.*` alias. The test forges a signed commit in a temp repo, shows a
    plain `log`, `merge --ff-only` and `rebase` each fire the planted program, and shows `runGit`
    fires none. A fourth, also from review: `branch.<name>.mergeOptions` is read after `-c` and
    before argv and takes any merge option, so a planted `--verify-signatures` beats the
    verification pin, `-S` beats the sign pin, and `-s ours` or `--squash` turns `--ff-only`
    into a merge that records the session as merged without moving the target. The gate's
    merge blanks the key with its own `-c` (last-wins, and `-c` is read last), which only it
    can do because the branch name is only known there, and passes `--no-verify-signatures`
    besides; the gate test plants `-s ours -S` and asserts a clean fast-forward. Three more edges
    from the same review: the blank is keyed on the branch name read before the lock, and a
    session alive during the stages can move the main checkout's HEAD, so the gate re-reads the
    checked-out branch under the lock and refuses if it changed, and after the merge it checks
    that `refs/heads/<target>` is at the session's tip before recording `merged`, so a merge
    that ran and was not the fast-forward asked for (a moved HEAD, `-s ours`, `pull.twohead`,
    `--squash`) is never recorded as one — it keeps the session's state honest, not the target,
    which has moved by then. A target name with `=` is refused, because git splits a `-c` at the
    first `=` and the blank would land on another key. `pull.twohead` is pinned to `ort` (git
    2.33 or later) since it is the strategy git takes when argv names none. An operator who
    relies on `merge.verifySignatures` to reject unsigned branches loses that check inside
    `pup merge`; the gate is the check pup applies, and a branch rule on the remote is the place
    for a signature requirement.
    *Accepted here, closed by decision 80, which pins the branch and fast-forwards with
    plumbing:* the re-read and the merge are two spawns, so a
    session that flips the main checkout's HEAD between them, or names a tag like its branch,
    or commits after the stages ran, still reaches porcelain `git merge` with its own branch
    config, and the ref check only fires after the target has moved. The structural answer —
    a plumbing fast-forward (`merge-base --is-ancestor`, `read-tree -m -u`, `update-ref` with
    the old value) against a branch sha pinned once after fresh-base, names qualified as
    `refs/heads/`, the driver check re-run under the lock — changes what "the branch" means to
    the gate and gets its own task rather than a fifth review round on this one.
    *The `-z` trim.* Decision 73 made `runGit` return its output untrimmed so a `-z` listing
    whose first path starts with a space would reach its parser whole, but `gitDiffPaths` and
    `gitDiffNumstat` still called `.trim()` before splitting on NUL, so a branch adding
    ` a.ts` was audited as `a.ts` and its hunks were asked of a path that does not exist,
    which patch coverage read as no changed lines. Both now split the raw output; the NUL
    terminator leaves one empty tail that the existing empty-field filters already drop. A
    test adds ` a.ts` on a branch and expects it whole from both listings and its two lines
    from `gitDiffAddedLines`.
