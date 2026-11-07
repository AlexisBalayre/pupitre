# 0136. The PR title is a commit subject a squash merge can land as is (2026-11-07)

- Status: accepted
- Amends: [0026](0026-pup-merge-pr-same-gate-pull-request-instead.md)

136. **The PR title is a commit subject a squash merge can land as is (2026-11-07).**
    Amends decision 26, whose mechanical title was the task goal's first line, cut at 72
    characters with an ellipsis. The operator squash-merges on GitHub, and with the repo's "commit
    or PR title" setting a multi-commit PR's title becomes the subject of the one commit main
    gets, so main collected subjects cut mid-word (`… whose content is exactly w… (#222)`).
    The gate now titles the PR with the session's first non-merge commit subject, oldest first,
    when it is 72 characters or fewer: the worker wrote it as a commit subject, and on a
    one-commit PR it is the subject GitHub would use anyway. Merge commits are skipped by
    parentage (`git log --no-merges`), not by their message, so neither the `Merge main into …`
    commit the gate writes on a stale PR branch (decision 105) nor a merge the session ran is
    ever the title. When no commit subject fits, the goal's first line is the title, and one over
    72 characters is cut at the last whitespace that leaves 72 or fewer, with no ellipsis and no
    trailing separator (`,;:` or a dash), never mid-word. A first line with no such whitespace and
    an empty goal both fall back to `pup session <id>`, as before. Re-gating an adopted PR
    (decision 86) rewrites the title by the same rule, so a fix round's commits do not change it
    unless the first commit changed. The body is unchanged and still lists every commit subject.
    Tests: a one-commit session's PR is titled with its subject; a subject over 72 characters
    falls back to the goal; a goal over 72 characters is cut at a word boundary; a gate-written
    merge commit is not chosen; a re-gate rewrites the title by the rule.
