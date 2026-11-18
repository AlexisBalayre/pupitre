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
      naming the file. It tells the session itself to finish or abort the operation, or to
      delete the file if none is in progress, and anyone else to delete it without running
      git in that worktree;
    - in `landUnderLock`, after the already-landed check and before the fetch, so the refusal
      moves no ref and the teardown runs no git under that state. The operator reads the
      message, with "Nothing was landed.", and it tells them only to delete the entry without
      running git in that worktree. Their git runs outside the worker sandbox (decision 191),
      so an abort there would move whatever ref the planted `head-name` names, `main` included,
      to the planted `orig-head`, and a `--continue` would run a planted todo's `exec` lines.
      The gate's message is steered to the worker, whose own abort or continue gains it no
      rights it lacks, so it offers them to the session. `pup merge` and `pup review` print
      the same report to the operator or conductor, and a session blocked at the reject cap
      hands it to a human, all unsandboxed, so it tells anyone but the session to delete only.
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

## Amendment (2026-11-18, #393)

A follow-up to #389. The fresh-base detail for a rebase whose abort also failed told every
reader to run `git rebase --abort` in the session worktree, then merge the target. That report
reaches the same unsandboxed readers as the in-progress refusal above: `pup merge` and `pup
review` print it, and a session blocked at the reject cap hands it to a human. An abort they ran
over rebase state the live session can write (decision 120) moves any branch, `main` included,
as the probe shows.

- *The message.* It now names what the failed abort left: the first in-progress entry
  `inProgressGitState` finds in the admin dir, or, when it finds none, that no rebase state is
  left but HEAD may not be on the session's branch. As with the in-progress refusal, the session
  itself may finish or abort any rebase still in progress, check out its branch, merge the
  target and commit the merge. Anyone else should inspect that state without running git in that
  worktree, or delete it.
- *The other messages.* No other gate or land message named an abort command: the in-progress
  refusals of the gate and of `pup land` already offered only deletion to anyone but the session.
- *Tests.* `merge-gate-fresh-base.test.ts` fails the abort of a conflicting rebase and shows the
  detail naming the `rebase-merge` dir left behind, steering anyone else away from git there and
  naming no `rebase --abort`. `merge-gate-in-progress.test.ts` reads `merge-gate.service.ts` and
  `land.service.ts`, with adjacent string literals joined so a command split across a `+` still
  shows, and holds that neither names `git rebase --abort`, `git merge --abort` or
  `git cherry-pick --abort`.
