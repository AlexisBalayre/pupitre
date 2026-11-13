# 0184. `pup merge --pr` sets a `pup-gate` status on the sha it pinned, and branch protection requires it (2026-11-13)

- Status: accepted
- Amends: [0026](0026-pup-merge-pr-same-gate-pull-request-instead.md)
- Amends: [0086](0086-pup-merge-session-pr-re-gates-a-merged.md)

184. **`pup merge --pr` sets a `pup-gate` status on the sha it pinned, and branch protection requires it (2026-11-13).**
    *The gap.* A PR's description vouches for the sha the gate pinned (decision 82), and `pup land`
    refuses a PR GitHub merged at any other head (decision 84). Both come too late: GitHub's merge
    button reads neither. #278 and #283 were merged at heads pushed after their gate, and only
    `pup land` noticed.
    *The status.* Once `pup merge --pr` has opened or adopted the PR and read its head back as the
    pinned sha, it sets a commit status on that sha through the operator's `gh` (decision 12):
    context `pup-gate`, state `success`, and a description naming the session and the time of the
    run. A re-gate (decisions 86, 90) sets it again, on the head it pinned. A status belongs to a
    commit, not to the PR, so any later push moves the head to a sha without one. When gh fails to
    set it, the run fails before the session moves, and the retry of decision 27 sets it.
    *The protection.* As a required status check on the target branch, `pup-gate` keeps the merge
    button disabled until `pup merge --pr` has gated the PR's head. The operator sets this up once
    per repo; pup does not, because it is a repo-wide setting and no session's change. For a target
    with no protection yet (the `PUT` replaces any protection the branch already has):

    ```sh
    gh api --method PUT repos/OWNER/REPO/branches/main/protection --input - <<'JSON'
    {
      "required_status_checks": { "strict": false, "contexts": ["pup-gate"] },
      "enforce_admins": true,
      "required_pull_request_reviews": null,
      "restrictions": null
    }
    JSON
    ```

    For a target that already requires status checks, add `pup-gate` to them:

    ```sh
    gh api --method POST repos/OWNER/REPO/branches/main/protection/required_status_checks/contexts \
      -f 'contexts[]=pup-gate'
    ```

    Check it with `gh api repos/OWNER/REPO/branches/main/protection/required_status_checks --jq
    .contexts`. On GitHub Enterprise, add `--hostname HOST` to each command. `enforce_admins` is
    on because the operator usually administers the repo, and GitHub offers an admin a bypass
    otherwise. `strict` is off: the gate already brings the branch onto the target (decision 105).
    Strict mode would also make every move of the target a push to the PR, and each push needs a
    re-gate. The check also holds every PR that pup did not open. That is intended: no PR merges
    without the gate.
    *Limits, accepted.* Anyone who can write to the repo can set a status, including a session
    that holds the operator's gh login. So `pup-gate` stops an honest push made after the gate from
    being merged. It does not stop a session that forges the status. `pup land`, which reads the
    pin from the store, remains the check for that case. On a private repo, branch protection needs
    a paid GitHub plan. Without it, the status is only informational.
