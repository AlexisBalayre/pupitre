# 0175. GitHub's merge queue runs the full suite and reverts a break; pup land only closes out the task (2026-11-11)

- Status: accepted
- Amends: [0084](0084-pup-land-session-closes-the-github-half-of.md)
- Amends: [0086](0086-pup-merge-session-pr-re-gates-a-merged.md)
- Amends: [0095](0095-the-gate-pup-audit-and-pup-land-run.md)
- Amends: [0131](0131-pup-land-takes-a-squash-or-rebase-merge-whose-tree.md)
- Amends: [0138](0138-a-test-stage-that-times-out-under-load-refuses.md)
- Amends: [0164](0164-pup-land-takes-a-moved-head-on-the-operator-s-word.md)

175. **GitHub's merge queue runs the full suite and reverts a break; pup land only closes out the task (2026-11-11).**
    *The queue.* Merges go through GitHub's native merge queue. A required check runs the full
    test suite on the queued base, so a PR is tested against what main will be rather than what
    it was when it opened. The pup-gate status is a required check on the same rule.
    *The hook.* It keeps what decision 135 gives it: lint and the tests related to the staged
    files. The full suite runs in the queue, so the gate's test stage, which decision 138 bounds
    at 25 minutes and refuses on a timeout, no longer has to carry it.
    *A broken main.* A workflow reverts the merge commit through a revert PR, reopens the slice's
    ticket with the failing output, and blocks the slices that depend on it. The operator is
    notified and is not asked.
    *`pup land`.* It no longer merges, re-tests or refuses a moved head, so the head pin of
    decisions 84, 86, 131 and 164, the baseline measurement of decision 95 and `--accept-head`
    go away. It closes out the task record once GitHub has merged the PR.
    *When it applies.* After the rollout setting of decision 178 is on for the project. Until then
    the decisions above govern `pup land` unchanged.
    *Why.* `pup land` refused a PR merged at a moved head five times in a few days (#283, #278,
    #284, #286, #296). The queue owns the merge and the re-test, and pup owns only what GitHub
    cannot know: the task record and the ticket link.
