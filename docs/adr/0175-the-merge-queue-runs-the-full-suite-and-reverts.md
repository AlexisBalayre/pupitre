# 0175. GitHub's merge queue runs the full suite and reverts a break; pup land only closes out the task (2026-11-11)

- Status: accepted
- Amends: [0138](0138-a-test-stage-that-times-out-under-load-refuses.md)

175. **GitHub's merge queue runs the full suite and reverts a break; pup land only closes out the task (2026-11-11).**
    *The queue.* Merges go through GitHub's native merge queue. A required check runs the full
    test suite on the queued base, so a PR is tested against what main will be rather than what
    it was when it opened. The pup-gate status is a required check on the same rule.
    *The hook.* The pre-commit hook runs lint, typecheck and the tests of changed files. The full
    suite no longer runs per commit, which is the run that times out under load (decision 138).
    *A broken main.* A workflow reverts the merge commit through a revert PR, reopens the slice's
    ticket with the failing output, and blocks the slices that depend on it. The operator is
    notified and is not asked.
    *`pup land`.* It no longer merges, re-tests or refuses a moved head. It closes out the task
    record once GitHub has merged the PR.
    *Why.* `pup land` refused a PR merged at a moved head five times in a few days (#283, #278,
    #284, #286, #296). The queue owns the merge and the re-test, and pup owns only what GitHub
    cannot know: the task record and the ticket link.
