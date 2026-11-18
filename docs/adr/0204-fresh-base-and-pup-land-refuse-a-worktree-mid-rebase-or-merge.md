# 0204. Fresh-base and `pup land` refuse a worktree mid-rebase or mid-merge (2026-11-18)

- Status: accepted
- Amends: [0008](0008-fresh-base-gating.md)
- Amends: [0084](0084-pup-land-session-closes-the-github-half-of.md)
- Amends: [0120](0120-fresh-base-regenerates-a-conflicted-adr-index-in-the.md)

204. **Fresh-base and `pup land` refuse a worktree mid-rebase or mid-merge (2026-11-18).**
    A linked worktree keeps its operation state in its admin dir, `.git/worktrees/<id>/`: the
    `rebase-merge/` and `rebase-apply/` dirs, `REBASE_HEAD`, `MERGE_HEAD` and `sequencer/`.
    The session can write all of it (decision 101), and it may be left over from a rebase the
    worker never finished or a gate whose abort failed (decision 190). Git acts on it.
    *Probe.* On Git 2.54 (Apple Git-157), on 2026-11-18: in a worktree whose branch is
    `feat`, a planted `rebase-merge/` holding `head-name` = `refs/heads/main` and `orig-head`
    and `onto` = an older commit makes `git rebase main` refuse ("already a rebase-merge
    directory"). The `git rebase --abort` the gate then runs moves `refs/heads/main` back to
    that commit and checks `main` out in the worktree. A `MERGE_HEAD` the gate leaves in place
    would make the worker's next `git commit` a merge with whatever parent it names.
    *Check.* `inProgressGitState` (merge-gate.service.ts) names the first of those entries in
    the admin dir. Any entry counts, a symlink or a file where git keeps a dir included. It
    runs:
    - at the top of the gate's fresh-base stage, before any git runs in the worktree, on the
      rebase and the merge paths and when the branch is already based. The stage fails,
      naming the file, and tells the worker to finish or abort the operation, or to delete the
      file if none is in progress;
    - in `landUnderLock`, after the already-landed check and before the fetch, so the refusal
      moves no ref and the teardown runs no git under that state. The operator reads the
      message, with "Nothing was landed.", and it tells them only to delete the entry without
      running git in that worktree. Their git runs outside the worker sandbox (decision 191),
      so an abort there would move whatever ref the planted `head-name` names, `main` included,
      to the planted `orig-head`, and a `--continue` would run a planted todo's `exec` lines.
      The gate's message goes to the worker, whose own abort or continue gains it no rights it
      lacks, so it still offers them.
      A worktree that is already gone has no admin dir and passes.
    `CHERRY_PICK_HEAD`, `REVERT_HEAD` and `BISECT_*` are not checked: neither the rebase, its
    abort, the plumbing merge nor the teardown reads them.
    *Window left.* The live session can still plant the state between the check and the
    gate's `git rebase` (decision 80), as decision 120 found for a check before `--continue`.
    The check covers leftover state and anything planted before the gate starts. Closing the
    window means replacing `rebase --abort` with a restore from pins the gate holds, which is
    not done here.
    *Tests.* `merge-gate-in-progress.test.ts` plants each entry, with main moved so a rebase
    is due, and shows fresh-base fail naming it while the branch and main stay put.
    `land-refusals.test.ts` plants each entry under a PR GitHub merged and shows the land
    refuse naming it, changing nothing.
